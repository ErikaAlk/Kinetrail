package click.erikaalk.kinetrail.hc.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.YearMonth

/**
 * 解析与格式化的单测。读的是服务端测试写死的那份响应（`tests/fixtures/calendar-response.json`），
 * 服务端改了字段而这里没跟上时，两边的测试会一起红。
 */
class CalendarDataTest {

    private val range = parseCalendar(File("../../tests/fixtures/calendar-response.json").readText())

    @Test
    fun `按日期取到当天的训练与体测`() {
        assertEquals(setOf(LocalDate.of(2026, 9, 14), LocalDate.of(2026, 9, 16)), range.days.keys)
        assertEquals(false, range.truncated)

        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        assertEquals(500.5, day.caloriesKcal!!, 1e-9)
        assertEquals(2, day.sessions.size)

        val evening = day.sessions[1]
        assertEquals("finalized", evening.status)
        assertEquals(19, evening.startedAt!!.hour)
        assertEquals(3600, evening.durationSeconds)
        assertEquals(180.5, evening.caloriesKcal!!, 1e-9)
        assertEquals(7.5, evening.overallRpe!!, 1e-9)
        assertNull(evening.facility)
        assertEquals(listOf("高位下拉", "跑步机"), evening.entries.map { it.name })
        assertEquals("器械A", evening.entries[0].equipment)
        assertNull(evening.entries[1].equipment)
        assertEquals(45.0, evening.entries[0].sets[0].loadValue!!, 1e-9)
        assertEquals(12, evening.entries[0].sets[0].reps)
        assertEquals(1200, evening.entries[1].sets[0].durationSeconds)
    }

    @Test
    fun `没有热量的一天仍然有训练`() {
        val day = range.days.getValue(LocalDate.of(2026, 9, 16))
        assertNull(day.caloriesKcal)
        assertEquals(1, day.sessions.size)
        assertTrue(day.measurements.isEmpty())
    }

    @Test
    fun `体测指标分组命名，数值和单位分开，体重不在组里`() {
        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        val measurement = day.measurements.single()
        assertEquals(22, measurement.measuredAt!!.hour)
        assertEquals(
            listOf(
                MetricGroup(null, listOf(MetricRow("体脂率", Reading("21", "%")), MetricRow("BMI", Reading("22.9", "")))),
                MetricGroup("脂肪", listOf(MetricRow("脂肪量", Reading("14.74", "kg")))),
                MetricGroup("肌肉与骨骼", listOf(MetricRow("去脂体重", Reading("55.46", "kg")))),
            ),
            metricGroups(measurement.metrics),
        )
        assertTrue(hasBiaMetrics(measurement.metrics))
    }

    @Test
    fun `没见过的指标按原键名排在其他读数最后，不会丢，也不猜单位`() {
        val groups = metricGroups(mapOf("weight_kg" to 70.2, "zz_new_metric" to 7.0, "whr" to 0.82))
        assertEquals(
            listOf(MetricGroup("其他读数", listOf(MetricRow("腰臀比", Reading("0.82", "")), MetricRow("zz_new_metric", Reading("7", ""))))),
            groups,
        )
    }

    @Test
    fun `每个已知指标恰好属于一组`() {
        val grouped = METRIC_GROUPS.flatMap { it.second }
        assertEquals(grouped.size, grouped.toSet().size)
        assertEquals(METRIC_LABELS.keys, grouped.toSet())
    }

    @Test
    fun `只有体重、BMI、心率这类非阻抗读数时不算 BIA`() {
        assertFalse(hasBiaMetrics(mapOf("weight_kg" to 70.2, "bmi" to 22.0, "heart_rate_bpm" to 70.0, "zz_new_metric" to 1.0)))
        assertTrue(hasBiaMetrics(mapOf("weight_kg" to 70.2, "body_water_pct" to 52.0)))
    }

    @Test
    fun `逐组表格只列填过的字段，相邻的相同组合成一行`() {
        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        val entries = day.sessions[1].entries
        assertEquals(
            SetTable(listOf("负重", "次数"), listOf(SetRow(1, listOf("45 kg", "12")), SetRow(1, listOf("45 kg", "10")))),
            setTable(entries[0].sets),
        )
        assertEquals(SetTable(listOf("时长", "距离"), listOf(SetRow(1, listOf("20 分钟", "3 km")))), setTable(entries[1].sets))

        // 负重和次数都一样的相邻组合并；隔了别的组的不合并，顺序不乱
        val leg = TrainingSet(loadValue = 50.0, loadUnit = "kg", reps = 12)
        val dip = TrainingSet(loadValue = 25.0, loadUnit = "kg", reps = 12)
        assertEquals(
            listOf(SetRow(3, listOf("50 kg", "12")), SetRow(1, listOf("25 kg", "12")), SetRow(1, listOf("50 kg", "12"))),
            setTable(listOf(leg, leg, leg, dip, leg)).rows,
        )
        // 同一负重同一次数、但单位不同不算一样
        assertEquals(2, setTable(listOf(leg, leg.copy(loadUnit = "lb"))).rows.size)

        // 带时长的那组多一列，和不带时长的组不合并，字段不丢
        val timed = listOf(
            TrainingSet(loadValue = 10.0, loadUnit = "kg", reps = 12),
            TrainingSet(loadValue = 10.0, loadUnit = "kg", reps = 12, durationSeconds = 90),
        )
        assertEquals(
            SetTable(
                listOf("负重", "次数", "时长"),
                listOf(SetRow(1, listOf("10 kg", "12", null)), SetRow(1, listOf("10 kg", "12", "1 分 30 秒"))),
            ),
            setTable(timed),
        )

        // 只有次数时没有负重列；0 kg 照实写；没给单位不补 kg
        assertEquals(
            SetTable(listOf("次数"), listOf(SetRow(1, listOf("12")), SetRow(1, listOf("10")))),
            setTable(listOf(TrainingSet(reps = 12), TrainingSet(reps = 10))),
        )
        assertEquals(listOf(SetRow(1, listOf("0 kg", "15"))), setTable(listOf(TrainingSet(loadValue = 0.0, loadUnit = "kg", reps = 15))).rows)
        assertEquals(listOf(SetRow(1, listOf("20"))), setTable(listOf(TrainingSet(loadValue = 20.0))).rows)
        assertEquals(SetTable(emptyList(), emptyList()), setTable(emptyList()))
    }

    @Test
    fun `时长不换算小时也不舍秒，抬头统计缺项不占位`() {
        assertEquals(listOf(Reading("77", "分钟")), durationReadings(4620))
        assertEquals(listOf(Reading("1", "分"), Reading("30", "秒")), durationReadings(90))
        assertEquals(listOf(Reading("45", "秒")), durationReadings(45))

        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        assertEquals(
            listOf(
                SessionStat("时长", listOf(Reading("60", "分钟"))),
                SessionStat("消耗", listOf(Reading("181", "千卡"))),
                SessionStat("RPE", listOf(Reading("7.5", ""))),
            ),
            sessionStats(day.sessions[1]),
        )
        assertEquals(listOf("时长"), sessionStats(range.days.getValue(LocalDate.of(2026, 9, 16)).sessions[0]).map { it.label })
    }

    @Test
    fun `月视图按周一开头补齐整周`() {
        // 2026-09-01 是周二，所以前面空一格
        val september = monthGrid(YearMonth.of(2026, 9))
        assertEquals(35, september.size)
        assertNull(september[0])
        assertEquals(LocalDate.of(2026, 9, 1), september[1])
        assertEquals(LocalDate.of(2026, 9, 30), september[30])
        assertNull(september[31])
        assertNull(september[34])

        // 2026-02-01 是周日，28 天：前面空 6 格，正好 5 周
        val february = monthGrid(YearMonth.of(2026, 2))
        assertEquals(35, february.size)
        assertEquals(LocalDate.of(2026, 2, 1), february[6])
        assertEquals(LocalDate.of(2026, 2, 28), february[33])
    }

    @Test
    fun `数值去掉多余的零，整数不被截断`() {
        assertEquals("70.2", num(70.2))
        assertEquals("19", num(19.0))
        assertEquals("100", num(100.0))
        assertEquals("11.99", num(11.989))
        assertEquals("0", num(0.0))
        assertEquals("420", kcalLabel(420.4))
        assertEquals("181", kcalLabel(180.5))
    }
}
