package click.erikaalk.kinetrail.hc.calendar

import org.junit.Assert.assertEquals
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
        assertTrue(evening.notes!!.contains("平均心率"))
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
    fun `体测指标按固定顺序命名并带单位`() {
        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        val measurement = day.measurements.single()
        assertEquals(22, measurement.measuredAt!!.hour)
        assertEquals(
            listOf(
                "体重" to "63.1 kg",
                "体脂率" to "19 %",
                "脂肪量" to "11.99 kg",
                "去脂体重" to "51.11 kg",
                "BMI" to "23.5",
            ),
            metricRows(measurement.metrics),
        )
    }

    @Test
    fun `没见过的指标按原键名排在后面，不会丢`() {
        val rows = metricRows(mapOf("weight_kg" to 63.1, "zz_new_metric" to 7.0))
        assertEquals(listOf("体重" to "63.1 kg", "zz_new_metric" to "7"), rows)
    }

    @Test
    fun `逐组描述合并相同负重，有氧给时长和距离`() {
        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        val entries = day.sessions[1].entries
        assertEquals("45 kg × 12、10", describeSets(entries[0].sets))
        assertEquals("20 分钟 · 3 km", describeSets(entries[1].sets))

        // 负重变了就另起一段；缺次数的组不编造次数
        val mixed = listOf(
            TrainingSet(loadValue = 45.0, loadUnit = "kg", reps = 12),
            TrainingSet(loadValue = 45.0, loadUnit = "kg", reps = 12),
            TrainingSet(loadValue = 50.0, loadUnit = "kg", reps = 8),
            TrainingSet(loadValue = 50.0, loadUnit = "kg"),
        )
        assertEquals("45 kg × 12、12；50 kg × 8；50 kg", describeSets(mixed))
        assertEquals("1 组", describeSets(listOf(TrainingSet())))
        assertEquals("", describeSets(emptyList()))
    }

    @Test
    fun `会话抬头只列填了的项`() {
        val day = range.days.getValue(LocalDate.of(2026, 9, 14))
        assertEquals("1 小时 · 181 千卡 · RPE 7.5", sessionSummary(day.sessions[1]))
        assertEquals("1 小时", sessionSummary(range.days.getValue(LocalDate.of(2026, 9, 16)).sessions[0]))
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
        assertEquals("63.1", num(63.1))
        assertEquals("19", num(19.0))
        assertEquals("100", num(100.0))
        assertEquals("11.99", num(11.989))
        assertEquals("0", num(0.0))
        assertEquals("420", kcalLabel(420.4))
        assertEquals("181", kcalLabel(180.5))
    }
}
