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
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.SettingRow
import click.erikaalk.kinetrail.hc.designsystem.component.SettingsSection

/** 设置页：令牌和版本。只有一组，不给一行一张 Card。 */
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
