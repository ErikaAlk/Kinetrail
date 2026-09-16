package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import click.erikaalk.kinetrail.hc.BuildConfig
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.component.BannerTone
import click.erikaalk.kinetrail.hc.designsystem.component.InlineBanner
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.SettingRow
import click.erikaalk.kinetrail.hc.designsystem.component.SettingsSection
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 首页：同步是主任务，报告识别是第二个入口，令牌放最后。每组一个标题，行只有图标、标题和右侧读数。
 * 同步失败的原因放在组下方的提示条里，成功只在行内给一句结果。
 */
@Composable
fun HomeScreen(state: AppState, actions: AppActions, insets: PageInsets) {
    val granted = state.grantedPermissions
    val permissionsComplete = granted != null && granted == state.totalPermissions
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = insets.top, bottom = insets.bottom),
    ) {
        PageTitle(text = "身迹同步", onTitleBounds = insets.onTitleBounds)

        SettingsSection(
            title = "记录",
            hasIcons = true,
            footer = "日期下的小字是手表记录的当天消耗，随训练一起写入 Kinetrail。",
            rows = listOf(
                {
                    SettingRow(
                        title = "训练日历",
                        icon = R.drawable.ic_calendar_days,
                        chevron = true,
                        onClick = actions::openCalendar,
                    )
                },
            ),
        )

        SettingsSection(
            title = "体测同步",
            hasIcons = true,
            footer = when {
                granted == null -> null
                !state.tokenSaved -> "保存推送令牌后才能同步。"
                else -> "打开 App 时会自动同步一次。"
            },
            rows = listOf(
                {
                    SettingRow(
                        title = "立即同步",
                        icon = R.drawable.ic_refresh_cw,
                        value = if (state.syncing) "同步中…" else syncTime(state.lastSyncAt),
                        subtitle = state.lastSyncMessage?.takeIf { state.lastSyncOk && !state.syncing },
                        enabled = state.tokenSaved && granted != null && !state.syncing,
                        onClick = actions::sync,
                    )
                },
                {
                    SettingRow(
                        title = "Health Connect 权限",
                        icon = R.drawable.ic_activity,
                        value = when {
                            granted == null -> "不可用"
                            permissionsComplete -> "已授权"
                            else -> "缺 ${state.totalPermissions - granted} 项"
                        },
                        onClick = if (granted != null && !permissionsComplete) actions::requestPermissions else null,
                    )
                },
            ),
        )
        val problem = when {
            granted == null -> "这台手机上的 Health Connect 不可用，无法读取体测。"
            !state.lastSyncOk && state.lastSyncMessage != null && !state.syncing -> state.lastSyncMessage
            else -> null
        }
        if (problem != null) {
            InlineBanner(
                text = problem.orEmpty(),
                tone = BannerTone.Error,
                modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.cardToFooter),
            )
        }

        SettingsSection(
            title = "体测报告",
            hasIcons = true,
            footer = "也可以在 FitDays+ 的报告页点分享，选身迹同步。",
            rows = listOf(
                {
                    SettingRow(
                        title = "识别报告图片",
                        icon = R.drawable.ic_image,
                        chevron = true,
                        onClick = actions::pickReport,
                    )
                },
            ),
        )

        SettingsSection(
            title = "设置",
            hasIcons = true,
            rows = listOf(
                {
                    SettingRow(
                        title = "推送令牌",
                        icon = R.drawable.ic_key_round,
                        value = if (state.tokenSaved) "已保存" else "未设置",
                        chevron = true,
                        onClick = { actions.navigate(Screen.Token) },
                    )
                },
                { SettingRow(title = "版本", value = BuildConfig.VERSION_NAME) },
            ),
        )
    }
}

private fun syncTime(at: Long?): String {
    if (at == null) return "未同步"
    val time = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault())
    val today = LocalDate.now()
    return when (time.toLocalDate()) {
        today -> "今天 " + time.format(DateTimeFormatter.ofPattern("HH:mm"))
        today.minusDays(1) -> "昨天 " + time.format(DateTimeFormatter.ofPattern("HH:mm"))
        else -> time.format(DateTimeFormatter.ofPattern("M月d日 HH:mm"))
    }
}
