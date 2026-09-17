package click.erikaalk.kinetrail.hc.report

import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 夹具按 2026-09-15 20:43 那份 FitDays+ 报告（1410 像素宽）的版式逐格摆放。读数是合成的，与 tests/ingest.test.ts 的 REPORT 相同，
 * 满足报告内部的算术关系。每个单元格一行，是 ML Kit 在大间距表格上的常见分法；另有合并成一行、整体缩放两种变体。
 */
class ReportParserTest {

    private fun L(text: String, l: Int, t: Int, r: Int, b: Int) = OcrLine(text, l.toFloat(), t.toFloat(), r.toFloat(), b.toFloat())

    private fun compositionRow(label: String, value: String, pct: String, y: Int) = listOf(
        L(label, 60, y, 60 + label.length * 21, y + 24),
        L(value, 335, y, 475, y + 24),
        L(pct, 612, y, 648, y + 24),
        L("标准", 765, y, 802, y + 24),
    )

    private fun rightRow(label: String, value: String, y: Int) =
        listOf(L(label, 915, y, 915 + label.length * 19, y + 20), L(value, 1366 - value.length * 11, y, 1366, y + 20))

    private fun segmentBlock(x: Int, rightX: Int, values: List<Pair<String, String>>) = buildList {
        val (la, ra, tr, ll, rl) = values
        add(L(la.first, x, 1056, x + 52, 1080)); add(L(ra.first, rightX - 52, 1056, rightX, 1080))
        add(L(la.second, x, 1090, x + 62, 1114)); add(L(ra.second, rightX - 62, 1090, rightX, 1114))
        add(L("标准", x, 1120, x + 36, 1140)); add(L("标准", rightX - 36, 1120, rightX, 1140))
        add(L(tr.first, x, 1172, x + 56, 1196)); add(L(tr.second, x, 1206, x + 62, 1230)); add(L("偏高", x, 1238, x + 36, 1258))
        add(L(ll.first, x, 1314, x + 52, 1338)); add(L(rl.first, rightX - 52, 1314, rightX, 1338))
        add(L(ll.second, x, 1348, x + 62, 1372)); add(L(rl.second, rightX - 62, 1348, rightX, 1372))
        add(L("左", x + 128, 1060, x + 144, 1080)); add(L("右", x + 204, 1060, x + 220, 1080))
        add(L("%", rightX - 20, 1446, rightX - 4, 1462)); add(L("评估", rightX - 36, 1470, rightX, 1486))
    }

    private fun impedanceRow(label: String, values: List<String>, y: Int) =
        listOf(L(label, 60, y, 60 + label.length * 11, y + 26)) +
            values.mapIndexed { i, v -> L(v, 285 + i * 128 - 25, y, 285 + i * 128 + 25, y + 26) }

    private fun fixture(merged: Boolean = false, fatValue: String = "14.1 (8.0-16.2)", impedance20: List<String> = IMP20): List<OcrLine> = buildList {
        add(L("人体成分分析报告", 48, 40, 425, 90))
        add(L("ID:Test-1", 140, 112, 238, 138)); add(L("性别:男", 368, 112, 438, 138))
        add(L("年龄:30", 569, 112, 638, 138)); add(L("身高:175cm", 769, 112, 880, 138))
        add(L("检测时间:2026/09/15 20:43", 1011, 112, 1271, 138))

        add(L("身体成分分析", 48, 162, 204, 190))
        add(L("测量(kg)", 368, 208, 440, 232)); add(L("重量比例(%)", 578, 208, 680, 232)); add(L("评估", 765, 208, 800, 232))
        val rows = listOf(
            Triple("体重", "72.40 (56.7-76.6)", "100.0"), Triple("体脂", fatValue, "19.5"),
            Triple("骨重量", "3.9 (3.2-4.0)", "5.4"), Triple("蛋白质", "11.8 (9.7-12.3)", "16.3"),
            Triple("身体水份", "42.6 (35.9-44.6)", "58.8"), Triple("肌肉", "54.4 (45.8-57.0)", "75.1"),
            Triple("骨骼肌率", "32.7 (28.5-34.9)", "45.2"),
        )
        rows.forEachIndexed { i, (label, value, pct) ->
            val y = 248 + i * 39
            if (merged) add(L("$label $value $pct 标准", 60, y, 802, y + 24)) else addAll(compositionRow(label, value, pct, y))
        }

        add(L("身体得分", 915, 162, 1020, 190))
        add(L("76", 920, 220, 995, 275)); add(L("/100分", 995, 235, 1100, 272))
        add(L("*总分反映了身体成分的评估值。", 915, 300, 1120, 318)); add(L("肌肉发达的人可能会得到100分以上。", 915, 322, 1180, 340))
        add(L("体重控制", 915, 375, 1020, 405))
        addAll(rightRow("目标体重", "68.2 kg", 432)); addAll(rightRow("体重控制", "-4.2 kg", 475))
        addAll(rightRow("脂肪控制", "-4.2 kg", 518)); addAll(rightRow("肌肉控制", "0.0 kg", 561))

        add(L("肌肉脂肪分析", 48, 532, 204, 560))
        add(L("体重(kg)", 60, 627, 138, 652)); add(L("55", 258, 624, 274, 638)); add(L("72.40", 468, 640, 518, 660))
        add(L("肥胖分析", 48, 797, 152, 825))
        add(L("BMI(kg/m²)", 60, 892, 170, 918)); add(L("10.0", 255, 888, 280, 902)); add(L("23.6", 472, 904, 512, 926))

        add(L("肥胖评估", 915, 622, 1020, 652))
        add(L("BMI", 925, 672, 958, 690)); add(L("23.6", 1066, 697, 1097, 714)); add(L("偏瘦", 955, 728, 987, 746))
        add(L("体脂率", 925, 778, 972, 796)); add(L("19.5", 1068, 798, 1097, 815))
        add(L("肥胖(当前体重/目标体重)", 925, 880, 1107, 898)); add(L("106%", 1118, 901, 1157, 917)); add(L("正常", 1125, 930, 1157, 948))
        add(L("体型评估", 915, 1002, 1020, 1032)); add(L("25.0", 921, 1147, 955, 1165)); add(L("匀称型", 1182, 1245, 1248, 1270))
        add(L("20.0", 1247, 1462, 1280, 1478))

        add(L("分段脂肪分析", 48, 1008, 204, 1036)); add(L("肌肉均衡", 495, 1008, 598, 1036))
        addAll(segmentBlock(48, 395, listOf("0.8kg" to "108.4%", "0.7kg" to "99.1%", "7.0kg" to "151.3%", "2.3kg" to "128.9%", "2.3kg" to "127.5%")))
        addAll(segmentBlock(495, 842, listOf("3.2kg" to "103.6%", "3.3kg" to "105.9%", "25.1kg" to "101.4%", "9.4kg" to "105.2%", "9.4kg" to "105.2%")))
        add(L("标准范围: 80%-160%", 48, 1496, 206, 1512)); add(L("节段脂肪分析为推断值", 48, 1516, 212, 1532))
        add(L("标准范围:", 495, 1496, 565, 1512)); add(L("左右上肢 (80%-115%)", 495, 1516, 646, 1532))

        add(L("生物电阻抗", 48, 1562, 178, 1590))
        add(L("Z(Ω)", 60, 1614, 104, 1640))
        listOf("右臂", "左臂", "躯干", "右腿", "左腿").forEachIndexed { i, h -> add(L(h, 285 + i * 128 - 21, 1614, 285 + i * 128 + 21, 1640)) }
        addAll(impedanceRow("20(kHz)", impedance20, 1664))
        addAll(impedanceRow("100(kHz)", listOf("262.0", "284.3", "18.1", "208.5", "226.4"), 1712))
        add(L("分析和建议", 48, 1765, 178, 1795)); add(L("体型适中，不胖不瘦，体成分均衡，继续保持。", 48, 1815, 860, 1840))

        add(L("其它指标", 915, 1540, 1020, 1570))
        addAll(rightRow("内脏脂肪等级", "5", 1598)); addAll(rightRow("基础代谢率", "1612 千卡", 1641))
        addAll(rightRow("去脂体重", "58.3 kg", 1685)); addAll(rightRow("皮下脂肪", "14.2 %", 1727))
        addAll(rightRow("SMI", "8.9 kg/m²", 1768)); addAll(rightRow("身体年龄", "29", 1812)); addAll(rightRow("腰臀比", "0.9", 1855))
    }.shuffled(java.util.Random(7))

    private fun assertReal(result: ParseResult) {
        assertEquals(emptyList(), result.problems)
        val r = assertNotNull(result.report)
        assertEquals(LocalDateTime.of(2026, 9, 15, 20, 43), r.measuredAt)
        assertEquals(30, r.age)
        assertEquals(175.0, r.heightCm)
        assertEquals(76.0, r.bodyScore)
        assertEquals(Measured(72.4, 56.7, 76.6), r.weight)
        assertEquals(Measured(14.1, 8.0, 16.2), r.bodyFat)
        assertEquals(19.5, r.bodyFatPct)
        assertEquals(Measured(32.7, 28.5, 34.9), r.skeletalMuscle)
        assertEquals(45.2, r.skeletalMusclePct)
        assertEquals(23.6, r.bmi)
        assertEquals(106.0, r.obesityDegreePct)
        assertEquals(listOf(68.2, -4.2, -4.2, 0.0), listOf(r.targetWeight, r.weightControl, r.fatControl, r.muscleControl))
        assertEquals(listOf(5.0, 1612.0, 58.3, 14.2, 8.9, 29.0, 0.9), listOf(r.visceralFat, r.bmr, r.fatFreeMass, r.subcutaneousFatPct, r.smi, r.bodyAge, r.whr))
        assertEquals(SegmentValue(0.8, 108.4), r.segmentFat?.leftArm)
        assertEquals(SegmentValue(0.7, 99.1), r.segmentFat?.rightArm)
        assertEquals(SegmentValue(7.0, 151.3), r.segmentFat?.trunk)
        assertEquals(SegmentValue(2.3, 127.5), r.segmentFat?.rightLeg)
        assertEquals(SegmentValue(25.1, 101.4), r.segmentMuscle?.trunk)
        assertEquals(SegmentValue(3.3, 105.9), r.segmentMuscle?.rightArm)
        assertEquals(Segments(327.9, 305.4, 20.6, 262.7, 243.1), r.impedance?.get(20))
        assertEquals(Segments(284.3, 262.0, 18.1, 226.4, 208.5), r.impedance?.get(100))
        assertTrue(result.uploadable)
    }

    @Test
    fun `逐格识别的报告全部读出且校验通过`() = assertReal(ReportParser.parse(fixture(), 1410f))

    @Test
    fun `行名和读数合成一行也能读`() = assertReal(ReportParser.parse(fixture(merged = true), 1410f))

    /** 调试版导出的 files/last-ocr.json（`{"width":…,"lines":[{"text":…,"box":[l,t,r,b]}]}`）。 */
    private fun dump(name: String): Pair<List<OcrLine>, Float> {
        val q = '"'
        val text = javaClass.getResource("/$name")!!.readText()
        val width = text.substringAfter("${q}width$q:").substringBefore(",").toFloat()
        val lines = text.split("{${q}text$q:$q").drop(1).map { chunk ->
            val head = "$q,${q}box$q:["
            val box = chunk.substringAfter(head).substringBefore("]").split(",").map { it.trim().toFloat() }
            OcrLine(chunk.substringBefore(head), box[0], box[1], box[2], box[3])
        }
        return lines to width
    }

    /**
     * 真实 ML Kit 输出：tools/report-replica.py 画的近似报告在模拟器上识别后由调试版导出（不是 FitDays+ 原图）。
     * 里面有实测的读错：「身休得分」「体重挖制」「目标休重」「肌內均衝」、行首「|」、「76/100分」读成「76n00」、「101.4°%」。
     * 导出后把读数换成了合成值，读错的地方照原样保留。
     */
    @Test
    fun `模拟器上 ML Kit 的真实识别结果（含形近字与符号读错）`() {
        val (lines, width) = dump("mlkit-replica-ocr.json")
        assertEquals(204, lines.size)
        assertReal(ReportParser.parse(lines, width))
    }

    /**
     * 真机（一加 13 / ColorOS）上识别 FitDays+ 分享出来的真实报告（2480×3508），调试版导出后把 ID 换成测试值、读数换成合成值，版式和读错的方式照原样保留。
     * 实测读错：「年齡」繁体、「身体咸分分析」、得分读成「791o0分」（「/1」→「1」、「0」→「o」）、分段比例丢了小数点读成「1493%」。
     */
    @Test
    fun `真机上 FitDays+ 原图的识别结果`() {
        val (lines, width) = dump("mlkit-real-report-ocr.json")
        assertEquals(245, lines.size)
        val result = ReportParser.parse(lines, width)
        assertEquals(emptyList(), result.problems)
        val r = assertNotNull(result.report)
        assertEquals(LocalDateTime.of(2026, 9, 16, 9, 13), r.measuredAt)
        assertEquals(30, r.age)
        assertEquals(175.0, r.heightCm)
        assertEquals(79.0, r.bodyScore)
        assertEquals(Measured(71.85, 56.7, 76.6), r.weight)
        assertEquals(Measured(13.8, 8.0, 16.2), r.bodyFat)
        assertEquals(19.2, r.bodyFatPct)
        assertEquals(Measured(3.9, 3.2, 4.0), r.boneMass)
        assertEquals(Measured(11.7, 9.7, 12.3), r.protein)
        assertEquals(Measured(42.4, 35.9, 44.6), r.bodyWater)
        assertEquals(Measured(54.1, 45.8, 57.0), r.muscle)
        assertEquals(Measured(32.5, 28.5, 34.9), r.skeletalMuscle)
        assertEquals(listOf(5.4, 16.3, 59.0, 75.3, 45.2), listOf(r.boneMassPct, r.proteinPct, r.bodyWaterPct, r.musclePct, r.skeletalMusclePct))
        assertEquals(23.5, r.bmi)
        assertEquals(106.0, r.obesityDegreePct)
        assertEquals(listOf(68.0, -3.9, -3.9, 0.0), listOf(r.targetWeight, r.weightControl, r.fatControl, r.muscleControl))
        assertEquals(listOf(5.0, 1605.0, 58.1, 14.0, 8.8, 28.0, 0.9), listOf(r.visceralFat, r.bmr, r.fatFreeMass, r.subcutaneousFatPct, r.smi, r.bodyAge, r.whr))
        assertEquals(SegmentValue(0.8, 106.9), r.segmentFat?.leftArm)
        assertEquals(SegmentValue(0.7, 98.3), r.segmentFat?.rightArm)
        // 报告上是 149.3%，OCR 丢了小数点读成「1493%」
        assertEquals(SegmentValue(6.8, 149.3), r.segmentFat?.trunk)
        assertEquals(SegmentValue(2.2, 127.4), r.segmentFat?.leftLeg)
        assertEquals(SegmentValue(2.2, 126.8), r.segmentFat?.rightLeg)
        assertEquals(SegmentValue(3.2, 102.9), r.segmentMuscle?.leftArm)
        assertEquals(SegmentValue(25.0, 101.1), r.segmentMuscle?.trunk)
        assertEquals(SegmentValue(9.4, 105.3), r.segmentMuscle?.rightLeg)
        assertEquals(Segments(325.2, 307.6, 21.0, 279.4, 258.7), r.impedance?.get(20))
        assertEquals(Segments(284.8, 266.1, 18.4, 239.2, 221.9), r.impedance?.get(100))
        assertTrue(result.uploadable)
    }

    @Test
    fun `分享图缩放后按比例读`() {
        val half = fixture().map { OcrLine(it.text, it.left / 2, it.top / 2, it.right / 2, it.bottom / 2) }
        assertReal(ReportParser.parse(half, 705f))
    }

    @Test
    fun `小数点读丢按固定位数还原`() {
        // 报告里的质量固定一位小数，「141」只可能是 14.1，还原后交叉校验照常通过
        val result = ReportParser.parse(fixture(fatValue = "141 (8.0-16.2)"), 1410f)
        assertEquals(emptyList(), result.problems)
        assertEquals(14.1, assertNotNull(result.report).bodyFat.value)
    }

    @Test
    fun `数字本身读错时交叉校验拦下，不许上传`() {
        // 还原不了的那类错：位数没问题、数值错了，只能靠报告内部的算术关系发现
        val result = ReportParser.parse(fixture(fatValue = "15.1 (8.0-16.2)"), 1410f)
        assertFalse(result.uploadable)
        assertTrue(result.problems.any { it.startsWith("体脂 15.1 kg") }, result.problems.toString())
        assertTrue(result.problems.any { it.startsWith("去脂体重") }, result.problems.toString())
    }

    @Test
    fun `阻抗少一格或大小关系反了都拦下`() {
        val short = ReportParser.parse(fixture().filterNot { it.text == "20.6" }, 1410f)
        assertNull(short.report)
        assertTrue(short.problems.contains("没认出20kHz 阻抗的五个部位"), short.problems.toString())

        val swapped = ReportParser.parse(fixture(impedance20 = listOf("216.3", "327.9", "20.6", "243.1", "262.7")), 1410f)
        assertFalse(swapped.uploadable)
        assertTrue(swapped.problems.any { it.contains("right_arm") }, swapped.problems.toString())
    }

    @Test
    fun `不是报告的图片直接说明`() {
        val result = ReportParser.parse(listOf(L("今天天气不错", 10, 10, 200, 40)), 1080f)
        assertNull(result.report)
        assertEquals(listOf("这不像 FitDays+ 的人体成分分析报告，或者图片不清楚"), result.problems)
    }

    @Test
    fun `上传 JSON 只有数字，字段名与服务端 schema 一致`() {
        val report = assertNotNull(ReportParser.parse(fixture(), 1410f).report)
        val json = report.toIngestJson(1_789_476_180_000)
        assertTrue(json.startsWith("{\"measured_minute_ms\":1789476180000,\"height_cm\":175,\"age\":30,"), json)
        assertTrue("\"weight_kg\":{\"value\":72.4,\"min\":56.7,\"max\":76.6}" in json, json)
        assertTrue("\"impedance_ohm\":{\"khz_20\":{\"left_arm\":327.9,\"right_arm\":305.4," in json, json)
        assertTrue("\"segment_fat\":{\"left_arm\":{\"kg\":0.8,\"pct\":108.4}" in json, json)
        assertFalse(Regex("\"[^\"]*\":\"").containsMatchIn(json), "不应出现字符串值：$json")
        // 与服务端测试共用的契约夹具：tests/ingest.test.ts 把它原样 POST 给 /ingest/health-connect
        assertEquals(java.io.File("../../tests/fixtures/android-report.json").readText().replace(Regex("\\s"), ""), json)
    }

    private companion object {
        val IMP20 = listOf("305.4", "327.9", "20.6", "243.1", "262.7")
    }
}
