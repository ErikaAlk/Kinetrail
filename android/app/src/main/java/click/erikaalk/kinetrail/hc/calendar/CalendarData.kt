// 日历数据：服务端 GET /app/calendar 的响应模型、解析与展示用的格式化。
// 这里只做纯数据处理，不碰网络和界面，单测直接覆盖（CalendarDataTest）。

package click.erikaalk.kinetrail.hc.calendar

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.YearMonth
import java.util.Locale

data class TrainingSet(
    val loadValue: Double? = null,
    val loadUnit: String? = null,
    val reps: Int? = null,
    val durationSeconds: Int? = null,
    val distanceValue: Double? = null,
    val distanceUnit: String? = null,
)

data class TrainingEntry(
    val name: String,
    val category: String,
    val equipment: String?,
    val sets: List<TrainingSet>,
    val notes: String?,
)

data class TrainingSession(
    val status: String,
    val startedAt: OffsetDateTime?,
    val endedAt: OffsetDateTime?,
    val durationSeconds: Int?,
    val caloriesKcal: Double?,
    val overallRpe: Double?,
    val facility: String?,
    val notes: String?,
    val entries: List<TrainingEntry>,
)

data class BodyMeasurement(val measuredAt: OffsetDateTime?, val metrics: Map<String, Double>)

data class CalendarDay(
    val date: LocalDate,
    val caloriesKcal: Double?,
    val sessions: List<TrainingSession>,
    val measurements: List<BodyMeasurement>,
)

/** 一次请求的结果。[truncated] 为真表示服务端按上限截断了，界面要说出来而不是假装完整。 */
data class CalendarRange(val days: Map<LocalDate, CalendarDay>, val truncated: Boolean)

private fun JSONObject.doubleOrNull(key: String): Double? =
    if (isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }

private fun JSONObject.intOrNull(key: String): Int? = if (isNull(key)) null else optInt(key)

private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }

private fun time(text: String?): OffsetDateTime? =
    text?.let { runCatching { OffsetDateTime.parse(it) }.getOrNull() }

private inline fun <T> JSONArray?.map(transform: (JSONObject) -> T): List<T> {
    if (this == null) return emptyList()
    return (0 until length()).map { transform(getJSONObject(it)) }
}

fun parseCalendar(body: String): CalendarRange {
    val root = JSONObject(body)
    val days = root.optJSONArray("days").map { day ->
        val date = LocalDate.parse(day.getString("date"))
        CalendarDay(
            date = date,
            caloriesKcal = day.doubleOrNull("calories_kcal"),
            sessions = day.optJSONArray("sessions").map { s ->
                TrainingSession(
                    status = s.optString("status", "finalized"),
                    startedAt = time(s.stringOrNull("started_at")),
                    endedAt = time(s.stringOrNull("ended_at")),
                    durationSeconds = s.intOrNull("duration_seconds"),
                    caloriesKcal = s.doubleOrNull("calories_kcal"),
                    overallRpe = s.doubleOrNull("overall_rpe"),
                    facility = s.stringOrNull("facility"),
                    notes = s.stringOrNull("notes"),
                    entries = s.optJSONArray("entries").map { e ->
                        TrainingEntry(
                            name = e.optString("exercise_name_raw"),
                            category = e.optString("category"),
                            equipment = e.stringOrNull("equipment_label"),
                            notes = e.stringOrNull("notes"),
                            sets = e.optJSONArray("sets").map { set ->
                                TrainingSet(
                                    loadValue = set.doubleOrNull("load_value"),
                                    loadUnit = set.stringOrNull("load_unit"),
                                    reps = set.intOrNull("reps"),
                                    durationSeconds = set.intOrNull("duration_seconds"),
                                    distanceValue = set.doubleOrNull("distance_value"),
                                    distanceUnit = set.stringOrNull("distance_unit"),
                                )
                            },
                        )
                    },
                )
            },
            measurements = day.optJSONArray("measurements").map { m ->
                val metrics = m.optJSONObject("metrics")
                BodyMeasurement(
                    measuredAt = time(m.stringOrNull("measured_at")),
                    metrics = metrics?.keys()?.asSequence()
                        ?.mapNotNull { key -> metrics.doubleOrNull(key)?.let { key to it } }
                        ?.toMap()
                        .orEmpty(),
                )
            },
        )
    }
    return CalendarRange(days.associateBy { it.date }, root.optBoolean("truncated"))
}

/** 月视图的格子：周一开头，前后补空位凑满整周。 */
fun monthGrid(month: YearMonth): List<LocalDate?> {
    val first = month.atDay(1)
    val lead = first.dayOfWeek.value - 1
    val cells = MutableList<LocalDate?>(lead) { null }
    for (day in 1..month.lengthOfMonth()) cells.add(month.atDay(day))
    while (cells.size % 7 != 0) cells.add(null)
    return cells
}

/** 去掉多余的零：63.10 → 63.1，420.0 → 420。 */
fun num(value: Double): String {
    // 固定用 Locale.US：小数点必须是「.」，不跟着系统区域变成逗号。
    val text = String.format(Locale.US, "%.2f", value)
    return text.trimEnd('0').trimEnd('.').ifEmpty { "0" }
}

/** 日期格下面的小字：热量取整，不显示小数。 */
fun kcalLabel(value: Double): String = "${Math.round(value)}"

/** 只有负重和次数的一组才和相邻同负重的组合并；带时长或距离的组单独成行，字段不丢。 */
private fun TrainingSet.loadAndRepsOnly() =
    loadValue != null && reps != null && durationSeconds == null && distanceValue == null

private fun loadText(set: TrainingSet): String? =
    set.loadValue?.let { "${num(it)} ${set.loadUnit ?: "kg"}" }

private fun durationText(seconds: Int): String {
    val minutes = seconds / 60
    if (minutes < 60) return "$minutes 分钟"
    val rest = minutes % 60
    return if (rest == 0) "${minutes / 60} 小时" else "${minutes / 60} 小时 $rest 分钟"
}

/**
 * 一个动作的逐组描述，一段一行。
 * 负重相同的连续组合并成「45 kg × 12、12、10」；有氧组给时长和距离；缺的值不补。
 */
fun describeSets(sets: List<TrainingSet>): List<String> {
    val parts = mutableListOf<String>()
    var i = 0
    while (i < sets.size) {
        val set = sets[i]
        val load = loadText(set)
        val reps = set.reps
        if (load != null && reps != null && set.loadAndRepsOnly()) {
            val group = mutableListOf(reps)
            var j = i + 1
            while (j < sets.size && sets[j].loadAndRepsOnly() && loadText(sets[j]) == load) {
                group.add(sets[j].reps!!)
                j++
            }
            parts.add("$load × ${group.joinToString("、")}")
            i = j
            continue
        }
        // 只报了次数（负重单位不明或自重）：同样合并成一段，不要写成「12 次；12 次；12 次」。
        if (load == null && reps != null && set.durationSeconds == null && set.distanceValue == null) {
            val group = mutableListOf(reps)
            var j = i + 1
            while (j < sets.size && sets[j].run {
                    loadValue == null && reps != null && durationSeconds == null && distanceValue == null
                }
            ) {
                group.add(sets[j].reps!!)
                j++
            }
            parts.add("${group.joinToString("、")} 次")
            i = j
            continue
        }
        val pieces = listOfNotNull(
            load,
            reps?.let { "$it 次" },
            set.durationSeconds?.let { durationText(it) },
            set.distanceValue?.let { "${num(it)} ${set.distanceUnit ?: "km"}" },
        )
        parts.add(if (pieces.isEmpty()) "1 组" else pieces.joinToString(" · "))
        i++
    }
    return parts
}

/** 会话抬头下面那一排：时长、消耗、RPE，缺的不占位。场馆单独一行，不在这里。 */
fun sessionSummary(session: TrainingSession): List<String> = listOfNotNull(
    session.durationSeconds?.let { durationText(it) },
    session.caloriesKcal?.let { "${kcalLabel(it)} 千卡" },
    session.overallRpe?.let { "RPE ${num(it)}" },
)

/** 体测指标的中文名和单位。体重不在这里：卡片上单独用大字显示。 */
internal val METRIC_LABELS = mapOf(
    "body_fat_pct" to ("体脂率" to "%"),
    "bmi" to ("BMI" to ""),
    "fat_mass_kg" to ("脂肪量" to "kg"),
    "subcutaneous_fat_pct" to ("皮下脂肪率" to "%"),
    "visceral_fat_index" to ("内脏脂肪等级" to ""),
    "fat_free_mass_kg" to ("去脂体重" to "kg"),
    "muscle_pct" to ("肌肉率" to "%"),
    "skeletal_muscle_pct" to ("骨骼肌率" to "%"),
    "bone_mass_kg" to ("骨量" to "kg"),
    "smi" to ("SMI" to "kg/m²"),
    "body_water_pct" to ("水分率" to "%"),
    "protein_pct" to ("蛋白质率" to "%"),
    "bmr_kcal" to ("基础代谢" to "千卡"),
    "whr" to ("腰臀比" to ""),
    "body_age" to ("身体年龄" to "岁"),
    "heart_rate_bpm" to ("心率" to "bpm"),
    "height_cm" to ("身高" to "cm"),
)

/** 一组体测指标。[title] 为 null 的是卡片上默认露出的那组，其余点「展开指标」才显示。 */
data class MetricGroup(val title: String?, val rows: List<Pair<String, String>>)

/** 分组与组内顺序。[METRIC_LABELS] 的每个键恰好出现在一组里，单测钉住。 */
internal val METRIC_GROUPS = listOf(
    null to listOf("body_fat_pct", "bmi"),
    "脂肪" to listOf("fat_mass_kg", "subcutaneous_fat_pct", "visceral_fat_index"),
    "肌肉与骨骼" to listOf("fat_free_mass_kg", "muscle_pct", "skeletal_muscle_pct", "bone_mass_kg", "smi"),
    "水分与蛋白质" to listOf("body_water_pct", "protein_pct"),
    "其他读数" to listOf("bmr_kcal", "whr", "body_age", "heart_rate_bpm", "height_cm"),
)

/** 按组列出体重以外的指标，空组不出现。服务端以后多给的指标按原键名排在「其他读数」最后，不会丢。 */
fun metricGroups(metrics: Map<String, Double>): List<MetricGroup> {
    val extra = metrics.keys.filterNot { it == "weight_kg" || it in METRIC_LABELS }.sorted()
    return METRIC_GROUPS.map { (title, keys) ->
        val rows = keys.mapNotNull { key ->
            val value = metrics[key] ?: return@mapNotNull null
            val (name, unit) = METRIC_LABELS.getValue(key)
            name to if (unit.isEmpty()) num(value) else "${num(value)} $unit"
        }
        MetricGroup(title, if (title == "其他读数") rows + extra.map { it to num(metrics.getValue(it)) } else rows)
    }.filter { it.rows.isNotEmpty() }
}
