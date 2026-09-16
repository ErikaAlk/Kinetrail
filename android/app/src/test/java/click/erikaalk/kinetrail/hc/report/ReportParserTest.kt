package click.erikaalk.kinetrail.hc.report

import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 夹具按 2026-09-15 20:43 那份 FitDays+ 报告（1410 像素宽）的版式逐格摆放，读数与 tests/ingest.test.ts 的 REPORT 相同，
 * ID 换成了测试值。每个单元格一行，是 ML Kit 在大间距表格上的常见分法；另有合并成一行、整体缩放两种变体。
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

    private fun fixture(merged: Boolean = false, fatValue: String = "12.3 (7.1-14.2)", impedance20: List<String> = IMP20): List<OcrLine> = buildList {
        add(L("人体成分分析报告", 48, 40, 425, 90))
        add(L("ID:Test-1", 140, 112, 238, 138)); add(L("性别:男", 368, 112, 438, 138))
        add(L("年龄:19", 569, 112, 638, 138)); add(L("身高:164cm", 769, 112, 880, 138))
        add(L("检测时间:2026/09/15 20:43", 1011, 112, 1271, 138))

        add(L("身体成分分析", 48, 162, 204, 190))
        add(L("测量(kg)", 368, 208, 440, 232)); add(L("重量比例(%)", 578, 208, 680, 232)); add(L("评估", 765, 208, 800, 232))
        val rows = listOf(
            Triple("体重", "63.90 (50.3-68.0)", "100.0"), Triple("体脂", fatValue, "19.3"),
            Triple("骨重量", "3.5 (2.9-3.6)", "5.5"), Triple("蛋白质", "10.4 (8.6-10.8)", "16.2"),
            Triple("身体水份", "37.8 (31.6-39.4)", "59.2"), Triple("肌肉", "48.2 (40.3-50.2)", "75.4"),
            Triple("骨骼肌率", "28.9 (25.1-30.7)", "45.3"),
        )
        rows.forEachIndexed { i, (label, value, pct) ->
            val y = 248 + i * 39
            if (merged) add(L("$label $value $pct 标准", 60, y, 802, y + 24)) else addAll(compositionRow(label, value, pct, y))
        }

        add(L("身体得分", 915, 162, 1020, 190))
        add(L("77", 920, 220, 995, 275)); add(L("/100分", 995, 235, 1100, 272))
        add(L("*总分反映了身体成分的评估值。", 915, 300, 1120, 318)); add(L("肌肉发达的人可能会得到100分以上。", 915, 322, 1180, 340))
        add(L("体重控制", 915, 375, 1020, 405))
        addAll(rightRow("目标体重", "60.5 kg", 432)); addAll(rightRow("体重控制", "-3.4 kg", 475))
        addAll(rightRow("脂肪控制", "-3.4 kg", 518)); addAll(rightRow("肌肉控制", "0.0 kg", 561))

        add(L("肌肉脂肪分析", 48, 532, 204, 560))
        add(L("体重(kg)", 60, 627, 138, 652)); add(L("55", 258, 624, 274, 638)); add(L("63.90", 468, 640, 518, 660))
        add(L("肥胖分析", 48, 797, 152, 825))
        add(L("BMI(kg/m²)", 60, 892, 170, 918)); add(L("10.0", 255, 888, 280, 902)); add(L("23.8", 472, 904, 512, 926))

        add(L("肥胖评估", 915, 622, 1020, 652))
        add(L("BMI", 925, 672, 958, 690)); add(L("23.8", 1066, 697, 1097, 714)); add(L("偏瘦", 955, 728, 987, 746))
        add(L("体脂率", 925, 778, 972, 796)); add(L("19.3", 1068, 798, 1097, 815))
        add(L("肥胖(当前体重/目标体重)", 925, 880, 1107, 898)); add(L("107%", 1118, 901, 1157, 917)); add(L("正常", 1125, 930, 1157, 948))
        add(L("体型评估", 915, 1002, 1020, 1032)); add(L("25.0", 921, 1147, 955, 1165)); add(L("匀称型", 1182, 1245, 1248, 1270))
        add(L("20.0", 1247, 1462, 1280, 1478))

        add(L("分段脂肪分析", 48, 1008, 204, 1036)); add(L("肌肉均衡", 495, 1008, 598, 1036))
        addAll(segmentBlock(48, 395, listOf("0.6kg" to "103.8%", "0.5kg" to "95.6%", "6.1kg" to "162.6%", "2.0kg" to "134.6%", "2.0kg" to "134.7%")))
        addAll(segmentBlock(495, 842, listOf("2.8kg" to "101.7%", "2.9kg" to "104.3%", "22.4kg" to "100.2%", "8.3kg" to "106.5%", "8.3kg" to "106.5%")))
        add(L("标准范围: 80%-160%", 48, 1496, 206, 1512)); add(L("节段脂肪分析为推断值", 48, 1516, 212, 1532))
        add(L("标准范围:", 495, 1496, 565, 1512)); add(L("左右上肢 (80%-115%)", 495, 1516, 646, 1532))

        add(L("生物电阻抗", 48, 1562, 178, 1590))
        add(L("Z(Ω)", 60, 1614, 104, 1640))
        listOf("右臂", "左臂", "躯干", "右腿", "左腿").forEachIndexed { i, h -> add(L(h, 285 + i * 128 - 21, 1614, 285 + i * 128 + 21, 1640)) }
        addAll(impedanceRow("20(kHz)", impedance20, 1664))
        addAll(impedanceRow("100(kHz)", listOf("271.7", "294.7", "18.7", "217.8", "236.9"), 1712))
        add(L("分析和建议", 48, 1765, 178, 1795)); add(L("体型适中，不胖不瘦，体成分均衡，继续保持。", 48, 1815, 860, 1840))

        add(L("其它指标", 915, 1540, 1020, 1570))
        addAll(rightRow("内脏脂肪等级", "4", 1598)); addAll(rightRow("基础代谢率", "1484 千卡", 1641))
        addAll(rightRow("去脂体重", "51.7 kg", 1685)); addAll(rightRow("皮下脂肪", "13.8 %", 1727))
        addAll(rightRow("SMI", "8.3 kg/m²", 1768)); addAll(rightRow("身体年龄", "18", 1812)); addAll(rightRow("腰臀比", "0.8", 1855))
    }.shuffled(java.util.Random(7))

    private fun assertReal(result: ParseResult) {
        assertEquals(emptyList(), result.problems)
        val r = assertNotNull(result.report)
        assertEquals(LocalDateTime.of(2026, 9, 15, 20, 43), r.measuredAt)
        assertEquals(19, r.age)
        assertEquals(164.0, r.heightCm)
        assertEquals(77.0, r.bodyScore)
        assertEquals(Measured(63.9, 50.3, 68.0), r.weight)
        assertEquals(Measured(12.3, 7.1, 14.2), r.bodyFat)
        assertEquals(19.3, r.bodyFatPct)
        assertEquals(Measured(28.9, 25.1, 30.7), r.skeletalMuscle)
        assertEquals(45.3, r.skeletalMusclePct)
        assertEquals(23.8, r.bmi)
        assertEquals(107.0, r.obesityDegreePct)
        assertEquals(listOf(60.5, -3.4, -3.4, 0.0), listOf(r.targetWeight, r.weightControl, r.fatControl, r.muscleControl))
        assertEquals(listOf(4.0, 1484.0, 51.7, 13.8, 8.3, 18.0, 0.8), listOf(r.visceralFat, r.bmr, r.fatFreeMass, r.subcutaneousFatPct, r.smi, r.bodyAge, r.whr))
        assertEquals(SegmentValue(0.6, 103.8), r.segmentFat?.leftArm)
        assertEquals(SegmentValue(0.5, 95.6), r.segmentFat?.rightArm)
        assertEquals(SegmentValue(6.1, 162.6), r.segmentFat?.trunk)
        assertEquals(SegmentValue(2.0, 134.7), r.segmentFat?.rightLeg)
        assertEquals(SegmentValue(22.4, 100.2), r.segmentMuscle?.trunk)
        assertEquals(SegmentValue(2.9, 104.3), r.segmentMuscle?.rightArm)
        assertEquals(Segments(338.0, 316.3, 21.2, 275.6, 254.8), r.impedance?.get(20))
        assertEquals(Segments(294.7, 271.7, 18.7, 236.9, 217.8), r.impedance?.get(100))
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
     * 里面有实测的读错：「身休得分」「体重挖制」「目标休重」「肌內均衝」、行首「|」、「77/100分」读成「77n00」、「100.2°%」。
     */
    @Test
    fun `模拟器上 ML Kit 的真实识别结果（含形近字与符号读错）`() {
        val (lines, width) = dump("mlkit-replica-ocr.json")
        assertEquals(204, lines.size)
        assertReal(ReportParser.parse(lines, width))
    }

    /**
     * 真机（一加 13 / ColorOS）上识别 FitDays+ 分享出来的真实报告（2480×3508），调试版导出后只把 ID 换成测试值。
     * 实测读错：「年齡」繁体、「身体咸分分析」、「78/100分」读成「781o0分」、分段的「157.7%」丢了小数点读成「1577%」。
     */
    @Test
    fun `真机上 FitDays+ 原图的识别结果`() {
        val (lines, width) = dump("mlkit-real-report-ocr.json")
        assertEquals(245, lines.size)
        val result = ReportParser.parse(lines, width)
        assertEquals(emptyList(), result.problems)
        val r = assertNotNull(result.report)
        assertEquals(LocalDateTime.of(2026, 9, 16, 9, 13), r.measuredAt)
        assertEquals(19, r.age)
        assertEquals(164.0, r.heightCm)
        assertEquals(78.0, r.bodyScore)
        assertEquals(Measured(63.35, 50.3, 68.0), r.weight)
        assertEquals(Measured(12.0, 7.1, 14.2), r.bodyFat)
        assertEquals(18.9, r.bodyFatPct)
        assertEquals(Measured(3.4, 2.9, 3.6), r.boneMass)
        assertEquals(Measured(10.3, 8.6, 10.8), r.protein)
        assertEquals(Measured(37.6, 31.6, 39.4), r.bodyWater)
        assertEquals(Measured(47.9, 40.3, 50.2), r.muscle)
        assertEquals(Measured(28.8, 25.1, 30.7), r.skeletalMuscle)
        assertEquals(listOf(5.4, 16.2, 59.4, 75.6, 45.4), listOf(r.boneMassPct, r.proteinPct, r.bodyWaterPct, r.musclePct, r.skeletalMusclePct))
        assertEquals(23.6, r.bmi)
        assertEquals(107.0, r.obesityDegreePct)
        assertEquals(listOf(60.3, -3.0, -3.0, 0.0), listOf(r.targetWeight, r.weightControl, r.fatControl, r.muscleControl))
        assertEquals(listOf(4.0, 1479.0, 51.3, 13.5, 8.2, 17.0, 0.8), listOf(r.visceralFat, r.bmr, r.fatFreeMass, r.subcutaneousFatPct, r.smi, r.bodyAge, r.whr))
        assertEquals(SegmentValue(0.6, 102.2), r.segmentFat?.leftArm)
        assertEquals(SegmentValue(0.5, 94.7), r.segmentFat?.rightArm)
        // 报告上是 157.7%，OCR 丢了小数点读成「1577%」
        assertEquals(SegmentValue(5.9, 157.7), r.segmentFat?.trunk)
        assertEquals(SegmentValue(1.9, 130.6), r.segmentFat?.leftLeg)
        assertEquals(SegmentValue(1.9, 130.4), r.segmentFat?.rightLeg)
        assertEquals(SegmentValue(2.8, 101.2), r.segmentMuscle?.leftArm)
        assertEquals(SegmentValue(22.3, 100.1), r.segmentMuscle?.trunk)
        assertEquals(SegmentValue(8.3, 106.1), r.segmentMuscle?.rightLeg)
        assertEquals(Segments(336.5, 318.9, 21.7, 290.9, 271.5), r.impedance?.get(20))
        assertEquals(Segments(295.6, 276.3, 19.1, 248.9, 230.5), r.impedance?.get(100))
        assertTrue(result.uploadable)
    }

    @Test
    fun `分享图缩放后按比例读`() {
        val half = fixture().map { OcrLine(it.text, it.left / 2, it.top / 2, it.right / 2, it.bottom / 2) }
        assertReal(ReportParser.parse(half, 705f))
    }

    @Test
    fun `小数点读丢按固定位数还原`() {
        // 报告里的质量固定一位小数，「123」只可能是 12.3，还原后交叉校验照常通过
        val result = ReportParser.parse(fixture(fatValue = "123 (7.1-14.2)"), 1410f)
        assertEquals(emptyList(), result.problems)
        assertEquals(12.3, assertNotNull(result.report).bodyFat.value)
    }

    @Test
    fun `数字本身读错时交叉校验拦下，不许上传`() {
        // 还原不了的那类错：位数没问题、数值错了，只能靠报告内部的算术关系发现
        val result = ReportParser.parse(fixture(fatValue = "13.3 (7.1-14.2)"), 1410f)
        assertFalse(result.uploadable)
        assertTrue(result.problems.any { it.startsWith("体脂 13.3 kg") }, result.problems.toString())
        assertTrue(result.problems.any { it.startsWith("去脂体重") }, result.problems.toString())
    }

    @Test
    fun `阻抗少一格或大小关系反了都拦下`() {
        val short = ReportParser.parse(fixture().filterNot { it.text == "21.2" }, 1410f)
        assertNull(short.report)
        assertTrue(short.problems.contains("没认出20kHz 阻抗的五个部位"), short.problems.toString())

        val swapped = ReportParser.parse(fixture(impedance20 = listOf("216.3", "338.0", "21.2", "254.8", "275.6")), 1410f)
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
        assertTrue(json.startsWith("{\"measured_minute_ms\":1789476180000,\"height_cm\":164,\"age\":19,"), json)
        assertTrue("\"weight_kg\":{\"value\":63.9,\"min\":50.3,\"max\":68}" in json, json)
        assertTrue("\"impedance_ohm\":{\"khz_20\":{\"left_arm\":338,\"right_arm\":316.3," in json, json)
        assertTrue("\"segment_fat\":{\"left_arm\":{\"kg\":0.6,\"pct\":103.8}" in json, json)
        assertFalse(Regex("\"[^\"]*\":\"").containsMatchIn(json), "不应出现字符串值：$json")
        // 与服务端测试共用的契约夹具：tests/ingest.test.ts 把它原样 POST 给 /ingest/health-connect
        assertEquals(java.io.File("../../tests/fixtures/android-report.json").readText().replace(Regex("\\s"), ""), json)
    }

    private companion object {
        val IMP20 = listOf("316.3", "338.0", "21.2", "254.8", "275.6")
    }
}
