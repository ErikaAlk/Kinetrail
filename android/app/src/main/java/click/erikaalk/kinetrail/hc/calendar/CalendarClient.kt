// 拉取日历数据：GET /app/calendar；物理删除一次称重：POST /app/measurements/delete。鉴权用的是同一个推送令牌。
// 不打印令牌、日期以外的内容与体测数值。

package click.erikaalk.kinetrail.hc.calendar

import click.erikaalk.kinetrail.hc.BuildConfig
import click.erikaalk.kinetrail.hc.KINETRAIL_ORIGIN
import click.erikaalk.kinetrail.hc.PushException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId

private const val ENDPOINT = "$KINETRAIL_ORIGIN/app/calendar"
private const val DELETE_ENDPOINT = "$KINETRAIL_ORIGIN/app/measurements/delete"

/** 物理删除一次称重。服务端删完才返回；失败抛 [PushException]，消息直接给界面看。 */
suspend fun postDeleteMeasurement(token: String, recordId: String): Unit = withContext(Dispatchers.IO) {
    val connection = URL(DELETE_ENDPOINT).openConnection() as HttpURLConnection
    try {
        connection.requestMethod = "POST"
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.doOutput = true
        connection.setRequestProperty("authorization", "Bearer $token")
        connection.setRequestProperty("content-type", "application/json")
        connection.setRequestProperty("user-agent", "KinetrailHc/${BuildConfig.VERSION_NAME}")
        connection.outputStream.use { it.write(JSONObject().put("record_id", recordId).toString().toByteArray()) }
        val status = connection.responseCode
        if (status == 200) return@withContext
        val code = runCatching {
            JSONObject(connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()).optString("error")
        }.getOrNull().orEmpty()
        throw PushException(
            when {
                status == 401 -> "令牌无效，请重新保存令牌"
                status == 404 && code == "not_found" -> "Kinetrail 里已经没有这次称重了"
                status == 404 -> "服务端还没有删除接口，先部署新版 Worker 再试"
                status == 409 -> "这次称重来自早期的 FitDays 同步，不能在手机上删除"
                status == 429 -> "删除得太频繁（429），稍后再试"
                status == 503 -> "服务端正在写入别的数据，稍后再试"
                else -> "删除失败：HTTP $status"
            },
        )
    } finally {
        connection.disconnect()
    }
}

/**
 * 取一个月（含首尾整月）的训练与体测，返回服务端原文和解析结果；原文给调用方原样存进本机缓存。
 * 失败抛 [PushException]，消息直接给界面看。
 */
suspend fun fetchCalendar(token: String, month: YearMonth, zone: ZoneId = ZoneId.systemDefault()): Pair<String, CalendarRange> =
    fetchCalendar(token, month.atDay(1), month.atEndOfMonth(), zone)

suspend fun fetchCalendar(token: String, from: LocalDate, to: LocalDate, zone: ZoneId): Pair<String, CalendarRange> =
    withContext(Dispatchers.IO) {
        val url = URL("$ENDPOINT?from=$from&to=$to&tz=$zone")
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("authorization", "Bearer $token")
            connection.setRequestProperty("accept", "application/json")
            connection.setRequestProperty("user-agent", "KinetrailHc/${BuildConfig.VERSION_NAME}")
            val status = connection.responseCode
            val text = (if (status < 400) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status != 200) {
                throw PushException(
                    when (status) {
                        401 -> "令牌无效，请重新保存令牌"
                        404 -> "服务端还没有日历接口，先部署新版 Worker 再试"
                        400 -> "服务端拒绝了查询范围（400）"
                        429 -> "请求过于频繁（429），稍后再试"
                        else -> "读取失败：HTTP $status"
                    },
                )
            }
            text to parseCalendar(text)
        } finally {
            connection.disconnect()
        }
    }
