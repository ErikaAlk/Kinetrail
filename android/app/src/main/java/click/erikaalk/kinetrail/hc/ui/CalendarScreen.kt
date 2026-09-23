package click.erikaalk.kinetrail.hc.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.Dp
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
 * 日期格里数字下面一行是标记：训练是活动波形图标，称重是体重秤图标，同一家族的线条图标靠轮廓区分。
 * 这一行没有标记也照样占位，同一周的数字才对得齐。当天热量（手表记录、随训练写入服务端）在详情标题下面。
 *
 * 数据全部来自服务端 `/app/calendar`，与 Health Connect 无关，也不会触发同步。
 * 取回的每个月在本机留一份，刷新期间照常显示那一份（见 MainActivity.loadCalendar）。
 * 切到这一页、回到前台时静默重读：已有数据时不转圈，转圈只出现在手动刷新、翻月和什么都还没有的时候。
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
            // 读取中转圈占刷新按钮的位置，同一块 48dp，两个翻月箭头不跟着动
            if (state.calendarLoading) {
                Box(Modifier.size(KtIconButton.size), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(
                        Modifier
                            .size(20.dp)
                            .semantics { contentDescription = "读取中" },
                        color = colors.accent.text,
                        strokeWidth = 2.dp,
                    )
                }
            } else {
                KtIconButton(
                    icon = R.drawable.ic_rotate_cw,
                    contentDescription = "刷新",
                    onClick = { actions.showMonth(state.month) },
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
        Legend()

        if (loaded && state.calendarTruncated) {
            InlineBanner(
                "这个月的记录超出一次能取回的上限，下面只是其中一部分。",
                tone = BannerTone.Warning,
                modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.group),
            )
        }
        val error = state.calendarError
        if (error != null) {
            InlineBanner(
                // 本机有这个月的数据时页面照常显示，得说清楚那是旧的
                if (loaded) "$error。下面是上次取回的记录。" else error,
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

        state.deleteError?.let {
            InlineBanner(
                it,
                tone = BannerTone.Error,
                modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.group),
            )
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
            DayDetail(
                selected,
                state.calendarDays[selected],
                loaded = loaded,
                truncated = state.calendarTruncated,
                deletingRecord = state.deletingRecord,
                onDelete = actions::deleteMeasurement,
            )
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

/**
 * 月历标记的边长：默认 14dp，跟着系统字号放大，2 倍字号到 16dp 为止。
 * 它是日期数字旁边的辅助图形，重量不能超过数字，所以不跟着字号无限长；
 * 16dp 时 360dp 宽的手机上一格宽约 46dp、高 69dp，整张月历瘦长，收到 14dp 并压掉间距后一行约 53dp。
 */
@Composable
private fun markSize(): Dp = (14f + 2f * (LocalDensity.current.fontScale - 1f).coerceIn(0f, 1f)).dp

/**
 * 训练是活动波形，称重是体重秤：同一家族的线条图标，靠轮廓区分，不靠颜色；
 * 选中后两枚同色也分得开。不带底块，不套框。
 */
@Composable
private fun CalendarMark(@DrawableRes icon: Int, color: Color, size: Dp) {
    Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(size))
}

/**
 * 一个日期格。选中是实色底块；今天是数字下面一道短线，选中时也在，今天和选中同时成立也分得开。
 * 数字下面一行放训练、称重两枚图标，空着也占位，同一周的数字才对得齐。热量不在格子里，点开日期在详情标题下看。
 * 读屏把整格读成一句（日期、今天、训练、未结束、热量、称重），不逐个读数字和图标。
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
    val open = day?.sessions?.any { it.status == "open" } == true
    val description = listOfNotNull(
        "${date.monthValue} 月 ${date.dayOfMonth} 日",
        "今天".takeIf { today },
        "训练".takeIf { trained },
        "有未结束训练".takeIf { open },
        kcal?.let { "已记录消耗 ${kcalLabel(it)} 千卡" },
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
            .padding(vertical = KtSpacing.space1),
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
                .background(
                    when {
                        !today -> Color.Transparent
                        selected -> colors.accent.onAccent
                        else -> colors.accent.text
                    },
                ),
        )
        // 标记行固定高度，空着也占；两枚图标整体居中，顺序固定训练在前
        val size = markSize()
        val markColor = if (selected) colors.accent.onAccent else colors.text.secondary
        Row(
            Modifier
                .padding(top = 2.dp)
                .height(size),
            horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.related, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (trained) CalendarMark(R.drawable.ic_activity, markColor, size)
            if (weighed) CalendarMark(R.drawable.ic_weight, markColor, size)
        }
    }
}

/** 月历下的图例，用的就是格子里那两枚图标。大字号下两项可以整体换行，图标和标签不拆开。 */
@Composable
private fun Legend() {
    val colors = ktColors
    val size = markSize()
    FlowRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX)
            .padding(top = KtSpacing.cardToFooter),
        horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.group),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline)) {
            CalendarMark(R.drawable.ic_activity, colors.text.secondary, size)
            Text("训练", style = KtType.caption, color = colors.text.secondary)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline)) {
            CalendarMark(R.drawable.ic_weight, colors.text.secondary, size)
            Text("称重", style = KtType.caption, color = colors.text.secondary)
        }
    }
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val WEEKDAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

/** 系统字号放大到这一档以上，横排的读数和表格改成竖排，不缩字也不截断。 */
private const val LARGE_FONT_SCALE = 1.3f

/** 等宽数字：不换系统字体，只让同一列的数字宽度一致。 */
private fun TextStyle.tabular() = copy(fontFeatureSettings = "tnum")

@Composable
private fun DayDetail(
    date: LocalDate,
    day: CalendarDay?,
    loaded: Boolean,
    truncated: Boolean,
    deletingRecord: String?,
    onDelete: (String) -> Unit,
) {
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

    // 月历格子里不再写热量，挪到这里。用服务端给的当天合计，不在手机上重新加；没写进来就明说，和 0 千卡分开
    if (day.sessions.isNotEmpty()) {
        Text(
            day.caloriesKcal?.let { "已记录消耗 ${kcalLabel(it)} 千卡" } ?: "消耗未记录",
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier
                .padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX)
                .padding(bottom = KtSpacing.sectionTitleToCard),
        )
    }

    day.sessions.forEachIndexed { index, session ->
        // 和称重一样，展开状态跟着这一天的这一次训练走
        key(date, index) {
            KtCard(Modifier.padding(top = if (index == 0) 0.dp else KtSpacing.Gap.group)) { SessionBody(session) }
        }
    }

    day.measurements.forEachIndexed { index, measurement ->
        val top = when {
            index > 0 -> KtSpacing.Gap.group
            day.sessions.isNotEmpty() -> KtSpacing.Gap.section
            else -> 0.dp
        }
        // 展开和删除确认跟着这次称重的 record_id 走：静默刷新插进或去掉别的称重，确认框也不会换成另一条
        key(date, measurement.recordId ?: index) {
            MeasurementCard(
                measurement,
                deleting = measurement.recordId != null && measurement.recordId == deletingRecord,
                onDelete = measurement.recordId?.takeIf { measurement.deletable }?.let { id -> { onDelete(id) } },
                modifier = Modifier.padding(top = top),
            )
        }
    }
}

/** 卡片里分隔两块内容的线，上下各留一档同组间距。 */
@Composable
private fun CardDivider() {
    RowDivider(Modifier.padding(vertical = KtSpacing.Gap.control), inset = 0.dp)
}

/** 数值大、单位小，按基线对齐：「77 分钟」「1 分 30 秒」「71.85 kg」。 */
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

/**
 * 一次训练。默认收起：抬头、统计和动作名单常驻，逐组表格点「展开动作」才出来。
 * 会话和动作的备注不显示：那是写给模型看的上下文（单位说明、手表原话之类），
 * 服务端照样保存，模型读历史时用得上；手机上只看结构化的数。
 */
@Composable
private fun SessionBody(session: TrainingSession) {
    val colors = ktColors
    var expanded by remember { mutableStateOf(false) }
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
        return
    }
    if (expanded) {
        for (entry in session.entries) {
            CardDivider()
            EntryBlock(entry)
        }
    } else {
        CardDivider()
        Text(session.entries.joinToString("、") { it.name }, style = KtType.body, color = colors.text.secondary)
    }
    DisclosureRow(
        noun = "动作",
        expanded = expanded,
        onToggle = { expanded = !expanded },
        modifier = Modifier.padding(top = KtSpacing.Gap.control),
    )
}

/** 一个动作：名字、器械、逐组表格。 */
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
}

/** 列宽权重：组数窄，数据列等宽。同一个动作的每一行用同一套权重，上下才对得齐。 */
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
 * 逐组表格：组数靠左，表头和数据右对齐，不画外框、竖线和逐行横线。相邻的相同组已合成一行，第一列是这一行代表几组。
 * 系统字号放大后改成逐行竖排，不缩字、不横向滚动。
 */
@Composable
private fun SetTableView(table: SetTable, modifier: Modifier = Modifier) {
    val colors = ktColors
    if (LocalDensity.current.fontScale > LARGE_FONT_SCALE) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.control)) {
            table.rows.forEach { row ->
                Column(Modifier.semantics(mergeDescendants = true) {}) {
                    Text("${row.count} 组", style = KtType.secondary, color = colors.text.secondary)
                    table.columns.zip(row.cells).forEach { (label, cell) ->
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
            Text("组数", style = KtType.secondary, color = colors.text.secondary, modifier = Modifier.weight(INDEX_COLUMN_WEIGHT))
            table.columns.forEach {
                Text(it, style = KtType.secondary, color = colors.text.secondary, textAlign = TextAlign.End, modifier = Modifier.weight(1f))
            }
        }
        table.rows.forEach { row ->
            Row(Modifier.semantics(mergeDescendants = true) {}) {
                Text(
                    "${row.count}",
                    style = KtType.body.tabular(),
                    color = colors.text.secondary,
                    modifier = Modifier
                        .weight(INDEX_COLUMN_WEIGHT)
                        .semantics { contentDescription = "${row.count} 组" },
                )
                row.cells.forEach { SetCell(it, Modifier.weight(1f)) }
            }
        }
    }
}

/**
 * 一次称重。主区左边是体重，竖线右边竖排体脂率和 BMI；其余指标按组收在「展开指标」里，一项一行、数值靠右。
 * 系统字号放大后主区改成上下排。只有体重时是一张紧凑卡，没有右栏、展开和 BIA 说明。
 * [onDelete] 不为空时卡底有「删除这次称重」，先弹确认；室友上秤被当成本人记进来时靠它删掉。
 */
@Composable
private fun MeasurementCard(
    measurement: BodyMeasurement,
    deleting: Boolean,
    onDelete: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
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
            DisclosureRow(
                noun = "指标",
                expanded = expanded,
                onToggle = { expanded = !expanded },
                modifier = Modifier.padding(top = KtSpacing.Gap.control),
            )
        }
        if (onDelete != null) {
            CardDivider()
            DeleteRow(measurement, deleting, onDelete)
        }
    }
}

/** 卡底的删除入口。点了先弹确认，写清删的是哪一次、删了之后哪里还有副本；删除中不能再点。 */
@Composable
private fun DeleteRow(measurement: BodyMeasurement, deleting: Boolean, onDelete: () -> Unit) {
    val colors = ktColors
    var confirming by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .fillMaxWidth()
            .ktFocusRing(interaction, KtRadius.smallShape)
            .clip(KtRadius.smallShape)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                enabled = !deleting,
                role = Role.Button,
                onClick = { confirming = true },
            )
            .defaultMinSize(minHeight = 48.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (deleting) "删除中…" else "删除这次称重",
            style = KtType.body,
            color = if (deleting) colors.text.tertiary else colors.semantic.error.text,
        )
    }
    if (confirming) {
        val what = listOfNotNull(
            measurement.measuredAt?.format(DateTimeFormatter.ofPattern("M 月 d 日 HH:mm")),
            measurement.metrics["weight_kg"]?.let { "${num(it)} kg" },
        ).joinToString(" ")
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(if (what.isEmpty()) "永久删除这次称重？" else "永久删除 $what 的称重？") },
            text = {
                Text(
                    "这次称重会从 Kinetrail 删除，身迹和 ChatGPT 里都不再出现，删除后无法恢复。" +
                        "已有的备份和数据库的时间点恢复里仍有这条记录，要等它们过期才会消失。" +
                        "Health Connect 里的原记录（如果有）不会被删，也不会再同步回来。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    onDelete()
                }) { Text("永久删除", color = colors.semantic.error.text) }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("取消") } },
        )
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

/** 卡底居中的「展开指标 ⌄」「展开动作 ⌄」。原地展开，不是去另一页，所以不用 ›。 */
@Composable
private fun DisclosureRow(noun: String, expanded: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
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
        Text(if (expanded) "收起$noun" else "展开$noun", style = KtType.body, color = colors.accent.text)
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
