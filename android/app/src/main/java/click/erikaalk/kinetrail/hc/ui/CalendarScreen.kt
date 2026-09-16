package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.calendar.CalendarDay
import click.erikaalk.kinetrail.hc.calendar.TrainingSession
import click.erikaalk.kinetrail.hc.calendar.describeSets
import click.erikaalk.kinetrail.hc.calendar.kcalLabel
import click.erikaalk.kinetrail.hc.calendar.metricRows
import click.erikaalk.kinetrail.hc.calendar.monthGrid
import click.erikaalk.kinetrail.hc.calendar.sessionSummary
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.component.BannerTone
import click.erikaalk.kinetrail.hc.designsystem.component.InlineBanner
import click.erikaalk.kinetrail.hc.designsystem.component.KtCard
import click.erikaalk.kinetrail.hc.designsystem.component.KtIconButton
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.SettingRow
import click.erikaalk.kinetrail.hc.designsystem.component.SettingsSection
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * 训练日历：月视图里每个日期下的小字是手表记录的当天消耗热量（由模型随训练一起写入服务端），
 * 点开日期看当天的逐组训练；那天称过体重就一并列出体脂秤读数。
 *
 * 数据全部来自服务端 `/app/calendar`，与 Health Connect 无关，也不会触发同步。
 */
@Composable
fun CalendarScreen(state: AppState, actions: AppActions, insets: PageInsets) {
    val colors = ktColors
    val today = remember { LocalDate.now() }
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
                style = KtType.title,
                color = colors.text.primary,
                modifier = Modifier.weight(1f),
            )
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

        // 原来这句挂在首页那个日历入口的组说明里；入口换成底栏之后，说明跟着数据留在这一页。
        Text(
            "日期下的小字是手表记录的当天消耗，随训练一起写入 Kinetrail。",
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier
                .padding(horizontal = KtSpacing.Padding.pageX)
                .padding(top = KtSpacing.Gap.group),
        )

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
        }
        if (state.calendarLoading) {
            Row(
                Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.group),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline),
            ) {
                CircularProgressIndicator(Modifier.size(20.dp), color = colors.accent.text, strokeWidth = 2.dp)
                Text("读取中…", style = KtType.body, color = colors.text.secondary)
            }
        }

        val selected = state.selectedDate
        if (selected != null) DayDetail(selected, state.calendarDays[selected])
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
            Row(Modifier.fillMaxWidth()) {
                for (date in week) {
                    Box(Modifier.weight(1f)) {
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
 * 一个日期格。第二行是当天的消耗热量；没有热量但有训练时给一个点，右上角的点表示当天称过体重。
 * 颜色之外总有形状或文字承载信息，不靠颜色单独表达状态。
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
    val content = when {
        selected -> colors.accent.onAccent
        today -> colors.accent.text
        else -> colors.text.primary
    }
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .padding(2.dp)
            .clip(KtRadius.mediumShape)
            .background(if (selected) colors.accent.primary else Color.Transparent)
            .ktFocusRing(interaction, KtRadius.mediumShape, onColoredSurface = selected)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClickLabel = "查看 ${date.monthValue} 月 ${date.dayOfMonth} 日",
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                "${date.dayOfMonth}",
                style = KtType.body.copy(fontWeight = if (today || selected) FontWeight.SemiBold else FontWeight.Normal),
                color = content,
            )
            val kcal = day?.caloriesKcal
            when {
                kcal != null -> Text(
                    kcalLabel(kcal),
                    style = KtType.caption,
                    color = if (selected) colors.accent.onAccent else colors.accent.text,
                    modifier = Modifier.padding(top = 1.dp),
                )
                day?.sessions?.isNotEmpty() == true -> Box(
                    Modifier
                        .padding(top = 5.dp)
                        .size(4.dp)
                        .clip(CircleShape)
                        .background(if (selected) colors.accent.onAccent else colors.accent.primary),
                )
            }
        }
        if (day?.measurements?.isNotEmpty() == true) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 4.dp, end = 4.dp)
                    .size(5.dp)
                    .clip(CircleShape)
                    .background(if (selected) colors.accent.onAccent else colors.text.tertiary),
            )
        }
    }
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val WEEKDAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

@Composable
private fun DayDetail(date: LocalDate, day: CalendarDay?) {
    val colors = ktColors
    Text(
        "${date.monthValue} 月 ${date.dayOfMonth} 日 ${WEEKDAYS[date.dayOfWeek.value - 1]}",
        style = KtType.sectionTitle,
        color = colors.text.primary,
        modifier = Modifier
            .padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX)
            .padding(top = KtSpacing.Gap.section),
    )

    if (day == null || (day.sessions.isEmpty() && day.measurements.isEmpty())) {
        Text(
            "这天没有训练记录，也没有称重。",
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier
                .padding(horizontal = KtSpacing.Padding.pageX + KtSpacing.cardPaddingX)
                .padding(top = KtSpacing.Gap.related),
        )
        return
    }

    for (session in day.sessions) {
        KtCard(Modifier.padding(top = KtSpacing.Gap.group)) { SessionBody(session) }
    }

    for (measurement in day.measurements) {
        val rows = metricRows(measurement.metrics)
        SettingsSection(
            title = "体脂秤 " + (measurement.measuredAt?.format(TIME) ?: ""),
            rows = rows.map { (label, value) -> { SettingRow(title = label, value = value) } },
            footer = "BIA 数值适合看趋势，不是医疗诊断。",
        )
    }
}

@Composable
private fun SessionBody(session: TrainingSession) {
    val colors = ktColors
    // 补记的训练开始和结束是同一时刻，那样显示成「16:56–16:56」像坏了，只给一个时间。
    val span = listOfNotNull(session.startedAt?.format(TIME), session.endedAt?.format(TIME))
        .distinct()
        .joinToString("–")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(span.ifEmpty { "训练" }, style = KtType.body, color = colors.text.primary, modifier = Modifier.weight(1f))
        if (session.status == "open") {
            Text("未结束", style = KtType.caption, color = colors.semantic.warning.text)
        }
    }
    val summary = sessionSummary(session)
    if (summary.isNotEmpty()) {
        Text(
            summary,
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier.padding(top = KtSpacing.Gap.related),
        )
    }

    if (session.entries.isEmpty()) {
        Text(
            "这次会话还没有记录动作。",
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier.padding(top = KtSpacing.Gap.group),
        )
    }
    for (entry in session.entries) {
        Column(Modifier.padding(top = KtSpacing.Gap.group)) {
            Text(entry.name, style = KtType.body, color = colors.text.primary)
            val detail = listOfNotNull(entry.equipment, describeSets(entry.sets).ifEmpty { null })
                .joinToString(" · ")
            if (detail.isNotEmpty()) {
                Text(
                    detail,
                    style = KtType.secondary,
                    color = colors.text.secondary,
                    modifier = Modifier.padding(top = KtSpacing.Gap.related),
                )
            }
            val notes = entry.notes
            if (notes != null) {
                Text(
                    notes,
                    style = KtType.caption,
                    color = colors.text.tertiary,
                    modifier = Modifier.padding(top = KtSpacing.Gap.related),
                )
            }
        }
    }

    val notes = session.notes
    if (notes != null) {
        Text(
            notes,
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier.padding(top = KtSpacing.Gap.group),
        )
    }
}
