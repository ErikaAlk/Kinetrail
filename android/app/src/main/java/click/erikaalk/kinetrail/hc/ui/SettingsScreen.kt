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
import click.erikaalk.kinetrail.hc.designsystem.component.ChoiceRow
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.SettingRow
import click.erikaalk.kinetrail.hc.designsystem.component.SettingsSection
import click.erikaalk.kinetrail.hc.report.ReportFormat

/**
 * 设置页：默认首页、体测报告两组单选，点一下立即生效并保存，没有保存按钮；最后一组是令牌和版本。
 * 选项只有两三个，直接摊在页面上，不另开选择页。
 */
@Composable
fun SettingsScreen(state: AppState, actions: AppActions, insets: PageInsets) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = insets.top, bottom = insets.bottom),
    ) {
        PageTitle(text = Screen.Settings.title, onTitleBounds = insets.onTitleBounds)

        SettingsSection(
            title = "默认首页",
            // 设置页自己不当首页：打开 App 就停在设置里没有用
            rows = TABS.filter { it.screen != Screen.Settings }.map { tab ->
                {
                    ChoiceRow(
                        title = tab.label,
                        selected = state.homeScreen == tab.screen,
                        onSelect = { actions.setHomeScreen(tab.screen) },
                    )
                }
            },
        )

        SettingsSection(
            title = "体测报告",
            rows = ReportFormat.entries.map { format ->
                {
                    ChoiceRow(
                        title = format.label,
                        subtitle = "还没有适配".takeIf { format == ReportFormat.XiaomiS800 },
                        selected = state.reportFormat == format,
                        onSelect = { actions.setReportFormat(format) },
                    )
                }
            },
        )

        SettingsSection(
            title = "其他",
            hasIcons = true,
            rows = listOf(
                {
                    SettingRow(
                        title = Screen.Token.title,
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
