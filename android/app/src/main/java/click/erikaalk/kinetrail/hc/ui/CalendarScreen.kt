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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.calendar.BodyMeasurement
import click.erikaalk.kinetrail.hc.calendar.CalendarDay
import click.erikaalk.kinetrail.hc.calendar.TrainingEntry
import click.erikaalk.kinetrail.hc.calendar.TrainingSession
import click.erikaalk.kinetrail.hc.calendar.describeSets
import click.erikaalk.kinetrail.hc.calendar.kcalLabel
import click.erikaalk.kinetrail.hc.calendar.metricGroups
import click.erikaalk.kinetrail.hc.calendar.monthGrid
import click.erikaalk.kinetrail.hc.calendar.num
import click.erikaalk.kinetrail.hc.calendar.sessionSummary
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
import click.erikaalk.kinetrail.hc.designsystem.component.SectionFooter
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
 * 一个日期格。选中是实色底块，今天是描边——两者靠形状区分。
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
            .then(if (today && !selected) Modifier.border(1.dp, colors.accent.border, KtRadius.mediumShape) else Modifier)
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
        // 标记这一格固定占一行字高，空着也占，保证同一周的数字在同一条线上
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
    if (day.measurements.any { m -> m.metrics.keys.any { it != "weight_kg" } }) {
        SectionFooter("BIA 数值适合看趋势，不是医疗诊断。")
    }
}

/** 卡片里分隔两块内容的线，上下各留一档同组间距。 */
@Composable
private fun CardDivider() {
    RowDivider(Modifier.padding(vertical = KtSpacing.Gap.control), inset = 0.dp)
}

@Composable
private fun SessionBody(session: TrainingSession) {
    val colors = ktColors
    // 补记的训练开始和结束是同一时刻，那样显示成「16:56–16:56」像坏了，只给一个时间。
    val span = listOfNotNull(session.startedAt?.format(TIME), session.endedAt?.format(TIME))
        .distinct()
        .joinToString("–")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (span.isEmpty()) "训练" else "训练 $span",
            style = KtType.sectionTitle,
            color = colors.text.primary,
            modifier = Modifier.weight(1f),
        )
        if (session.status == "open") {
            Text("未结束", style = KtType.secondary, color = colors.semantic.warning.text)
        }
    }
    val summary = sessionSummary(session)
    if (summary.isNotEmpty()) {
        FlowRow(
            Modifier.padding(top = KtSpacing.Gap.related),
            horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.group),
        ) {
            summary.forEach { Text(it, style = KtType.body, color = colors.text.secondary) }
        }
    }
    session.facility?.let {
        Text(it, style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
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

/** 一个动作：名字、器械、每段负重一行、动作自己的备注。 */
@Composable
private fun EntryBlock(entry: TrainingEntry) {
    val colors = ktColors
    Text(entry.name, style = KtType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.text.primary)
    entry.equipment?.let {
        Text(it, style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
    }
    for (line in describeSets(entry.sets)) {
        Text(line, style = KtType.body, color = colors.text.primary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
    }
    entry.notes?.let {
        Text("备注：$it", style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
    }
}

/** 一次称重：体重大字，体脂率和 BMI 常驻，其余指标按组收在「展开指标」里。 */
@Composable
private fun MeasurementCard(measurement: BodyMeasurement, modifier: Modifier = Modifier) {
    val colors = ktColors
    val groups = metricGroups(measurement.metrics)
    val summary = groups.firstOrNull { it.title == null }
    val more = groups.filter { it.title != null }
    var expanded by remember { mutableStateOf(false) }

    KtCard(modifier) {
        Text(
            measurement.measuredAt?.let { "称重 ${it.format(TIME)}" } ?: "称重",
            style = KtType.sectionTitle,
            color = colors.text.primary,
        )
        measurement.metrics["weight_kg"]?.let { weight ->
            Row(
                Modifier
                    .padding(top = KtSpacing.Gap.related)
                    .semantics(mergeDescendants = true) {},
            ) {
                Text(num(weight), style = KtType.metric, color = colors.text.primary, modifier = Modifier.alignByBaseline())
                Text(
                    "kg",
                    style = KtType.body,
                    color = colors.text.secondary,
                    modifier = Modifier.alignByBaseline().padding(start = KtSpacing.Gap.related),
                )
            }
        }
        if (summary != null) MetricGrid(summary.rows, Modifier.padding(top = KtSpacing.Gap.control))

        if (expanded) {
            for (group in more) {
                Text(
                    group.title.orEmpty(),
                    style = KtType.body.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.text.primary,
                    modifier = Modifier.padding(top = KtSpacing.Gap.group),
                )
                MetricGrid(group.rows, Modifier.padding(top = KtSpacing.Gap.related))
            }
        }
        if (more.isNotEmpty()) {
            CardDivider()
            DisclosureRow(expanded = expanded, onToggle = { expanded = !expanded })
        }
    }
}

/** 两列「标签在上、值在下」；系统字号放大后改成单列，不缩字也不截断。 */
@Composable
private fun MetricGrid(rows: List<Pair<String, String>>, modifier: Modifier = Modifier) {
    val colors = ktColors
    val columns = if (LocalDensity.current.fontScale > 1.3f) 1 else 2
    Column(modifier, verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline)) {
        for (line in rows.chunked(columns)) {
            Row(horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline)) {
                for ((label, value) in line) {
                    Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                        Text(label, style = KtType.secondary, color = colors.text.secondary)
                        Text(value, style = KtType.body, color = colors.text.primary, modifier = Modifier.padding(top = KtSpacing.Gap.related))
                    }
                }
                repeat(columns - line.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** 原地展开或收起，不是去另一页，所以不带 ›。 */
@Composable
private fun DisclosureRow(expanded: Boolean, onToggle: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier
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
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(if (expanded) "收起指标" else "展开指标", style = KtType.body, color = ktColors.accent.text)
    }
}
