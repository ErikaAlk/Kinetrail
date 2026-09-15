// 读取 FitDays+ 写入 HC 的体测并推送到 Kinetrail（请求格式见 research/HEALTHCONNECT.md 3.3 与 src/ingest.ts）。
// 首次：先取 changes token 再读最近 30 天；之后：按 token 取变更，对每个变更时刻重读整组，删除只带 id。
// 全部请求返回 200 后才保存新 token；中途失败下次从旧 token 重来，服务端按内容去重。

package click.erikaalk.kinetrail.hc

import android.content.SharedPreferences
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.reflect.KClass

const val FITDAYS_PLUS = "cn.icomon.fitdayspro"
private const val ENDPOINT = "https://kinetrail.erikaalk.click/ingest/health-connect"
private const val TOKEN_KEY = "changes_token"
// 服务端请求体上限 64 KiB；按序列化后的字节分块，留出余量。
private const val MAX_REQUEST_BYTES = 48 * 1024
private const val DELETIONS_PER_REQUEST = 500

val TYPES: List<KClass<out Record>> = listOf(
    WeightRecord::class,
    BodyFatRecord::class,
    BodyWaterMassRecord::class,
    BoneMassRecord::class,
    BasalMetabolicRateRecord::class,
    LeanBodyMassRecord::class,
    HeartRateRecord::class,
)

class PushException(message: String) : Exception(message)

class HealthSync(
    private val client: HealthConnectClient,
    private val prefs: SharedPreferences,
    private val ingestToken: String,
) {
    private val origin = setOf(DataOrigin(FITDAYS_PLUS))
    private val totals = mutableMapOf("accepted" to 0, "unchanged" to 0, "rejected" to 0, "deletions_matched" to 0)
    private val rejectCodes = sortedSetOf<String>()

    /** 返回给界面的一行结果；失败抛 [PushException]，token 不前进。 */
    suspend fun run(): String {
        val saved = prefs.getString(TOKEN_KEY, null)
        val fromChanges = saved?.let { changes(it) }
        val (groups, deletions, nextToken) = fromChanges ?: initial()
        push(groups, deletions)
        // 冲突说明同一时刻的已存值与手机不一致；FitDays+ 不会改写 HC 记录，正常数据不会出现。
        // 不推进 token，数据留在 HC 里；冲突来自库里已有的组，轮换令牌只能阻止继续写入，清理要按运维手册处理。
        if ("HC_GROUP_CONFLICT" in rejectCodes) {
            throw PushException("服务端报告同一时刻的数据冲突（HC_GROUP_CONFLICT），同步进度已暂停。可能有人用泄漏的令牌写入了数据：先轮换令牌，再按运维手册第 9 节清理后重新同步")
        }
        prefs.edit().putString(TOKEN_KEY, nextToken).apply()
        val rejected = if (rejectCodes.isEmpty()) "" else "（${rejectCodes.joinToString("、")}）"
        // token 过期后只能重读现存记录，拿不到过期期间在 Health Connect 里做的删除。
        val expired = if (saved != null && fromChanges == null) "。同步基线已过期，期间在 Health Connect 删除的记录没有同步，请在 Kinetrail 里核对" else ""
        return "推送 ${groups.size} 次测量、${deletions.size} 条删除：新增或更新 ${totals["accepted"]}，" +
            "未变 ${totals["unchanged"]}，拒绝 ${totals["rejected"]}$rejected，删除命中 ${totals["deletions_matched"]}$expired"
    }

    private data class Batch(val groups: List<JSONObject>, val deletions: List<String>, val token: String)

    private suspend fun initial(): Batch {
        // 先取 token 再读：读取期间新写入的记录下次作为变更拿到，不会漏。
        val token = client.getChangesToken(ChangesTokenRequest(TYPES.toSet(), origin))
        val now = Instant.now()
        val byTime = sortedMapOf<Instant, MutableList<Record>>()
        for (type in TYPES) readAll(type, TimeRangeFilter.between(now.minus(Duration.ofDays(30)), now.plus(Duration.ofDays(1))))
            .forEach { byTime.getOrPut(timeOf(it)) { mutableListOf() }.add(it) }
        return Batch(byTime.map { (time, records) -> groupJson(time, records) }.filterNotNull(), emptyList(), token)
    }

    /** token 过期时返回 null，由调用方改走首次流程。 */
    private suspend fun changes(start: String): Batch? {
        var token = start
        val times = sortedSetOf<Instant>()
        val deletions = linkedSetOf<String>()
        do {
            val response = client.getChanges(token)
            if (response.changesTokenExpired) return null
            for (change in response.changes) {
                when (change) {
                    is UpsertionChange -> times.add(timeOf(change.record))
                    is DeletionChange -> deletions.add(change.recordId)
                }
            }
            token = response.nextChangesToken
        } while (response.hasMore)
        // 对每个变更时刻重读整组，避免同一次称重被分页拆开；已被删掉的记录这时自然读不到。
        // 窗口前后各放宽 1 毫秒再精确筛选：心率是 start=end 的区间记录，严格区间可能漏掉它。
        val groups = times.mapNotNull { time ->
            val range = TimeRangeFilter.between(time.minusMillis(1), time.plusMillis(1))
            groupJson(time, TYPES.flatMap { readAll(it, range) }.filter { timeOf(it) == time })
        }
        return Batch(groups, deletions.toList(), token)
    }

    private suspend fun readAll(type: KClass<out Record>, range: TimeRangeFilter): List<Record> {
        val out = mutableListOf<Record>()
        var pageToken: String? = null
        do {
            @Suppress("UNCHECKED_CAST")
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = type as KClass<Record>,
                    timeRangeFilter = range,
                    dataOriginFilter = origin,
                    pageToken = pageToken,
                ),
            )
            out += response.records
            pageToken = response.pageToken
        } while (pageToken != null)
        return out
    }

    private fun timeOf(record: Record): Instant = when (record) {
        is HeartRateRecord -> record.startTime
        is WeightRecord -> record.time
        is BodyFatRecord -> record.time
        is BodyWaterMassRecord -> record.time
        is BoneMassRecord -> record.time
        is BasalMetabolicRateRecord -> record.time
        is LeanBodyMassRecord -> record.time
        else -> throw IllegalArgumentException("unexpected record type")
    }

    private fun offsetOf(record: Record): ZoneOffset? = when (record) {
        is HeartRateRecord -> record.startZoneOffset
        is WeightRecord -> record.zoneOffset
        is BodyFatRecord -> record.zoneOffset
        is BodyWaterMassRecord -> record.zoneOffset
        is BoneMassRecord -> record.zoneOffset
        is BasalMetabolicRateRecord -> record.zoneOffset
        is LeanBodyMassRecord -> record.zoneOffset
        else -> null
    }

    private fun groupJson(time: Instant, records: List<Record>): JSONObject? {
        val items = records.mapNotNull { record ->
            val (type, value) = when (record) {
                is WeightRecord -> "weight" to record.weight.inKilograms
                is BodyFatRecord -> "body_fat" to record.percentage.value
                is BodyWaterMassRecord -> "body_water_mass" to record.mass.inKilograms
                is BoneMassRecord -> "bone_mass" to record.mass.inKilograms
                is BasalMetabolicRateRecord -> "basal_metabolic_rate" to record.basalMetabolicRate.inKilocaloriesPerDay
                is LeanBodyMassRecord -> "lean_body_mass" to record.mass.inKilograms
                // FitDays+ 每次称重只写一个心率样本；多样本不是它写的，不推送。
                is HeartRateRecord -> if (record.samples.size == 1) "heart_rate" to record.samples[0].beatsPerMinute.toDouble() else return@mapNotNull null
                else -> return@mapNotNull null
            }
            JSONObject()
                .put("hc_id", record.metadata.id)
                .put("type", type)
                .put("value", value)
                .put("last_modified_ms", record.metadata.lastModifiedTime.toEpochMilli())
        }
        if (items.isEmpty()) return null
        return JSONObject()
            .put("origin", FITDAYS_PLUS)
            .put("time_ms", time.toEpochMilli())
            .put("zone_offset_seconds", records.firstNotNullOfOrNull { offsetOf(it) }?.totalSeconds ?: JSONObject.NULL)
            .put("records", JSONArray(items))
    }

    private suspend fun push(groups: List<JSONObject>, deletions: List<String>) {
        var chunk = mutableListOf<JSONObject>()
        var bytes = 0
        for (group in groups) {
            val size = group.toString().toByteArray().size + 1
            if (chunk.isNotEmpty() && bytes + size > MAX_REQUEST_BYTES) {
                send(chunk, emptyList())
                chunk = mutableListOf()
                bytes = 0
            }
            chunk += group
            bytes += size
        }
        if (chunk.isNotEmpty()) send(chunk, emptyList())
        for (ids in deletions.chunked(DELETIONS_PER_REQUEST)) send(emptyList(), ids)
    }

    private suspend fun send(groups: List<JSONObject>, deletions: List<String>) = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("schema_version", "1")
            .put("groups", JSONArray(groups))
            .put("deleted_hc_ids", JSONArray(deletions))
            .toString()
            .toByteArray()
        val connection = URL(ENDPOINT).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.doOutput = true
            connection.setRequestProperty("authorization", "Bearer $ingestToken")
            connection.setRequestProperty("content-type", "application/json")
            connection.setRequestProperty("user-agent", "KinetrailHc/${BuildConfig.VERSION_NAME}")
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val text = (if (status < 400) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status != 200) {
                val code = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
                throw PushException(
                    when (status) {
                        401 -> "令牌无效，请重新保存令牌"
                        503 -> if (code == "not_configured") "服务端配置不完整（not_configured），需要检查 HC_ACCEPT_AFTER 与 HC_PROFILE_REF" else "服务端忙（503 $code），稍后再同步"
                        429 -> "请求过于频繁（429），稍后再同步"
                        else -> "推送失败：HTTP $status $code"
                    },
                )
            }
            val result = JSONObject(text)
            for (key in listOf("accepted", "unchanged", "deletions_matched")) {
                totals[key] = totals.getValue(key) + result.optInt(key)
            }
            val rejected = result.optJSONArray("rejected") ?: JSONArray()
            totals["rejected"] = totals.getValue("rejected") + rejected.length()
            for (i in 0 until rejected.length()) rejectCodes += rejected.getJSONObject(i).optString("code")
        } finally {
            connection.disconnect()
        }
    }
}
