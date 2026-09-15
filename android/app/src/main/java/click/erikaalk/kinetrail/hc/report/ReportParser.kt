// FitDays+「人体成分分析报告」图片的 OCR 结果 → 结构化读数。纯 Kotlin，不依赖 Android，单测直接喂文本行。
// 报告是 FitDays+ 按固定版式画出来的位图（ICERDrawReport），所以按「分区标题 + 同一行右侧的数字」取值，
// 不按绝对像素：分享出来的图可能被缩放。取不到的字段和对不上的交叉校验都会列进 problems，有问题不许上传。

package click.erikaalk.kinetrail.hc.report

import java.time.LocalDateTime
import kotlin.math.abs

data class OcrLine(val text: String, val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val norm: String = normalize(text)
    val cx get() = (left + right) / 2
    val cy get() = (top + bottom) / 2
    val height get() = bottom - top
}

data class Measured(val value: Double, val min: Double, val max: Double)
data class SegmentValue(val kg: Double, val pct: Double)

/** 分段顺序与服务端 schema 一致。左右按报告上的「左」「右」标注（左侧那一列是左臂、左腿）。 */
data class Segments<T>(val leftArm: T, val rightArm: T, val trunk: T, val leftLeg: T, val rightLeg: T) {
    fun toList() = listOf("left_arm" to leftArm, "right_arm" to rightArm, "trunk" to trunk, "left_leg" to leftLeg, "right_leg" to rightLeg)
}

data class BodyReport(
    /** 报告上的检测时间，只到分钟，设备时区。 */
    val measuredAt: LocalDateTime,
    val age: Int,
    val heightCm: Double,
    val bodyScore: Double,
    val weight: Measured,
    val bodyFat: Measured,
    val boneMass: Measured,
    val protein: Measured,
    val bodyWater: Measured,
    val muscle: Measured,
    val skeletalMuscle: Measured,
    val bodyFatPct: Double,
    val boneMassPct: Double,
    val proteinPct: Double,
    val bodyWaterPct: Double,
    val musclePct: Double,
    val skeletalMusclePct: Double,
    val bmi: Double,
    val obesityDegreePct: Double,
    val targetWeight: Double,
    val weightControl: Double,
    val fatControl: Double,
    val muscleControl: Double,
    val visceralFat: Double,
    val bmr: Double,
    val fatFreeMass: Double,
    val subcutaneousFatPct: Double,
    val smi: Double,
    val bodyAge: Double,
    val whr: Double,
    val segmentFat: Segments<SegmentValue>?,
    val segmentMuscle: Segments<SegmentValue>?,
    /** 键是频率（kHz）。报告里的阻抗是 FitDays+ 的显示值，不是秤的原始 imps。 */
    val impedance: Map<Int, Segments<Double>>?,
)

data class ParseResult(val report: BodyReport?, val problems: List<String>) {
    val uploadable get() = report != null && problems.isEmpty()
}

private val WHITESPACE = Regex("\\s+")
private fun normalize(text: String) = text
    // 表格边线常被读成行首的「|」
    .replace(WHITESPACE, "").replace(Regex("[|｜丨]"), "")
    .replace('（', '(').replace('）', ')').replace('：', ':').replace('／', '/').replace('％', '%')
    .replace(Regex("[一—–－−](?=\\d)"), "-")

private val NUMBER = Regex("\\d+(?:\\.\\d+)?")
private val SIGNED = Regex("-?\\d+(?:\\.\\d+)?")
private val PURE_NUMBER = Regex("^\\d+(?:\\.\\d+)?$")
private val KG_VALUE = Regex("^(\\d+(?:\\.\\d+)?)k[gq9]$", RegexOption.IGNORE_CASE)
// 实测「100.2%」会读成「100.2°%」
private val PCT_VALUE = Regex("^(\\d+(?:\\.\\d+)?)°?%$")
private val KHZ_ROW = Regex("^(\\d+)\\(?khz\\)?$", RegexOption.IGNORE_CASE)
private val TIME = Regex("(\\d{4})/(\\d{2})/(\\d{2})(\\d{2}):(\\d{2})")

private val SEGMENT_HEADERS = listOf("右臂", "左臂", "躯干", "右腿", "左腿")

// ML Kit 在报告衬线字体上读错的形近字（模拟器实测 2026-09-15）：体→休、控→挖、肉→內、衡→衝。
// 「肉」还会读成「内」（肌内型），但「内脏」是真的「内」，不能全局换回，交给下面的一字容错。
private val LOOKALIKES = mapOf('休' to '体', '挖' to '控', '內' to '肉', '衝' to '衡')

/** 标签比较：先换回形近字；四个字以上的标签再容忍一个字读错（同一分区里的标签彼此至少差两个字）。 */
private fun sameLabel(text: String, label: String): Boolean {
    val t = String(CharArray(text.length) { LOOKALIKES[text[it]] ?: text[it] })
    if (t == label) return true
    return label.length >= 4 && t.length == label.length && t.indices.count { t[it] != label[it] } <= 1
}

object ReportParser {

    fun parse(lines: List<OcrLine>, imageWidth: Float): ParseResult = Parser(lines, imageWidth).run()
}

private class Parser(private val lines: List<OcrLine>, width: Float) {
    private val problems = mutableListOf<String>()
    /** 行带容差、分列边距都按图宽取比例，缩放过的分享图也能用。 */
    private val margin = width * 0.01f
    private val pageBottom = (lines.maxOfOrNull { it.bottom } ?: 0f) + 1f

    private fun missing(what: String): Nothing? {
        problems += "没认出$what"
        return null
    }

    /** 分区标题：同名的取最上面那个（「体重控制」既是标题也是行名）。 */
    private fun header(vararg names: String, inRightColumn: Boolean? = null, rightX: Float = 0f): OcrLine? =
        lines.filter { line -> names.any { sameLabel(line.norm, it) } }
            .filter { inRightColumn == null || (it.left >= rightX) == inRightColumn }
            .minByOrNull { it.top }

    private fun region(x: ClosedFloatingPointRange<Float>, top: Float, bottom: Float) =
        lines.filter { it.cx in x && it.cy > top && it.cy < bottom }

    /** 行名右侧同一行的文字（含行名那一行自己剩下的部分），从左到右拼起来。 */
    private fun rowText(label: OcrLine, labelName: String, pool: List<OcrLine>): String {
        val rest = if (label.norm.startsWith(labelName)) label.norm.removePrefix(labelName) else ""
        val right = pool.filter {
            it !== label && it.left >= label.right - margin &&
                abs(it.cy - label.cy) <= maxOf(label.height, it.height) * 0.6f
        }.sortedBy { it.left }
        return rest + right.joinToString(" ") { it.norm }
    }

    /** 找行名（可带别名），要求这一行右侧确实有数字，避免撞上同名的分区标题。 */
    private fun row(pool: List<OcrLine>, vararg names: String, signed: Boolean = false): List<Double>? {
        for (line in pool.sortedBy { it.top }) {
            val name = names.firstOrNull { n ->
                sameLabel(line.norm, n) || (line.norm.startsWith(n) && line.norm.getOrNull(n.length)?.let { it.isDigit() || it == '-' || it == '(' } == true)
            } ?: continue
            val numbers = (if (signed) SIGNED else NUMBER).findAll(rowText(line, name, pool)).map { it.value.toDouble() }.toList()
            if (numbers.isNotEmpty()) return numbers
        }
        return null
    }

    fun run(): ParseResult {
        val composition = header("身体成分分析")
        val muscleFat = header("肌肉脂肪分析")
        val score = header("身体得分")
        val otherHeader = header("其它指标", "其他指标")
        if (composition == null || muscleFat == null || score == null || otherHeader == null) {
            return ParseResult(null, listOf("这不像 FitDays+ 的人体成分分析报告，或者图片不清楚"))
        }
        val rightX = minOf(score.left, otherHeader.left) - margin
        val left = 0f..rightX
        val right = rightX..Float.MAX_VALUE
        val controlHeader = header("体重控制", inRightColumn = true, rightX = rightX)
        val obesityHeader = header("肥胖评估")
        val bodyTypeHeader = header("体型评估")

        // 抬头一行：先逐行找，找不到再按阅读顺序拼起来找（OCR 可能把「2026/09/15」和「20:43」拆成两行）
        val readingOrder = lines.sortedWith(compareBy({ (it.cy / (margin * 3)).toInt() }, { it.left })).joinToString("") { it.norm }
        fun match(regex: Regex) = lines.firstNotNullOfOrNull { regex.find(it.norm) } ?: regex.find(readingOrder)
        val time = match(TIME)?.destructured?.let { (y, mo, d, h, mi) ->
            runCatching { LocalDateTime.of(y.toInt(), mo.toInt(), d.toInt(), h.toInt(), mi.toInt()) }.getOrNull()
        } ?: missing("检测时间")
        val age = match(Regex("年龄:?(\\d{1,3})(?![\\d.])"))?.groupValues?.get(1)?.toInt() ?: missing("年龄")
        val height = match(Regex("身高:?(\\d{2,3}(?:\\.\\d)?)cm", RegexOption.IGNORE_CASE))
            ?.groupValues?.get(1)?.toDouble() ?: missing("身高")

        // 身体成分分析：测量(kg) (范围) | 重量比例(%) | 评估
        val compPool = region(left, composition.bottom, muscleFat.top)
        fun measured(label: String, vararg names: String): Pair<Measured, Double>? {
            val n = row(compPool, *names) ?: return missing(label)
            if (n.size < 4) return missing("${label}的全部读数")
            return Measured(n[0], n[1], n[2]) to n[3]
        }
        val weight = measured("体重", "体重")
        val fat = measured("体脂", "体脂", "体脂肪")
        val bone = measured("骨重量", "骨重量", "骨量")
        val protein = measured("蛋白质", "蛋白质")
        val water = measured("身体水份", "身体水份", "身体水分")
        val muscle = measured("肌肉", "肌肉")
        val skeletal = measured("骨骼肌率", "骨骼肌率", "骨骼肌")

        // 身体得分：这一区最高的一行，大号斜体数字接「/100分」。实测会整行读成「77n00」，所以只认开头的数字
        val scorePool = region(right, score.bottom, controlHeader?.top ?: obesityHeader?.top ?: pageBottom)
        val bodyScore = scorePool.maxByOrNull { it.height }
            ?.let { Regex("^(\\d{1,3})(?:\\D{1,2}1?00分?)?$").find(it.norm) }
            ?.groupValues?.get(1)?.toDouble()
            ?: missing("身体得分")

        val controlPool = if (controlHeader != null && obesityHeader != null) {
            region(right, controlHeader.bottom, obesityHeader.top)
        } else {
            emptyList()
        }
        fun control(label: String) = row(controlPool, label, signed = true)?.first() ?: missing(label)
        val target = control("目标体重")
        val weightControl = control("体重控制")
        val fatControl = control("脂肪控制")
        val muscleControl = control("肌肉控制")

        // 肥胖评估：BMI 数值在「BMI」与「体脂率」两个标签之间；肥胖度是这一区唯一带 % 的数
        val obesityPool = if (obesityHeader != null && bodyTypeHeader != null) {
            region(right, obesityHeader.bottom, bodyTypeHeader.top)
        } else {
            emptyList()
        }
        val bmiLabel = obesityPool.firstOrNull { it.norm.equals("BMI", ignoreCase = true) }
        val fatRateLabel = obesityPool.firstOrNull { sameLabel(it.norm, "体脂率") }
        val bmi = if (bmiLabel != null && fatRateLabel != null) {
            obesityPool.filter { it.cy > bmiLabel.bottom && it.cy < fatRateLabel.top && PURE_NUMBER.matches(it.norm) }
                .minByOrNull { it.top }?.norm?.toDouble()
        } else {
            null
        } ?: missing("BMI")
        val obesity = obesityPool.firstNotNullOfOrNull { PCT_VALUE.find(it.norm)?.groupValues?.get(1)?.toDouble() }
            ?: missing("肥胖度")

        val otherPool = region(right, otherHeader.bottom, pageBottom)
        fun other(label: String, vararg names: String) = row(otherPool, *names)?.first() ?: missing(label)
        val visceral = other("内脏脂肪等级", "内脏脂肪等级")
        val bmr = other("基础代谢率", "基础代谢率")
        val fatFree = other("去脂体重", "去脂体重")
        val subcutaneous = other("皮下脂肪", "皮下脂肪")
        val smi = other("SMI", "SMI")
        val bodyAge = other("身体年龄", "身体年龄")
        val whr = other("腰臀比", "腰臀比")

        // 分段：两块左右并排，下沿到「生物电阻抗」；「标准范围」说明行及其以下不参与
        val impedanceHeader = header("生物电阻抗")
        val segFatHeader = header("分段脂肪分析")
        val balanceHeader = header("肌肉均衡")
        val segBottom = impedanceHeader?.top ?: pageBottom
        val segmentFat = segFatHeader?.let {
            val xEnd = balanceHeader?.left?.minus(margin) ?: rightX
            segments("分段脂肪", region(0f..xEnd, it.bottom, segBottom))
        }
        val segmentMuscle = balanceHeader?.let { segments("肌肉均衡", region((it.left - margin)..rightX, it.bottom, segBottom)) }

        val impedance = impedanceHeader?.let { h ->
            val bottom = header("分析和建议")?.top ?: pageBottom
            impedance(region(left, h.bottom, bottom))
        }

        if (problems.isNotEmpty()) return ParseResult(null, problems)
        val report = BodyReport(
            measuredAt = time!!, age = age!!, heightCm = height!!, bodyScore = bodyScore!!,
            weight = weight!!.first, bodyFat = fat!!.first, boneMass = bone!!.first, protein = protein!!.first,
            bodyWater = water!!.first, muscle = muscle!!.first, skeletalMuscle = skeletal!!.first,
            bodyFatPct = fat.second, boneMassPct = bone.second, proteinPct = protein.second,
            bodyWaterPct = water.second, musclePct = muscle.second, skeletalMusclePct = skeletal.second,
            bmi = bmi!!, obesityDegreePct = obesity!!,
            targetWeight = target!!, weightControl = weightControl!!, fatControl = fatControl!!, muscleControl = muscleControl!!,
            visceralFat = visceral!!, bmr = bmr!!, fatFreeMass = fatFree!!, subcutaneousFatPct = subcutaneous!!,
            smi = smi!!, bodyAge = bodyAge!!, whr = whr!!,
            segmentFat = segmentFat, segmentMuscle = segmentMuscle, impedance = impedance,
        )
        return ParseResult(report, ReportChecks.problems(report))
    }

    /** 分段读数：「0.6kg」与「103.8%」各 5 个，按上中下三排（2/1/2）排好，排内左小右大。 */
    private fun segments(label: String, pool: List<OcrLine>): Segments<SegmentValue>? {
        val cut = pool.filter { it.norm.startsWith("标准范围") }.minOfOrNull { it.top } ?: Float.MAX_VALUE
        val usable = pool.filter { it.bottom <= cut }
        val kg = arrange(usable.mapNotNull { l -> KG_VALUE.find(l.norm)?.let { l to it.groupValues[1].toDouble() } })
        val pct = arrange(usable.mapNotNull { l -> PCT_VALUE.find(l.norm)?.let { l to it.groupValues[1].toDouble() } })
        if (kg == null || pct == null) return missing("${label}的五个部位")
        return Segments(
            SegmentValue(kg[0], pct[0]), SegmentValue(kg[1], pct[1]), SegmentValue(kg[2], pct[2]),
            SegmentValue(kg[3], pct[3]), SegmentValue(kg[4], pct[4]),
        )
    }

    /** 返回 [左臂, 右臂, 躯干, 左腿, 右腿]；排数或每排个数不对返回 null。 */
    private fun arrange(values: List<Pair<OcrLine, Double>>): List<Double>? {
        val rows = mutableListOf<MutableList<Pair<OcrLine, Double>>>()
        for (v in values.sortedBy { it.first.cy }) {
            val last = rows.lastOrNull()
            if (last != null && v.first.cy - last.first().first.cy <= maxOf(v.first.height, margin * 2)) last += v else rows += mutableListOf(v)
        }
        if (rows.map { it.size } != listOf(2, 1, 2)) return null
        val (top, mid, bottom) = rows.map { r -> r.sortedBy { it.first.cx }.map { it.second } }
        return listOf(top[0], top[1], mid[0], bottom[0], bottom[1])
    }

    private fun impedance(pool: List<OcrLine>): Map<Int, Segments<Double>>? {
        val columns = SEGMENT_HEADERS.map { name -> pool.firstOrNull { sameLabel(it.norm, name) } ?: return missing("阻抗表的「$name」列") }
        val out = sortedMapOf<Int, Segments<Double>>()
        for (label in pool.filter { KHZ_ROW.matches(it.norm) }) {
            // FitDays+ 只画 5（三频秤）、20、100 三行；其他数字是读错了，不上传
            val khz = KHZ_ROW.find(label.norm)!!.groupValues[1].toInt().takeIf { it in setOf(5, 20, 100) }
                ?: return missing("阻抗表的频率")
            val cells = pool.filter {
                it !== label && it.left >= label.right - margin && PURE_NUMBER.matches(it.norm) &&
                    abs(it.cy - label.cy) <= maxOf(label.height, it.height) * 0.6f
            }
            // 按离哪一列表头最近归列；列序即 SEGMENT_HEADERS：右臂、左臂、躯干、右腿、左腿
            val byColumn = cells.groupBy { cell -> columns.indices.minBy { abs(columns[it].cx - cell.cx) } }
            if (byColumn.size != 5 || byColumn.values.any { it.size != 1 }) return missing("${khz}kHz 阻抗的五个部位")
            fun v(column: Int) = byColumn.getValue(column).single().norm.toDouble()
            out[khz] = Segments(leftArm = v(1), rightArm = v(0), trunk = v(2), leftLeg = v(4), rightLeg = v(3))
        }
        if (20 !in out || 100 !in out) return missing("20kHz 与 100kHz 阻抗")
        return out
    }
}

/** 报告内部的算术关系。OCR 读错一位小数时几乎总会破坏其中一条。容差只吸收显示舍入。 */
object ReportChecks {
    fun problems(r: BodyReport): List<String> = buildList {
        fun near(a: Double, b: Double, tolerance: Double) = abs(a - b) <= tolerance + 1e-9
        fun bounded(label: String, v: Double, min: Double, max: Double) {
            if (v < min || v > max) add("$label ${fmt(v)} 超出合理范围")
        }
        bounded("体重", r.weight.value, 2.0, 400.0)
        bounded("身高", r.heightCm, 50.0, 250.0)
        bounded("年龄", r.age.toDouble(), 0.0, 150.0)
        listOf(
            Triple("体脂", r.bodyFat, r.bodyFatPct), Triple("骨重量", r.boneMass, r.boneMassPct),
            Triple("蛋白质", r.protein, r.proteinPct), Triple("身体水份", r.bodyWater, r.bodyWaterPct),
            Triple("肌肉", r.muscle, r.musclePct), Triple("骨骼肌率", r.skeletalMuscle, r.skeletalMusclePct),
        ).forEach { (label, m, pct) ->
            bounded("${label}比例", pct, 0.0, 100.0)
            if (!near(m.value / r.weight.value * 100, pct, 0.2)) add("$label ${fmt(m.value)} kg 与 ${fmt(pct)}% 对不上")
        }
        listOf("体重" to r.weight, "体脂" to r.bodyFat, "骨重量" to r.boneMass, "蛋白质" to r.protein,
            "身体水份" to r.bodyWater, "肌肉" to r.muscle, "骨骼肌率" to r.skeletalMuscle).forEach { (label, m) ->
            if (m.min > m.max || m.max > 400) add("$label 的标准范围 ${fmt(m.min)}–${fmt(m.max)} 不合理")
        }
        if (!near(r.fatFreeMass, r.weight.value - r.bodyFat.value, 0.15)) add("去脂体重 ${fmt(r.fatFreeMass)} kg 与体重减体脂对不上")
        if (!near(r.weightControl, r.targetWeight - r.weight.value, 0.15)) add("体重控制 ${fmt(r.weightControl)} kg 与目标体重对不上")
        if (!near(r.fatControl + r.muscleControl, r.weightControl, 0.15)) add("脂肪控制与肌肉控制之和不等于体重控制")
        if (!near(r.bmi, r.weight.value / (r.heightCm / 100).let { it * it }, 0.15)) add("BMI ${fmt(r.bmi)} 与体重、身高对不上")
        bounded("体脂率", r.bodyFatPct, 0.0, 100.0)
        bounded("皮下脂肪", r.subcutaneousFatPct, 0.0, 100.0)
        bounded("基础代谢率", r.bmr, 300.0, 10000.0)
        bounded("内脏脂肪等级", r.visceralFat, 0.0, 100.0)
        bounded("身体得分", r.bodyScore, 0.0, 200.0)
        bounded("腰臀比", r.whr, 0.0, 10.0)
        bounded("SMI", r.smi, 0.0, 100.0)
        bounded("身体年龄", r.bodyAge, 0.0, 150.0)
        bounded("肥胖度", r.obesityDegreePct, 0.0, 1000.0)
        for ((label, s) in listOf("分段脂肪" to r.segmentFat, "肌肉均衡" to r.segmentMuscle)) {
            s?.toList()?.forEach { (_, v) ->
                if (v.kg > r.weight.value || v.pct > 1000) add("$label 的读数 ${fmt(v.kg)} kg / ${fmt(v.pct)}% 不合理")
            }
        }
        // 人体阻抗随频率升高而下降；读错小数点或串列时这条通常不成立。
        val freqs = r.impedance?.keys?.sorted().orEmpty()
        for ((low, high) in freqs.zipWithNext()) {
            val a = r.impedance!!.getValue(low).toList()
            val b = r.impedance.getValue(high).toList()
            a.zip(b).forEach { (x, y) ->
                if (x.second <= y.second || x.second > 100_000) add("${low}kHz 与 ${high}kHz 的阻抗大小关系不对（${x.first}）")
            }
        }
    }
}

internal fun fmt(v: Double): String = if (v == Math.floor(v) && abs(v) < 1e9) v.toLong().toString() else v.toString()

/** 按服务端 `reports[]` 的 schema 序列化（src/ingest.ts 的 REPORT_SCHEMA）。只有数字，不带任何文字。 */
fun BodyReport.toIngestJson(measuredMinuteMs: Long): String {
    fun m(x: Measured) = mapOf("value" to x.value, "min" to x.min, "max" to x.max)
    fun seg(s: Segments<SegmentValue>) = s.toList().associate { (k, v) -> k to mapOf("kg" to v.kg, "pct" to v.pct) }
    val body = linkedMapOf<String, Any>(
        "measured_minute_ms" to measuredMinuteMs,
        "height_cm" to heightCm, "age" to age, "body_score" to bodyScore,
        "weight_kg" to m(weight), "body_fat_kg" to m(bodyFat), "bone_mass_kg" to m(boneMass),
        "protein_kg" to m(protein), "body_water_kg" to m(bodyWater), "muscle_kg" to m(muscle),
        "skeletal_muscle_kg" to m(skeletalMuscle),
        "body_fat_pct" to bodyFatPct, "bone_mass_pct" to boneMassPct, "protein_pct" to proteinPct,
        "body_water_pct" to bodyWaterPct, "muscle_pct" to musclePct, "skeletal_muscle_pct" to skeletalMusclePct,
        "bmi" to bmi, "obesity_degree_pct" to obesityDegreePct,
        "target_weight_kg" to targetWeight, "weight_control_kg" to weightControl,
        "fat_control_kg" to fatControl, "muscle_control_kg" to muscleControl,
        "visceral_fat_level" to visceralFat, "bmr_kcal" to bmr, "fat_free_mass_kg" to fatFreeMass,
        "subcutaneous_fat_pct" to subcutaneousFatPct, "smi" to smi, "body_age" to bodyAge, "whr" to whr,
    )
    segmentFat?.let { body["segment_fat"] = seg(it) }
    segmentMuscle?.let { body["segment_muscle"] = seg(it) }
    impedance?.let { imp -> body["impedance_ohm"] = imp.entries.associate { (k, s) -> "khz_$k" to s.toList().toMap() } }
    return json(body)
}

private fun json(value: Any?): String = when (value) {
    is Map<*, *> -> value.entries.joinToString(",", "{", "}") { (k, v) -> "\"$k\":${json(v)}" }
    is Double -> fmt(value)
    is Number -> value.toString()
    else -> throw IllegalArgumentException("report json only carries numbers")
}
