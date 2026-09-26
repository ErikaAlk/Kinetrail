package click.erikaalk.kinetrail.hc.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import click.erikaalk.coloroskit.CoTheme
import click.erikaalk.coloroskit.components.CoFloatingNavigationBar
import click.erikaalk.coloroskit.components.CoNavItem
import click.erikaalk.coloroskit.components.CoSnackBarHost
import click.erikaalk.coloroskit.tokens.CoTokens

@Composable
fun KinetrailApp(state: AppState, actions: AppActions) {
    CoTheme(themeColor = KinetrailThemeColor) { Root(state, actions) }
}

@Composable
private fun Root(state: AppState, actions: AppActions) {
    // 一级目的地自己就是自己的 tab，没有上一层可返回
    val topLevel = state.screen.tab == state.screen
    BackHandler(enabled = !topLevel) { actions.navigate(state.screen.tab) }

    Box(Modifier.fillMaxSize().background(CoTokens.Color.bgGrouped.current)) {
        when (state.screen) {
            Screen.Records -> CalendarScreen(state, actions)
            Screen.Sync -> SyncScreen(state, actions)
            Screen.Settings -> SettingsScreen(state, actions)
            Screen.Report -> ReportScreen(state, actions)
        }
        // 子页面（核对报告）不露底栏，和系统应用一样靠返回回到所属的 tab
        CoFloatingNavigationBar(
            items = TABS.map { tab -> CoNavItem(tab.label) { selected, tint -> GlyphIcon(tab.glyph, tint, selected = selected) } },
            selectedIndex = TABS.indexOfFirst { it.screen == state.screen.tab },
            onSelect = { actions.navigate(TABS[it].screen) },
            modifier = Modifier.align(Alignment.BottomCenter),
            visible = topLevel,
            // 点已经选中的“记录”也要派发：切到记录页（含点当前 tab）都静默重读当月
            dispatchWhenAlreadySelected = true,
        )
        CoSnackBarHost(state.snackbar, Modifier.align(Alignment.BottomCenter))
    }
}

class TabSpec(val screen: Screen, val label: String, val glyph: Glyph)

/**
 * 底栏上的一级目的地，顺序就是条上的顺序。标签比页面标题短一档：条上放得下，也不用重复"训练""体测"。
 * 设置页的「默认首页」用同一份标签。
 */
val TABS = listOf(
    TabSpec(Screen.Records, "记录", Glyph.Calendar),
    TabSpec(Screen.Sync, "同步", Glyph.Sync),
    TabSpec(Screen.Settings, "设置", Glyph.Settings),
)
