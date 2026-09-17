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
)

data class TrainingSession(
    val status: String,
    val startedAt: OffsetDateTime?,
    val endedAt: OffsetDateTime?,
    val durationSeconds: Int?,
    val caloriesKcal: Double?,
    val overallRpe: Double?,
    val facility: String?,
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
                    entries = s.optJSONArray("entries").map { e ->
                        TrainingEntry(
                            name = e.optString("exercise_name_raw"),
                            category = e.optString("category"),
                            equipment = e.stringOrNull("equipment_label"),
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

/** 一个数值和它的单位。界面把两者分开排：数值大，单位小一号。单位可以为空。 */
data class Reading(val value: String, val unit: String)

private fun List<Reading>.text() = joinToString(" ") { if (it.unit.isEmpty()) it.value else "${it.value} ${it.unit}" }

/** 时长：77 分钟、1 分 30 秒、45 秒。不换算成小时，也不舍掉秒。 */
fun durationReadings(seconds: Int): List<Reading> {
    val minutes = seconds / 60
    val rest = seconds % 60
    return when {
        minutes == 0 -> listOf(Reading("$rest", "秒"))
        rest == 0 -> listOf(Reading("$minutes", "分钟"))
        else -> listOf(Reading("$minutes", "分"), Reading("$rest", "秒"))
    }
}

/** 训练卡抬头下面的一项统计：标签在上，数值在下。 */
data class SessionStat(val label: String, val readings: List<Reading>)

/** 时长、消耗、RPE，缺的整项不出现。场馆单独一行，不在这里。 */
fun sessionStats(session: TrainingSession): List<SessionStat> = listOfNotNull(
    session.durationSeconds?.let { SessionStat("时长", durationReadings(it)) },
    session.caloriesKcal?.let { SessionStat("消耗", listOf(Reading(kcalLabel(it), "千卡"))) },
    session.overallRpe?.let { SessionStat("RPE", listOf(Reading(num(it), ""))) },
)

/** 表格里的一行：相邻的 [count] 组每一格都一样。某组没填的格是 null。 */
data class SetRow(val count: Int, val cells: List<String?>)

/**
 * 一个动作的逐组表格。[columns] 只放这个动作里至少有一组填了的字段，顺序固定为负重、次数、时长、距离；
 * 相邻几组负重、次数、时长、距离全一样时合成一行记组数，中间隔了别的组不合并，先后顺序不乱。
 * 单位照服务端给的写（写入时数值和单位必须成对），不补默认单位。
 */
data class SetTable(val columns: List<String>, val rows: List<SetRow>)

private fun withUnit(value: String, unit: String?) = if (unit == null) value else "$value $unit"

private val SET_FIELDS = listOf<Pair<String, (TrainingSet) -> String?>>(
    "负重" to { set -> set.loadValue?.let { withUnit(num(it), set.loadUnit) } },
    "次数" to { set -> set.reps?.toString() },
    "时长" to { set -> set.durationSeconds?.let { durationReadings(it).text() } },
    "距离" to { set -> set.distanceValue?.let { withUnit(num(it), set.distanceUnit) } },
)

fun setTable(sets: List<TrainingSet>): SetTable {
    val fields = SET_FIELDS.filter { (_, cell) -> sets.any { cell(it) != null } }
    val rows = mutableListOf<SetRow>()
    for (set in sets) {
        val cells = fields.map { (_, cell) -> cell(set) }
        val last = rows.lastOrNull()
        if (last?.cells == cells) rows[rows.lastIndex] = last.copy(count = last.count + 1) else rows.add(SetRow(1, cells))
    }
    return SetTable(fields.map { it.first }, rows)
}

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

data class MetricRow(val label: String, val reading: Reading)

/** 一组体测指标。[title] 为 null 的是卡片主区右侧常驻的那组，其余点「展开指标」才显示。 */
data class MetricGroup(val title: String?, val rows: List<MetricRow>)

/** 分组与组内顺序。[METRIC_LABELS] 的每个键恰好出现在一组里，单测钉住。 */
internal val METRIC_GROUPS = listOf(
    null to listOf("body_fat_pct", "bmi"),
    "脂肪" to listOf("fat_mass_kg", "subcutaneous_fat_pct", "visceral_fat_index"),
    "肌肉与骨骼" to listOf("fat_free_mass_kg", "muscle_pct", "skeletal_muscle_pct", "bone_mass_kg", "smi"),
    "水分与蛋白质" to listOf("body_water_pct", "protein_pct"),
    "其他读数" to listOf("bmr_kcal", "whr", "body_age", "heart_rate_bpm", "height_cm"),
)

/** 按组列出体重以外的指标，空组不出现。服务端以后多给的指标按原键名排在「其他读数」最后，不会丢，也不猜单位。 */
fun metricGroups(metrics: Map<String, Double>): List<MetricGroup> {
    val extra = metrics.keys.filterNot { it == "weight_kg" || it in METRIC_LABELS }.sorted()
    return METRIC_GROUPS.map { (title, keys) ->
        val rows = keys.mapNotNull { key ->
            val value = metrics[key] ?: return@mapNotNull null
            val (name, unit) = METRIC_LABELS.getValue(key)
            MetricRow(name, Reading(num(value), unit))
        }
        val unknown = extra.map { MetricRow(it, Reading(num(metrics.getValue(it)), "")) }
        MetricGroup(title, if (title == "其他读数") rows + unknown else rows)
    }.filter { it.rows.isNotEmpty() }
}

/** 不是阻抗推算出来的指标：只有它们时不出现 BIA 说明。 */
private val NOT_BIA = setOf("bmi", "heart_rate_bpm", "height_cm")

/** 这次称重里有没有体脂、肌肉、水分这类 BIA 推算值。没见过的指标不算，不猜它的来历。 */
fun hasBiaMetrics(metrics: Map<String, Double>): Boolean = metrics.keys.any { it in METRIC_LABELS && it !in NOT_BIA }
