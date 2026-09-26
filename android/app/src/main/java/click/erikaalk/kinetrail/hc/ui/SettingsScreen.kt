package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import click.erikaalk.coloroskit.components.CoBarAction
import click.erikaalk.coloroskit.components.CoBottomSheet
import click.erikaalk.coloroskit.components.CoCard
import click.erikaalk.coloroskit.components.CoCardPosition
import click.erikaalk.coloroskit.components.CoListItem
import click.erikaalk.coloroskit.components.CoMenuItem
import click.erikaalk.coloroskit.components.CoPanelTitleBar
import click.erikaalk.coloroskit.components.CoTextField
import click.erikaalk.coloroskit.components.CoTrailing
import click.erikaalk.coloroskit.components.LocalCoBottomSheetClose
import click.erikaalk.coloroskit.tokens.CoTokens
import click.erikaalk.kinetrail.hc.BuildConfig
import click.erikaalk.kinetrail.hc.report.ReportFormat

/**
 * 设置页：两组行。默认首页、体测报告点开弹出菜单，选中即保存；推送令牌在面板里输入；版本只读。
 */
@Composable
fun SettingsScreen(state: AppState, actions: AppActions) {
    var editingToken by remember { mutableStateOf(false) }
    KtPage(Screen.Settings.title, bottomExtra = TabBarRoom) {
        GroupGap()
        // 设置页自己不当首页：打开 App 就停在设置里没有用
        val homes = TABS.filter { it.screen != Screen.Settings }
        MenuRow(
            "默认首页", CoCardPosition.Head, TABS.first { it.screen == state.homeScreen }.label,
            homes.map { tab -> CoMenuItem(tab.label, checked = tab.screen == state.homeScreen) { actions.setHomeScreen(tab.screen) } },
        )
        MenuRow(
            "体测报告", CoCardPosition.Tail, state.reportFormat.label,
            ReportFormat.entries.map { f -> CoMenuItem(f.menuLabel, checked = f == state.reportFormat) { actions.setReportFormat(f) } },
        )
        GroupGap()
        CoListItem(
            "推送令牌", CoCardPosition.Head,
            trailing = CoTrailing.Status(if (state.tokenSaved) "已保存" else "未设置", arrow = false),
            onClick = { editingToken = true },
        )
        CoListItem("版本", CoCardPosition.Tail, trailing = CoTrailing.Status(BuildConfig.VERSION_NAME, arrow = false))
    }
    if (editingToken) TokenSheet(onSave = actions::saveToken, onDismiss = { editingToken = false })
}

/** 菜单里给没适配的版式带上成熟度标签（DESIGN §14：括号只用于成熟度标签）；行尾当前值仍只写名字。 */
private val ReportFormat.menuLabel: String
    get() = if (this == ReportFormat.XiaomiS800) "$label（未适配）" else label

/**
 * 输入推送令牌的面板：顶栏“取消 / 保存”，令牌不对写在输入框下面（面板是独立窗口，页面上的提示会被它挡住）。
 * [onSave] 返回 false 表示没有保存。
 */
@Composable
private fun TokenSheet(onSave: (String) -> Boolean, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    CoBottomSheet(onDismissRequest = onDismiss, grouped = true) {
        val close = LocalCoBottomSheetClose.current
        CoPanelTitleBar(
            "推送令牌",
            dismiss = CoBarAction("取消", onClick = close, text = "取消"),
            confirm = CoBarAction("保存", text = "保存", enabled = value.isNotEmpty(), onClick = {
                if (onSave(value)) close() else error = "令牌不完整，请重新复制"
            }),
        )
        Column(Modifier.imePadding().padding(bottom = CoTokens.List.listBottomPadding)) {
            CoCard(contentPadding = PaddingValues(horizontal = CoTokens.List.paddingH)) {
                CoTextField(
                    value, { value = it.trim(); error = null }, label = "推送令牌", error = error,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
            Footer("用本机 Android Keystore 加密保存，会替换已保存的令牌")
        }
    }
}
