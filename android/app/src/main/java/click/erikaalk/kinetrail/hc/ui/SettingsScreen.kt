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
import click.erikaalk.kinetrail.hc.designsystem.component.ExpandableChoiceRow
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.SettingRow
import click.erikaalk.kinetrail.hc.designsystem.component.SettingsSection
import click.erikaalk.kinetrail.hc.report.ReportFormat

/**
 * 设置页：一组行。默认首页、体测报告点一下在原地展开选项，选中即保存并收起，没有保存按钮；
 * 推送令牌进子页面；版本只读。
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
            hasIcons = true,
            rows = listOf(
                {
                    ExpandableChoiceRow(
                        title = "默认首页",
                        icon = R.drawable.ic_house,
                        // 设置页自己不当首页：打开 App 就停在设置里没有用
                        options = TABS.filter { it.screen != Screen.Settings },
                        selected = TABS.first { it.screen == state.homeScreen },
                        label = { it.label },
                        onSelect = { actions.setHomeScreen(it.screen) },
                    )
                },
                {
                    ExpandableChoiceRow(
                        title = "体测报告",
                        icon = R.drawable.ic_clipboard_list,
                        options = ReportFormat.entries,
                        selected = state.reportFormat,
                        label = { it.label },
                        note = { format -> "还没有适配".takeIf { format == ReportFormat.XiaomiS800 } },
                        onSelect = actions::setReportFormat,
                    )
                },
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
