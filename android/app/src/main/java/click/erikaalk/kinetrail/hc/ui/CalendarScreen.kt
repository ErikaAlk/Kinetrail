package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.coloroskit.coThemeColor
import click.erikaalk.coloroskit.components.CoAlertDialog
import click.erikaalk.coloroskit.components.CoBarAction
import click.erikaalk.coloroskit.components.CoBottomSheet
import click.erikaalk.coloroskit.components.CoButton
import click.erikaalk.coloroskit.components.CoButtonType
import click.erikaalk.coloroskit.components.CoCard
import click.erikaalk.coloroskit.components.CoCardPosition
import click.erikaalk.coloroskit.components.CoCardRow
import click.erikaalk.coloroskit.components.CoCategoryTitle
import click.erikaalk.coloroskit.components.CoDialogButton
import click.erikaalk.coloroskit.components.CoDialogButtonRole
import click.erikaalk.coloroskit.components.CoEmptyState
import click.erikaalk.coloroskit.components.CoListItem
import click.erikaalk.coloroskit.components.CoLoading
import click.erikaalk.coloroskit.components.CoPanelTitleBar
import click.erikaalk.coloroskit.components.CoTrailing
import click.erikaalk.coloroskit.components.LocalCoBottomSheetClose
import click.erikaalk.coloroskit.material.CoCapsuleShape
import click.erikaalk.coloroskit.material.CoPressMask
import click.erikaalk.coloroskit.material.CoSmoothShape
import click.erikaalk.coloroskit.tokens.CoTokens
import click.erikaalk.coloroskit.tokens.CoTypeStyle
import click.erikaalk.kinetrail.hc.calendar.BodyMeasurement
import click.erikaalk.kinetrail.hc.calendar.CalendarDay
import click.erikaalk.kinetrail.hc.calendar.MetricRow
import click.erikaalk.kinetrail.hc.calendar.Reading
import click.erikaalk.kinetrail.hc.calendar.SetTable
import click.erikaalk.kinetrail.hc.calendar.TrainingEntry
import click.erikaalk.kinetrail.hc.calendar.TrainingSession
import click.erikaalk.kinetrail.hc.calendar.hasBiaMetrics
import click.erikaalk.kinetrail.hc.calendar.kcalLabel
import click.erikaalk.kinetrail.hc.calendar.metricGroups
import click.erikaalk.kinetrail.hc.calendar.monthGrid
import click.erikaalk.kinetrail.hc.calendar.num
import click.erikaalk.kinetrail.hc.calendar.sessionStats
import click.erikaalk.kinetrail.hc.calendar.setTable
import java.time.LocalDate
import java.time.format.DateTimeFormatter

private val L = CoTokens.List
private val C = CoTokens.Color

/** 点开的是哪一张卡的详情面板。静默刷新后按这个键重新找，那张卡没了面板就收起。 */
private sealed interface Detail {
    data class Session(val date: LocalDate, val index: Int) : Detail

    /** [key] 是服务端的 record_id；旧记录没有时退回这一天里的序号。 */
    data class Measurement(val date: LocalDate, val key: Any) : Detail
}

private fun BodyMeasurement.key(index: Int): Any = recordId ?: index

/**
 * 训练日历：上半是月历卡片，下半是选中那天的训练和称重。卡片点开是详情面板（DESIGN §8：页面里不嵌套折叠）。
 *
 * 日期格里数字下面一行是标记：训练是活动波形图标，称重是体重秤图标，同一家族的线条图标靠轮廓区分。
 * 这一行没有标记也照样占位，同一周的数字才对得齐。当天热量（手表记录、随训练写入服务端）在详情的日期标题里。
 *
 * 数据全部来自服务端 `/app/calendar`，与 Health Connect 无关，也不会触发同步。
 * 取回的每个月在本机留一份，刷新期间照常显示那一份（见 MainActivity.loadCalendar）。
 * 切到这一页、回到前台时静默重读：已有数据时不转圈，转圈只出现在手动刷新、翻月和什么都还没有的时候。
 */
@Composable
fun CalendarScreen(state: AppState, actions: AppActions) {
    val today = remember { LocalDate.now() }
    val loaded = state.calendarLoadedMonth == state.month
    var detail by remember { mutableStateOf<Detail?>(null) }
    KtPage(
        Screen.Records.title,
        bottomExtra = TabBarRoom,
        actions = listOf(
            // 读取中转圈占刷新键的位置（DESIGN §11.2：在原位显示进度）
            if (state.calendarLoading) CoBarAction("正在读取", enabled = false, icon = { CoLoading() })
            else CoBarAction("刷新", onClick = { actions.showMonth(state.month) }, icon = { GlyphIcon(Glyph.Refresh, it) }),
        ),
    ) {
        GroupGap()
        CoCard(contentPadding = PaddingValues(bottom = L.paddingV)) {
            MonthHeader(state, actions)
            Weekdays()
            MonthGrid(state, actions, today)
            Legend()
        }
        if (loaded && state.calendarTruncated) Footer("这个月的记录超出一次能取回的上限，只显示了一部分")

        val error = state.calendarError
        val selected = state.selectedDate
        when {
            // 缺前提：说明怎么修并给修复按钮（DESIGN §11.3）
            !loaded && !state.tokenSaved -> CoEmptyState(
                "未设置推送令牌", subtitle = "保存令牌后才能读取训练和称重记录", actionText = "去设置",
                onAction = { actions.navigate(Screen.Settings) },
            )
            !loaded && error != null && !state.calendarLoading -> CoEmptyState(
                "无法读取记录", subtitle = error, actionText = "重试", onAction = { actions.showMonth(state.month) },
            )
            selected == null -> CoEmptyState("未选中日期")
            // 数据还没到（读取中）时不能说「无记录」，只留日期标题
            else -> DayDetail(selected, state.calendarDays[selected], loaded) { detail = it }
        }
    }

    when (val d = detail) {
        is Detail.Session -> {
            val session = state.calendarDays[d.date]?.sessions?.getOrNull(d.index)
            if (session == null) LaunchedEffect(d) { detail = null }
            else SessionSheet(session, onDismiss = { detail = null })
        }
        is Detail.Measurement -> {
            val measurement = state.calendarDays[d.date]?.measurements
                ?.withIndex()?.firstOrNull { (i, m) -> m.key(i) == d.key }?.value
            if (measurement == null) LaunchedEffect(d) { detail = null }
            else MeasurementSheet(
                measurement,
                deleting = measurement.recordId != null && measurement.recordId == state.deletingRecord,
                failure = state.deleteFailure?.takeIf { it.first == measurement.recordId }?.second,
                onDelete = measurement.recordId?.takeIf { measurement.deletable }?.let { id -> { actions.deleteMeasurement(id) } },
                onDismiss = {
                    detail = null
                    state.deleteFailure = null
                },
            )
        }
        null -> Unit
    }
}

@Composable
private fun MonthHeader(state: AppState, actions: AppActions) {
    Row(Modifier.fillMaxWidth().padding(start = L.paddingH, top = L.edgePadding), verticalAlignment = Alignment.CenterVertically) {
        BasicText(
            "${state.month.year}年${state.month.monthValue}月",
            Modifier.weight(1f).semantics { heading() },
            style = L.title.toTextStyle().copy(color = C.label1.current),
        )
        IconButton(Glyph.ChevronLeft, "上个月", onClick = { actions.showMonth(state.month.minusMonths(1)) })
        IconButton(Glyph.ChevronRight, "下个月", onClick = { actions.showMonth(state.month.plusMonths(1)) })
    }
}

@Composable
private fun Weekdays() {
    Row(Modifier.fillMaxWidth().padding(vertical = L.edgePadding)) {
        for (label in listOf("一", "二", "三", "四", "五", "六", "日")) {
            BasicText(
                label,
                Modifier.weight(1f),
                style = CoTokens.Type.bodyXS.toTextStyle().copy(color = C.label2.current, textAlign = TextAlign.Center),
            )
        }
    }
}

@Composable
private fun MonthGrid(state: AppState, actions: AppActions, today: LocalDate) {
    val cells = remember(state.month) { monthGrid(state.month) }
    Column(Modifier.fillMaxWidth()) {
        for (week in cells.chunked(7)) {
            // 同一周等高：大字号下某一格的标记换了行，选中底色也要和邻格一样高
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                for (date in week) {
                    Box(Modifier.weight(1f).fillMaxHeight()) {
                        if (date != null) {
                            DayCell(
                                date = date,
                                day = state.calendarDays[date],
                                selected = date == state.selectedDate,
                                today = date == today,
                                onClick = { actions.selectDate(date) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * 月历标记的边长：默认 14dp（DESIGN §13 行内小标记），跟着系统字号放大，2 倍字号到 16dp 为止。
 * 它是日期数字旁边的辅助图形，重量不能超过数字，所以不跟着字号无限长。
 */
@Composable
private fun markSize(): Dp = (14f + 2f * (LocalDensity.current.fontScale - 1f).coerceIn(0f, 1f)).dp

private val MarkStroke = 1.2.dp

private val CellShape = CoSmoothShape(CoTokens.Radius.m, CoTokens.Radius.weightCustom)

/**
 * 一个日期格。选中是主题色实底（这一屏唯一的主题色焦点，DESIGN §4）；今天是主题色数字加一道短线，选中时也在。
 * 数字下面一行放训练、称重两枚图标，空着也占位，同一周的数字才对得齐。
 * 读屏把整格读成一句（日期、今天、训练、未结束、热量、称重），不逐个读数字和图标。
 */
@Composable
private fun DayCell(date: LocalDate, day: CalendarDay?, selected: Boolean, today: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val kcal = day?.caloriesKcal
    val trained = day?.sessions?.isNotEmpty() == true
    val weighed = day?.measurements?.isNotEmpty() == true
    val open = day?.sessions?.any { it.status == "open" } == true
    val description = listOfNotNull(
        "${date.monthValue}月${date.dayOfMonth}日",
        "今天".takeIf { today },
        "训练".takeIf { trained },
        "有未结束训练".takeIf { open },
        kcal?.let { "已记录消耗 ${kcalLabel(it)} 千卡" },
        "称重".takeIf { weighed },
    ).joinToString("，")
    val onAccent = C.onPrimary.current
    val accentText = coThemeColor.primaryText.current

    Box(
        Modifier
            .fillMaxSize()
            .padding(L.edgePadding)
            .clip(CellShape)
            .background(if (selected) coThemeColor.primary.current else Color.Transparent)
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = description
                this.selected = selected
            }
            .defaultMinSize(minHeight = 48.dp),
    ) {
        CoPressMask(interaction, CellShape, L.pressMask, L.pressMaskMinProgress, Modifier.matchParentSize())
        Column(Modifier.fillMaxWidth().padding(vertical = L.edgePadding * 2), horizontalAlignment = Alignment.CenterHorizontally) {
            BasicText(
                "${date.dayOfMonth}",
                style = CoTokens.Type.bodyXL.toTextStyle().copy(
                    color = when {
                        selected -> onAccent
                        today -> accentText
                        else -> C.label1.current
                    },
                    fontWeight = if (today || selected) FontWeight(L.title.weight) else null,
                    fontFeatureSettings = "tnum",
                ),
            )
            // 今天的短线。别的日期画透明的同一条，同一周的数字和标记才在同一条线上
            Box(
                Modifier
                    .padding(top = L.edgePadding)
                    .size(width = 12.dp, height = L.edgePadding)
                    .clip(CoCapsuleShape)
                    .background(
                        when {
                            !today -> Color.Transparent
                            selected -> onAccent
                            else -> accentText
                        },
                    ),
            )
            // 标记行固定高度，空着也占；两枚图标整体居中，顺序固定训练在前
            val size = markSize()
            val markColor = if (selected) onAccent else C.label2.current
            Row(
                Modifier.padding(top = L.edgePadding).height(size),
                horizontalArrangement = Arrangement.spacedBy(L.edgePadding, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (trained) GlyphIcon(Glyph.Activity, markColor, size = size, stroke = MarkStroke)
                if (weighed) GlyphIcon(Glyph.Scale, markColor, size = size, stroke = MarkStroke)
            }
        }
    }
}

/** 月历下的图例，用的就是格子里那两枚图标。大字号下两项可以整体换行，图标和标签不拆开。 */
@Composable
private fun Legend() {
    val size = markSize()
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = L.paddingH).padding(top = L.categoryMarginV),
        horizontalArrangement = Arrangement.spacedBy(L.paddingH),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        for ((glyph, label) in listOf(Glyph.Activity to "训练", Glyph.Scale to "称重")) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(L.arrowGap)) {
                GlyphIcon(glyph, C.label2.current, size = size, stroke = MarkStroke)
                BasicText(label, style = CoTokens.Type.bodyXS.toTextStyle().copy(color = C.label2.current))
            }
        }
    }
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val WEEKDAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

/** 系统字号放大到这一档以上，横排的读数和表格改成竖排，不缩字也不截断。 */
private const val LARGE_FONT_SCALE = 1.3f

/** 等宽数字：不换系统字体，只让同一列的数字宽度一致。 */
@Composable
private fun CoTypeStyle.text(color: Color = C.label1.current): TextStyle =
    toTextStyle().copy(color = color, fontFeatureSettings = "tnum")

/**
 * 选中那天：日期标题（带当天热量），下面每次训练、每次称重一张卡，点开看详情。
 * 热量用服务端给的当天合计，不在手机上重新加；没写进来就明说，和 0 千卡分开。
 */
@Composable
private fun DayDetail(date: LocalDate, day: CalendarDay?, loaded: Boolean, onOpen: (Detail) -> Unit) {
    val kcal = day?.sessions?.takeIf { it.isNotEmpty() }?.let { day.caloriesKcal?.let { "已记录消耗 ${kcalLabel(it)} 千卡" } ?: "消耗未记录" }
    CoCategoryTitle(listOfNotNull("${date.monthValue}月${date.dayOfMonth}日 ${WEEKDAYS[date.dayOfWeek.value - 1]}", kcal).joinToString(" ｜ "))
    if (!loaded) return
    if (day == null || (day.sessions.isEmpty() && day.measurements.isEmpty())) {
        CoEmptyState("无记录")
        return
    }
    day.sessions.forEachIndexed { index, session ->
        if (index > 0) GroupGap()
        SessionCard(session, onClick = if (session.entries.isEmpty()) null else ({ onOpen(Detail.Session(date, index)) }))
    }
    day.measurements.forEachIndexed { index, measurement ->
        if (index > 0 || day.sessions.isNotEmpty()) GroupGap()
        MeasurementCard(measurement, onClick = { onOpen(Detail.Measurement(date, measurement.key(index))) })
    }
}

/** 一张可以点开详情的卡：卡片底色、按压蒙层、行尾箭头都是设计库的卡片行。[onClick] 为空时没有箭头、不能点。 */
@Composable
private fun EntryCard(onClick: (() -> Unit)?, content: @Composable ColumnScope.() -> Unit) {
    CoCardRow(CoCardPosition.Full, onClick = onClick, trailing = if (onClick != null) CoTrailing.Arrow else CoTrailing.None) {
        Column(Modifier.weight(1f).padding(vertical = L.edgePadding), content = content)
    }
}

/** 卡片抬头：左边名称，右边时间之类的元信息。 */
@Composable
private fun CardTitle(title: String, meta: List<String>) {
    Row {
        BasicText(title, Modifier.alignByBaseline().weight(1f), style = L.title.toTextStyle().copy(color = C.label1.current))
        if (meta.isNotEmpty()) BasicText(metaText(meta), Modifier.alignByBaseline(), style = L.summary.text(C.label2.current))
    }
}

/** 数值大、单位小，按基线对齐：「77 分钟」「1 分 30 秒」「71.85 kg」。 */
@Composable
private fun Readings(readings: List<Reading>, valueStyle: CoTypeStyle, modifier: Modifier = Modifier) {
    Row(modifier) {
        readings.forEachIndexed { index, reading ->
            BasicText(
                reading.value,
                Modifier.alignByBaseline().padding(start = if (index == 0) 0.dp else L.arrowGap),
                style = valueStyle.text(),
            )
            if (reading.unit.isNotEmpty()) {
                // % 紧贴数字，其余单位隔开（DESIGN §14）
                val gap = if (reading.unit == "%") 0.dp else L.arrowGap
                BasicText(reading.unit, Modifier.alignByBaseline().padding(start = gap), style = L.summary.text(C.label2.current))
            }
        }
    }
}

/** 标签在上、读数在下的一项。 */
@Composable
private fun LabeledReading(label: String, readings: List<Reading>, valueStyle: CoTypeStyle, modifier: Modifier = Modifier) {
    Column(modifier.semantics(mergeDescendants = true) {}) {
        BasicText(label, style = L.summary.text(C.label2.current))
        Readings(readings, valueStyle)
    }
}

/**
 * 一次训练：抬头是时间段，下面一排时长、消耗、RPE，再下面是场馆和动作名单。逐组表格在点开的面板里。
 * 会话和动作的备注不显示：那是写给模型看的上下文（单位说明、手表原话之类），服务端照样保存。
 */
@Composable
private fun SessionCard(session: TrainingSession, onClick: (() -> Unit)?) {
    // 补记的训练开始和结束是同一时刻，那样显示成「16:56–16:56」像坏了，只给一个时间。
    val span = listOfNotNull(session.startedAt?.format(TIME), session.endedAt?.format(TIME)).distinct().joinToString("–")
    EntryCard(onClick) {
        CardTitle("训练", listOfNotNull(span.ifEmpty { null }, "未结束".takeIf { session.status == "open" }))
        // 时长照服务端的 duration_seconds 显示，不拿起止时间去算或纠正
        val stats = sessionStats(session)
        if (stats.isNotEmpty()) {
            FlowRow(
                Modifier.padding(top = L.paddingV),
                horizontalArrangement = Arrangement.spacedBy(L.statusGap),
                verticalArrangement = Arrangement.spacedBy(L.paddingV),
            ) {
                stats.forEach { LabeledReading(it.label, it.readings, CoTokens.Type.headlineM) }
            }
        }
        val lines = listOfNotNull(
            session.facility,
            if (session.entries.isEmpty()) "未记录动作" else session.entries.joinToString("、") { it.name },
        )
        lines.forEach { BasicText(it, Modifier.padding(top = L.edgePadding * 2), style = L.summary.text(C.label2.current)) }
    }
}

/**
 * 一次称重。左边是体重，竖线右边竖排体脂率和 BMI；其余指标在点开的面板里。
 * 系统字号放大后改成上下排。只有体重时是一张紧凑卡。
 */
@Composable
private fun MeasurementCard(measurement: BodyMeasurement, onClick: () -> Unit) {
    val summary = metricGroups(measurement.metrics).firstOrNull { it.title == null }?.rows.orEmpty()
    val weight = measurement.metrics["weight_kg"]?.let { listOf(Reading(num(it), "kg")) }
    val large = LocalDensity.current.fontScale > LARGE_FONT_SCALE
    EntryCard(onClick) {
        CardTitle("称重", listOfNotNull(measurement.measuredAt?.format(TIME)))
        if (weight != null && summary.isNotEmpty() && !large) {
            Row(Modifier.padding(top = L.paddingV).height(IntrinsicSize.Min)) {
                LabeledReading("体重", weight, CoTokens.Type.headlineL, Modifier.weight(0.6f))
                Box(Modifier.padding(horizontal = L.paddingH).width(L.divider).fillMaxHeight().background(C.divider.current))
                Column(Modifier.weight(0.4f), verticalArrangement = Arrangement.spacedBy(L.edgePadding * 2)) {
                    summary.forEach { LabeledReading(it.label, listOf(it.reading), CoTokens.Type.headlineM) }
                }
            }
        } else {
            weight?.let { LabeledReading("体重", it, CoTokens.Type.headlineL, Modifier.padding(top = L.paddingV)) }
            summary.forEach { LabeledReading(it.label, listOf(it.reading), CoTokens.Type.headlineM, Modifier.padding(top = L.paddingV)) }
        }
    }
}

/** 面板里可滚动的正文：面板按内容高度展开，太长时在面板里滚。 */
@Composable
private fun SheetBody(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = L.listBottomPadding), content = content)
}

/** 一次训练的详情：每个动作一组，器械和逐组表格。 */
@Composable
private fun SessionSheet(session: TrainingSession, onDismiss: () -> Unit) {
    CoBottomSheet(onDismissRequest = onDismiss, grouped = true) {
        val close = LocalCoBottomSheetClose.current
        val span = listOfNotNull(session.startedAt?.format(TIME), session.endedAt?.format(TIME)).distinct().joinToString("–")
        CoPanelTitleBar(listOf("训练", span).filter { it.isNotEmpty() }.joinToString(" "), dismiss = CoBarAction("关闭", onClick = close, text = "关闭"))
        SheetBody {
            session.entries.forEach { EntryGroup(it) }
        }
    }
}

/** 一个动作：名字是分组标题，卡里是器械和逐组表格。 */
@Composable
private fun EntryGroup(entry: TrainingEntry) {
    CoCategoryTitle(entry.name)
    CoCard {
        // 器械和动作名一字不差时不重复写；「高位下拉1（偏重那台）」这种有区别的照写
        val equipment = entry.equipment?.takeIf { it != entry.name }
        equipment?.let { BasicText(it, Modifier.padding(bottom = L.paddingV), style = L.summary.text(C.label2.current)) }
        val table = setTable(entry.sets)
        when {
            table.columns.isNotEmpty() -> SetTableView(table)
            entry.sets.isNotEmpty() -> BasicText("${entry.sets.size} 组", style = CoTokens.Type.bodyM.text())
            equipment == null -> BasicText("未记录组数", style = L.summary.text(C.label2.current))
        }
    }
}

/** 列宽权重：组数窄，数据列等宽。同一个动作的每一行用同一套权重，上下才对得齐。 */
private const val INDEX_COLUMN_WEIGHT = 0.5f

/** 表格里的一格：右对齐；没填写「—」，读屏读「未记录」。 */
@Composable
private fun SetCell(text: String?, modifier: Modifier = Modifier) {
    BasicText(
        text ?: "—",
        if (text == null) modifier.semantics { contentDescription = "未记录" } else modifier,
        style = CoTokens.Type.bodyM.text(if (text == null) C.label3.current else C.label1.current).copy(textAlign = TextAlign.End),
    )
}

/**
 * 逐组表格：组数靠左，表头和数据右对齐，不画外框、竖线和逐行横线。相邻的相同组已合成一行，第一列是这一行代表几组。
 * 系统字号放大后改成逐行竖排，不缩字、不横向滚动。
 */
@Composable
private fun SetTableView(table: SetTable) {
    val label = L.summary.text(C.label2.current)
    if (LocalDensity.current.fontScale > LARGE_FONT_SCALE) {
        Column(verticalArrangement = Arrangement.spacedBy(L.paddingV)) {
            table.rows.forEach { row ->
                Column(Modifier.semantics(mergeDescendants = true) {}) {
                    BasicText("${row.count} 组", style = label)
                    table.columns.zip(row.cells).forEach { (name, cell) ->
                        Row(Modifier.padding(top = L.edgePadding)) {
                            BasicText(name, Modifier.weight(1f), style = CoTokens.Type.bodyM.text(C.label2.current))
                            SetCell(cell)
                        }
                    }
                }
            }
        }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(L.categoryMarginV)) {
        Row {
            BasicText("组数", Modifier.weight(INDEX_COLUMN_WEIGHT), style = label)
            table.columns.forEach { BasicText(it, Modifier.weight(1f), style = label.copy(textAlign = TextAlign.End)) }
        }
        table.rows.forEach { row ->
            Row(Modifier.semantics(mergeDescendants = true) {}) {
                BasicText(
                    "${row.count}",
                    Modifier.weight(INDEX_COLUMN_WEIGHT).semantics { contentDescription = "${row.count} 组" },
                    style = CoTokens.Type.bodyM.text(C.label2.current),
                )
                row.cells.forEach { SetCell(it, Modifier.weight(1f)) }
            }
        }
    }
}

/**
 * 一次称重的全部指标，按脂肪、肌肉与骨骼、水分与蛋白质、其他读数分组，一项一行、数值在行尾。
 * [onDelete] 不为空时最下面是删除，先弹确认；室友上秤被当成本人记进来时靠它删掉。
 */
@Composable
private fun MeasurementSheet(
    measurement: BodyMeasurement,
    deleting: Boolean,
    failure: String?,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var confirming by remember { mutableStateOf(false) }
    val groups = metricGroups(measurement.metrics)
    val weight = measurement.metrics["weight_kg"]?.let { MetricRow("体重", Reading(num(it), "kg")) }
    CoBottomSheet(onDismissRequest = onDismiss, grouped = true) {
        val close = LocalCoBottomSheetClose.current
        CoPanelTitleBar(
            listOfNotNull("称重", measurement.measuredAt?.format(TIME)).joinToString(" "),
            dismiss = CoBarAction("关闭", onClick = close, text = "关闭"),
        )
        SheetBody {
            groups.forEach { group ->
                val rows = if (group.title == null) listOfNotNull(weight) + group.rows else group.rows
                if (group.title == null) GroupGap() else CoCategoryTitle(group.title)
                rows.forEachIndexed { i, row -> MetricItem(row, positionOf(i, rows.size)) }
            }
            // 只有体重时没有“首组”，体重自己成一组
            if (weight != null && groups.none { it.title == null }) {
                GroupGap()
                MetricItem(weight, CoCardPosition.Full)
            }
            if (hasBiaMetrics(measurement.metrics)) Footer("BIA 数值适合看趋势，不是医疗诊断")
            if (onDelete != null) {
                // 删除失败写在按钮上方（DESIGN §11.2：原位写原因和补救），按钮照常可以再点
                failure?.let {
                    BasicText(
                        it,
                        Modifier.fillMaxWidth().padding(horizontal = L.categoryIndent).padding(top = L.groupTop * 2),
                        style = L.summary.text(C.label2.current).copy(textAlign = TextAlign.Center),
                    )
                }
                CoButton(
                    if (deleting) "正在删除…" else "删除",
                    onClick = { confirming = true },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = L.categoryIndent)
                        .padding(top = if (failure == null) L.groupTop * 2 else L.categoryMarginV),
                    type = CoButtonType.Secondary,
                    enabled = !deleting,
                    textColor = C.error.current,
                )
            }
        }
    }
    if (confirming && onDelete != null) {
        val what = listOfNotNull(
            measurement.measuredAt?.format(DateTimeFormatter.ofPattern("M月d日 HH:mm")),
            measurement.metrics["weight_kg"]?.let { "${num(it)} kg" },
        ).joinToString(" ")
        CoAlertDialog(
            onDismissRequest = { confirming = false },
            title = if (what.isEmpty()) "要永久删除这次称重吗？" else "要永久删除 $what 的称重吗？",
            // 不可逆：写清范围、去向和残留（DESIGN §11.4）
            message = "这次称重会从 Kinetrail 删除，身迹和 ChatGPT 里都不再出现，删除后无法恢复。" +
                "已有的备份和数据库的时间点恢复里仍有这条记录，要等它们过期才会消失。" +
                "Health Connect 里的原记录（如果有）不会被删，也不会再同步回来",
            buttons = listOf(
                CoDialogButton("永久删除", CoDialogButtonRole.Danger, onClick = onDelete),
                CoDialogButton("取消", onClick = {}),
            ),
        )
    }
}

@Composable
private fun MetricItem(row: MetricRow, position: CoCardPosition) {
    val (value, unit) = row.reading
    val text = when (unit) {
        "" -> value
        "%" -> "$value%"
        else -> "$value $unit"
    }
    CoListItem(row.label, position, trailing = CoTrailing.Status(text, arrow = false))
}
