package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.calendar.BodyMeasurement
import click.erikaalk.kinetrail.hc.calendar.CalendarDay
import click.erikaalk.kinetrail.hc.calendar.TrainingEntry
import click.erikaalk.kinetrail.hc.calendar.TrainingSession
import click.erikaalk.kinetrail.hc.calendar.kcalLabel
import click.erikaalk.kinetrail.hc.calendar.MetricRow
import click.erikaalk.kinetrail.hc.calendar.Reading
import click.erikaalk.kinetrail.hc.calendar.SetTable
import click.erikaalk.kinetrail.hc.calendar.hasBiaMetrics
import click.erikaalk.kinetrail.hc.calendar.metricGroups
import click.erikaalk.kinetrail.hc.calendar.monthGrid
import click.erikaalk.kinetrail.hc.calendar.num
import click.erikaalk.kinetrail.hc.calendar.sessionStats
import click.erikaalk.kinetrail.hc.calendar.setTable
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.component.BannerTone
import click.erikaalk.kinetrail.hc.designsystem.component.InlineBanner
import click.erikaalk.kinetrail.hc.designsystem.component.KtCard
import click.erikaalk.kinetrail.hc.designsystem.component.KtIconButton
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.RowDivider
import click.erikaalk.kinetrail.hc.designsystem.component.SecondaryButton
import click.erikaalk.kinetrail.hc.designsystem.component.SectionHeader
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * 训练日历：上半是月历，下半是选中那天的训练和称重。
 *
 * 日期格里数字下面的一格是标记：有热量写热量（手表记录、随训练写入服务端），没热量但有训练给实心点，
 * 称过体重再加一个空心方块。这一格没有标记也照样占位，同一周的数字才对得齐。
 *
 * 数据全部来自服务端 `/app/calendar`，与 Health Connect 无关，也不会触发同步。
 */
@Composable
fun CalendarScreen(state: AppState, actions: AppActions, insets: PageInsets) {
    val colors = ktColors
    val today = remember { LocalDate.now() }
    val loaded = state.calendarLoadedMonth == state.month
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = insets.top, bottom = insets.bottom),
    ) {
        PageTitle(text = Screen.Records.title, onTitleBounds = insets.onTitleBounds)

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = KtSpacing.Padding.pageX)
                .padding(top = KtSpacing.pageTitleToSection),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "${state.month.year} 年 ${state.month.monthValue} 月",
                style = KtType.sectionTitle,
                color = colors.text.primary,
                modifier = Modifier.weight(1f),
            )
            if (state.calendarLoading) {
                CircularProgressIndicator(
                    Modifier
                        .padding(end = KtSpacing.Gap.inline)
                        .size(20.dp)
                        .semantics { contentDescription = "读取中" },
                    color = colors.accent.text,
                    strokeWidth = 2.dp,
                )
            }
            KtIconButton(
                icon = R.drawable.ic_arrow_left,
                contentDescription = "上个月",
                onClick = { actions.showMonth(state.month.minusMonths(1)) },
            )
            KtIconButton(
                icon = R.drawable.ic_chevron_right,
                contentDescription = "下个月",
                onClick = { actions.showMonth(state.month.plusMonths(1)) },
            )
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = KtSpacing.Padding.pageX)
                .padding(top = KtSpacing.Gap.group),
        ) {
            for (label in listOf("一", "二", "三", "四", "五", "六", "日")) {
                Text(
                    label,
                    style = KtType.caption,
                    color = colors.text.tertiary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        MonthGrid(state, actions, today)
        Legend(showKcal = state.calendarDays.values.any { it.caloriesKcal != null })

        if (state.calendarTruncated) {
            InlineBanner(
                "这个月的记录超出一次能取回的上限，下面只是其中一部分。",
                tone = BannerTone.Warning,
                modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.group),
            )
        }
        val error = state.calendarError
        if (error != null) {
            InlineBanner(
                error,
                tone = BannerTone.Error,
                modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.group),
            )
            // 没保存令牌时重试也没用，那条错误本身已经说了该去做什么
            if (state.tokenSaved && !state.calendarLoading) {
                SecondaryButton(
                    "重试",
                    onClick = { actions.showMonth(state.month) },
                    modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.control),
                )
            }
        }

        val selected = state.selectedDate
        if (selected == null) {
            Text(
                "选择日期查看记录。",
                style = KtType.secondary,
                color = colors.text.secondary,
                modifier = Modifier
                    .padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX)
                    .padding(top = KtSpacing.Gap.section),
            )
        } else {
            // 数据还没到（读取中、失败）时不能说「没有记录」，只留日期标题
            DayDetail(selected, state.calendarDays[selected], loaded = loaded, truncated = state.calendarTruncated)
        }
    }
}

@Composable
private fun MonthGrid(state: AppState, actions: AppActions, today: LocalDate) {
    val cells = remember(state.month) { monthGrid(state.month) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KtSpacing.Padding.pageX)
            .padding(top = KtSpacing.Gap.related),
    ) {
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

/** 训练标记：实心圆点。 */
@Composable
private fun TrainingMark(color: Color) {
    Box(Modifier.size(5.dp).clip(CircleShape).background(color))
}

/** 称重标记：空心方块，和训练点靠形状区分，不只靠颜色。 */
@Composable
private fun WeighMark(color: Color) {
    Box(Modifier.size(6.dp).border(1.5.dp, color, RectangleShape))
}

/**
 * 一个日期格。选中是实色底块；今天是数字下面一道短线，选中时也在，今天和选中同时成立也分得开。
 * 读屏把整格读成一句（日期、今天、训练、热量、称重），不逐个读数字和标记。
 */
@Composable
private fun DayCell(
    date: LocalDate,
    day: CalendarDay?,
    selected: Boolean,
    today: Boolean,
    onClick: () -> Unit,
) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    val kcal = day?.caloriesKcal
    val trained = day?.sessions?.isNotEmpty() == true
    val weighed = day?.measurements?.isNotEmpty() == true
    val markColor = if (selected) colors.accent.onAccent else colors.accent.text
    val description = listOfNotNull(
        "${date.monthValue} 月 ${date.dayOfMonth} 日",
        "今天".takeIf { today },
        when {
            kcal != null -> "训练，消耗 ${kcalLabel(kcal)} 千卡"
            trained -> "训练"
            else -> null
        },
        "称重".takeIf { weighed },
    ).joinToString("，")

    Column(
        Modifier
            .fillMaxSize()
            .padding(2.dp)
            // 焦点环往外画，必须在 clip 外层，否则被自己裁掉
            .ktFocusRing(interaction, KtRadius.mediumShape, onColoredSurface = selected)
            .clip(KtRadius.mediumShape)
            .background(if (selected) colors.accent.primary else Color.Transparent)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                role = Role.Button,
                onClick = onClick,
            )
            .clearAndSetSemantics {
                contentDescription = description
                this.selected = selected
            }
            .defaultMinSize(minHeight = 48.dp)
            .padding(vertical = KtSpacing.space2),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "${date.dayOfMonth}",
            style = KtType.body.copy(fontWeight = if (today || selected) FontWeight.SemiBold else FontWeight.Normal),
            color = when {
                selected -> colors.accent.onAccent
                today -> colors.accent.text
                else -> colors.text.primary
            },
        )
        // 今天的短线。别的日期画透明的同一条，同一周的数字和标记才在同一条线上
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(width = 12.dp, height = 2.dp)
                .clip(CircleShape)
                .background(if (today) markColor else Color.Transparent),
        )
        // 标记这一格固定占一行字高，空着也占
        val density = LocalDensity.current
        val slot = with(density) { KtType.caption.lineHeight.toDp() }
        // 系统字号很大时四位数热量塞不进格子：不折行也不截断，退回训练点，读屏和当天详情里仍有热量
        var kcalFits by remember(kcal, density.fontScale) { mutableStateOf(true) }
        FlowRow(
            Modifier.heightIn(min = slot),
            horizontalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterHorizontally),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                kcal != null && kcalFits -> Text(
                    kcalLabel(kcal),
                    style = KtType.caption,
                    color = markColor,
                    maxLines = 1,
                    softWrap = false,
                    onTextLayout = { if (it.didOverflowWidth) kcalFits = false },
                )
                trained || kcal != null -> Box(Modifier.heightIn(min = slot), contentAlignment = Alignment.Center) { TrainingMark(markColor) }
            }
            if (weighed) {
                Box(Modifier.heightIn(min = slot), contentAlignment = Alignment.Center) {
                    WeighMark(if (selected) colors.accent.onAccent else colors.text.secondary)
                }
            }
        }
    }
}

/** 月历下的图例。热量那一项只在这个月真的有热量时出现。 */
@Composable
private fun Legend(showKcal: Boolean) {
    val colors = ktColors
    FlowRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX)
            .padding(top = KtSpacing.cardToFooter),
        horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.group),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline)) {
            TrainingMark(colors.accent.text)
            Text("训练", style = KtType.caption, color = colors.text.secondary)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline)) {
            WeighMark(colors.text.secondary)
            Text("称重", style = KtType.caption, color = colors.text.secondary)
        }
        if (showKcal) Text("数字：消耗千卡", style = KtType.caption, color = colors.text.secondary)
    }
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val WEEKDAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

/** 系统字号放大到这一档以上，横排的读数和表格改成竖排，不缩字也不截断。 */
private const val LARGE_FONT_SCALE = 1.3f

/** 等宽数字：不换系统字体，只让同一列的数字宽度一致。 */
private fun TextStyle.tabular() = copy(fontFeatureSettings = "tnum")

@Composable
private fun DayDetail(date: LocalDate, day: CalendarDay?, loaded: Boolean, truncated: Boolean) {
    val colors = ktColors
    SectionHeader(
        "${date.monthValue} 月 ${date.dayOfMonth} 日 ${WEEKDAYS[date.dayOfWeek.value - 1]}",
        modifier = Modifier.padding(top = KtSpacing.Gap.section),
    )
    if (!loaded) return

    if (day == null || (day.sessions.isEmpty() && day.measurements.isEmpty())) {
        Text(
            if (truncated) "已取回的部分里没有这天的记录。" else "这天没有训练或称重记录。",
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX),
        )
        return
    }

    day.sessions.forEachIndexed { index, session ->
        KtCard(Modifier.padding(top = if (index == 0) 0.dp else KtSpacing.Gap.group)) { SessionBody(session) }
    }

    day.measurements.forEachIndexed { index, measurement ->
        val top = when {
            index > 0 -> KtSpacing.Gap.group
            day.sessions.isNotEmpty() -> KtSpacing.Gap.section
            else -> 0.dp
        }
        // 展开状态跟着这一天的这一次称重走，换了日期不会串到别的记录上
        key(date, index) { MeasurementCard(measurement, Modifier.padding(top = top)) }
    }
}

/** 卡片里分隔两块内容的线，上下各留一档同组间距。 */
@Composable
private fun CardDivider() {
    RowDivider(Modifier.padding(vertical = KtSpacing.Gap.control), inset = 0.dp)
}

/** 数值大、单位小，按基线对齐：「77 分钟」「1 分 30 秒」「63.35 kg」。 */
@Composable
private fun Readings(readings: List<Reading>, valueStyle: TextStyle, modifier: Modifier = Modifier) {
    val colors = ktColors
    Row(modifier) {
        readings.forEachIndexed { index, reading ->
            Text(
                reading.value,
                style = valueStyle.tabular(),
                color = colors.text.primary,
                modifier = Modifier.alignByBaseline().padding(start = if (index == 0) 0.dp else KtSpacing.Gap.related),
            )
            if (reading.unit.isNotEmpty()) {
                Text(
                    reading.unit,
                    style = KtType.secondary,
                    color = colors.text.secondary,
                    modifier = Modifier.alignByBaseline().padding(start = KtSpacing.Gap.related),
                )
            }
        }
    }
}

/** 标签在上、读数在下的一项。 */
@Composable
private fun LabeledReading(label: String, readings: List<Reading>, valueStyle: TextStyle, modifier: Modifier = Modifier) {
    Column(modifier.semantics(mergeDescendants = true) {}) {
        Text(label, style = KtType.secondary, color = ktColors.text.secondary)
        Readings(readings, valueStyle, Modifier.padding(top = KtSpacing.Gap.related))
    }
}

@Composable
private fun SessionBody(session: TrainingSession) {
    val colors = ktColors
    // 补记的训练开始和结束是同一时刻，那样显示成「16:56–16:56」像坏了，只给一个时间。
    val span = listOfNotNull(session.startedAt?.format(TIME), session.endedAt?.format(TIME))
        .distinct()
        .joinToString("–")
    Row {
        Text("训练", style = KtType.sectionTitle, color = colors.text.primary, modifier = Modifier.alignByBaseline())
        Spacer(Modifier.weight(1f))
        if (span.isNotEmpty()) {
            Text(span, style = KtType.secondary.tabular(), color = colors.text.secondary, modifier = Modifier.alignByBaseline())
        }
        if (session.status == "open") {
            Text(
                "未结束",
                style = KtType.secondary,
                color = colors.semantic.warning.text,
                modifier = Modifier.alignByBaseline().padding(start = KtSpacing.Gap.inline),
            )
        }
    }
    // 时长照服务端的 duration_seconds 显示，不拿起止时间去算或纠正
    val stats = sessionStats(session)
    if (stats.isNotEmpty()) {
        FlowRow(
            Modifier.padding(top = KtSpacing.Gap.control),
            horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.section),
            verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.control),
        ) {
            stats.forEach { LabeledReading(it.label, it.readings, KtType.title) }
        }
    }
    session.facility?.let {
        Text(it, style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.control))
    }

    if (session.entries.isEmpty()) {
        CardDivider()
        Text("还没有记录动作。", style = KtType.secondary, color = colors.text.secondary)
    }
    for (entry in session.entries) {
        CardDivider()
        EntryBlock(entry)
    }

    session.notes?.let {
        CardDivider()
        Text("训练备注", style = KtType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.text.primary)
        Text(it, style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
    }
}

/** 一个动作：名字、器械、逐组表格、动作自己的备注。 */
@Composable
private fun EntryBlock(entry: TrainingEntry) {
    val colors = ktColors
    Text(entry.name, style = KtType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.text.primary)
    // 器械和动作名一字不差时不重复写；「高位下拉1（偏重那台）」这种有区别的照写
    entry.equipment?.takeIf { it != entry.name }?.let {
        Text(it, style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
    }
    val table = setTable(entry.sets)
    if (table.columns.isNotEmpty()) {
        SetTableView(table, Modifier.padding(top = KtSpacing.Gap.control))
    } else if (entry.sets.isNotEmpty()) {
        Text("${entry.sets.size} 组", style = KtType.body, color = colors.text.primary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
    }
    entry.notes?.let {
        Text("备注：$it", style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.control))
    }
}

/** 列宽权重：组号窄，数据列等宽。同一个动作的每一行用同一套权重，上下才对得齐。 */
private const val INDEX_COLUMN_WEIGHT = 0.5f

/** 表格里的一格：右对齐；没填写「—」，读屏读「未记录」。 */
@Composable
private fun SetCell(text: String?, modifier: Modifier = Modifier) {
    val colors = ktColors
    Text(
        text ?: "—",
        style = KtType.body.tabular(),
        color = if (text == null) colors.text.tertiary else colors.text.primary,
        textAlign = TextAlign.End,
        modifier = if (text == null) modifier.semantics { contentDescription = "未记录" } else modifier,
    )
}

/**
 * 逐组表格：组号靠左，表头和数据右对齐，不画外框、竖线和逐行横线。
 * 系统字号放大后改成逐组竖排，不缩字、不横向滚动。
 */
@Composable
private fun SetTableView(table: SetTable, modifier: Modifier = Modifier) {
    val colors = ktColors
    if (LocalDensity.current.fontScale > LARGE_FONT_SCALE) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.control)) {
            table.rows.forEachIndexed { index, row ->
                Column(Modifier.semantics(mergeDescendants = true) {}) {
                    Text("第 ${index + 1} 组", style = KtType.secondary, color = colors.text.secondary)
                    table.columns.zip(row).forEach { (label, cell) ->
                        Row(Modifier.padding(top = KtSpacing.Gap.related)) {
                            Text(label, style = KtType.body, color = colors.text.secondary, modifier = Modifier.weight(1f))
                            SetCell(cell)
                        }
                    }
                }
            }
        }
        return
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.control)) {
        Row {
            Text("组", style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.weight(INDEX_COLUMN_WEIGHT))
            table.columns.forEach {
                Text(it, style = KtType.secondary, color = colors.text.secondary, textAlign = TextAlign.End, modifier = Modifier.weight(1f))
            }
        }
        table.rows.forEachIndexed { index, row ->
            Row(Modifier.semantics(mergeDescendants = true) {}) {
                Text(
                    "${index + 1}",
                    style = KtType.body.tabular(),
                    color = colors.text.secondary,
                    modifier = Modifier.weight(INDEX_COLUMN_WEIGHT),
                )
                row.forEach { SetCell(it, Modifier.weight(1f)) }
            }
        }
    }
}

/**
 * 一次称重。主区左边是体重，竖线右边竖排体脂率和 BMI；其余指标按组收在「展开指标」里，一项一行、数值靠右。
 * 系统字号放大后主区改成上下排。只有体重时是一张紧凑卡，没有右栏、展开和 BIA 说明。
 */
@Composable
private fun MeasurementCard(measurement: BodyMeasurement, modifier: Modifier = Modifier) {
    val colors = ktColors
    val groups = metricGroups(measurement.metrics)
    val summary = groups.firstOrNull { it.title == null }?.rows.orEmpty()
    val more = groups.filter { it.title != null }
    val weight = measurement.metrics["weight_kg"]?.let { listOf(Reading(num(it), "kg")) }
    val large = LocalDensity.current.fontScale > LARGE_FONT_SCALE
    var expanded by remember { mutableStateOf(false) }

    KtCard(modifier) {
        Text(
            measurement.measuredAt?.let { "称重 ${it.format(TIME)}" } ?: "称重",
            style = KtType.sectionTitle,
            color = colors.text.primary,
        )
        if (weight != null && summary.isNotEmpty() && !large) {
            Row(Modifier.padding(top = KtSpacing.Gap.control).height(IntrinsicSize.Min)) {
                LabeledReading("体重", weight, KtType.metric, Modifier.weight(0.6f))
                Box(
                    Modifier
                        .padding(horizontal = KtSpacing.space4)
                        .width(1.dp)
                        .fillMaxHeight()
                        .background(colors.separator.subtle),
                )
                Column(Modifier.weight(0.4f), verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.control)) {
                    summary.forEach { LabeledReading(it.label, listOf(it.reading), KtType.title) }
                }
            }
        } else {
            weight?.let { LabeledReading("体重", it, KtType.metric, Modifier.padding(top = KtSpacing.Gap.control)) }
            summary.forEach { MetricLine(it) }
        }

        if (expanded) {
            for (group in more) {
                Text(
                    group.title.orEmpty(),
                    style = KtType.sectionTitle,
                    color = colors.text.primary,
                    modifier = Modifier.padding(top = KtSpacing.Gap.group),
                )
                group.rows.forEachIndexed { index, row ->
                    if (index > 0) RowDivider(inset = 0.dp)
                    MetricLine(row)
                }
            }
        }
        if (hasBiaMetrics(measurement.metrics)) {
            Text(
                "BIA 数值适合看趋势，不是医疗诊断。",
                style = KtType.secondary,
                color = colors.text.secondary,
                modifier = Modifier
                    .padding(top = KtSpacing.Gap.group)
                    .fillMaxWidth()
                    .clip(KtRadius.smallShape)
                    .background(colors.surfaceSunken)
                    .padding(KtSpacing.space3),
            )
        }
        if (more.isNotEmpty()) {
            DisclosureRow(expanded = expanded, onToggle = { expanded = !expanded }, modifier = Modifier.padding(top = KtSpacing.Gap.control))
        }
    }
}

/** 一项指标：名称在左，数值靠右；一行放不下时数值整个换到下一行，仍靠右，不截断。 */
@Composable
private fun MetricLine(row: MetricRow) {
    val colors = ktColors
    val (value, unit) = row.reading
    FlowRow(
        Modifier
            .fillMaxWidth()
            .padding(vertical = KtSpacing.Padding.controlY)
            .semantics(mergeDescendants = true) {},
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Text(row.label, style = KtType.body, color = colors.text.primary)
        Text(
            if (unit.isEmpty()) value else "$value $unit",
            style = KtType.body.copy(fontWeight = FontWeight.Medium).tabular(),
            color = colors.text.primary,
            softWrap = false,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f).padding(start = KtSpacing.Gap.inline),
        )
    }
}

/** 卡底居中的「展开指标 ⌄」。原地展开，不是去另一页，所以不用 ›。 */
@Composable
private fun DisclosureRow(expanded: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier
            .fillMaxWidth()
            .ktFocusRing(interaction, KtRadius.smallShape)
            .clip(KtRadius.smallShape)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                role = Role.Button,
                onClick = onToggle,
            )
            .semantics { stateDescription = if (expanded) "已展开" else "已收起" }
            .defaultMinSize(minHeight = 48.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (expanded) "收起指标" else "展开指标", style = KtType.body, color = colors.accent.text)
        Icon(
            painter = painterResource(R.drawable.ic_chevron_right),
            contentDescription = null,
            tint = colors.accent.text,
            modifier = Modifier
                .padding(start = KtSpacing.Gap.related)
                // 跟着系统字号放大，不然大字号下旁边的字很大、箭头还是一小点
                .size(with(LocalDensity.current) { 16.sp.toDp() })
                .rotate(if (expanded) -90f else 90f),
        )
    }
}
