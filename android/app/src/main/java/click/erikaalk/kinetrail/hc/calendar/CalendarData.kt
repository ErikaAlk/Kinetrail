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

private fun loadText(set: TrainingSet): String? =
    set.loadValue?.let { "${num(it)} ${set.loadUnit ?: "kg"}" }

private fun durationText(seconds: Int): String {
    val minutes = seconds / 60
    if (minutes < 60) return "$minutes 分钟"
    val rest = minutes % 60
    return if (rest == 0) "${minutes / 60} 小时" else "${minutes / 60} 小时 $rest 分钟"
}

/**
 * 一个动作的逐组描述。
 * 负重相同的连续组合并成「45 kg × 12、12、10」；有氧组给时长和距离；缺的值不补。
 */
fun describeSets(sets: List<TrainingSet>): String {
    val parts = mutableListOf<String>()
    var i = 0
    while (i < sets.size) {
        val set = sets[i]
        val load = loadText(set)
        val reps = set.reps
        if (load != null && reps != null) {
            val group = mutableListOf(reps)
            var j = i + 1
            while (j < sets.size && loadText(sets[j]) == load && sets[j].reps != null) {
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
    return parts.joinToString("；")
}

/** 会话抬头那一行：时长、消耗、RPE、场馆，缺的不占位。 */
fun sessionSummary(session: TrainingSession): String = listOfNotNull(
    session.durationSeconds?.let { durationText(it) },
    session.caloriesKcal?.let { "${kcalLabel(it)} 千卡" },
    session.overallRpe?.let { "RPE ${num(it)}" },
    session.facility,
).joinToString(" · ")

/** 体测指标的显示顺序、中文名和单位。服务端以后多给的指标按原键名排在后面，不会丢。 */
private val METRIC_LABELS = listOf(
    "weight_kg" to ("体重" to "kg"),
    "body_fat_pct" to ("体脂率" to "%"),
    "fat_mass_kg" to ("脂肪量" to "kg"),
    "fat_free_mass_kg" to ("去脂体重" to "kg"),
    "muscle_pct" to ("肌肉率" to "%"),
    "skeletal_muscle_pct" to ("骨骼肌率" to "%"),
    "protein_pct" to ("蛋白质率" to "%"),
    "body_water_pct" to ("水分率" to "%"),
    "bone_mass_kg" to ("骨量" to "kg"),
    "subcutaneous_fat_pct" to ("皮下脂肪率" to "%"),
    "visceral_fat_index" to ("内脏脂肪等级" to ""),
    "bmi" to ("BMI" to ""),
    "bmr_kcal" to ("基础代谢" to "千卡"),
    "smi" to ("SMI" to "kg/m²"),
    "whr" to ("腰臀比" to ""),
    "body_age" to ("身体年龄" to "岁"),
    "heart_rate_bpm" to ("心率" to "bpm"),
    "height_cm" to ("身高" to "cm"),
)

fun metricRows(metrics: Map<String, Double>): List<Pair<String, String>> {
    val known = METRIC_LABELS.mapNotNull { (key, label) ->
        val value = metrics[key] ?: return@mapNotNull null
        val (name, unit) = label
        name to if (unit.isEmpty()) num(value) else "${num(value)} $unit"
    }
    val extra = metrics.keys.filterNot { key -> METRIC_LABELS.any { it.first == key } }.sorted()
        .map { it to num(metrics.getValue(it)) }
    return known + extra
}
