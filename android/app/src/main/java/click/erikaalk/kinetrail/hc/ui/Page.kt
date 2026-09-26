package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.coloroskit.CoThemeColor
import click.erikaalk.coloroskit.components.CoBackIcon
import click.erikaalk.coloroskit.components.CoBarAction
import click.erikaalk.coloroskit.components.CoCardPosition
import click.erikaalk.coloroskit.components.CoListItem
import click.erikaalk.coloroskit.components.CoMenuItem
import click.erikaalk.coloroskit.components.CoPopupMenu
import click.erikaalk.coloroskit.components.CoTopBar
import click.erikaalk.coloroskit.components.CoTrailing
import click.erikaalk.coloroskit.material.CoCircleShape
import click.erikaalk.coloroskit.material.CoPressMask
import click.erikaalk.coloroskit.tokens.CoTokens
import click.erikaalk.coloroskit.tokens.Themed

/** 设计规范版本（全局 DESIGN.md 第 17 章）。规范升版要整套重过，改完才动它。 */
const val DESIGN_SYSTEM_REVISION = "2026.09.24-coloros17"

/**
 * 应用主题色：孔雀蓝（启动图标 #00778F 的同一色相）。设计库只收了蓝和橙，这里按 COUI 的比例派生（设计库 README）：
 * 容器 15%（暗 25%）、禁用 30%、焦点 12%（暗 20%）、焦点描边取 primaryText 的 40%。
 * 亮色 primary 配白字 4.9:1；暗色 primary 压到白字仍有 3.3:1（按钮、选中日期的白字），primaryText 提亮给黑底上的可点文字。
 * 对比度由 ThemeColorContrastTest 钉住。怎么用见 DESIGN §4：每屏只点一处。
 */
val KinetrailThemeColor = CoThemeColor(
    primary = Themed(Color(0xFF007C94), Color(0xFF1A9BB8)),
    primaryText = Themed(Color(0xFF00708A), Color(0xFF4FCBEA)),
    primaryContainer = Themed(Color(0x26007C94), Color(0x401A9BB8)),
    primaryDisabled = Themed(Color(0x4D007C94), Color(0x4D1A9BB8)),
    focus = Themed(Color(0x1F007C94), Color(0x331A9BB8)),
    focusOutline = Themed(Color(0x6600708A), Color(0x664FCBEA)),
)

private val L = CoTokens.List
private val N = CoTokens.FloatingNavBar

/** 一级页面给悬浮底栏让出的高度（DESIGN §6：栏高 + 8dp；系统导航条和末尾 32dp 由 [KtPage] 加）。 */
val TabBarRoom: Dp = N.height + N.toNavBar

/**
 * 一页：灰底 + 可滚动内容 + 设计库顶栏。内容从顶栏底下滚过去，折叠大标题随滚动收进顶栏（DESIGN §8）。
 * [bottomExtra] 是一级页面给悬浮底栏让出的高度；系统导航条和末尾的 32dp 这里自己加。
 */
@Composable
fun KtPage(
    title: String,
    scroll: ScrollState = rememberScrollState(),
    onBack: (() -> Unit)? = null,
    actions: List<CoBarAction> = emptyList(),
    bottomExtra: Dp = 0.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val status = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(Modifier.fillMaxSize().background(CoTokens.Color.bgGrouped.current)) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(scroll)
                .padding(top = status + CoTokens.TopBar.largeTitleHeight, bottom = nav + L.listBottomPadding + bottomExtra),
            content = content,
        )
        CoTopBar(
            title = title,
            modifier = Modifier.align(Alignment.TopCenter),
            navigation = onBack?.let { CoBarAction("返回", onClick = it, icon = { tint -> CoBackIcon(tint) }) },
            actions = actions,
            scrolledPx = { scroll.value.toFloat() },
            largeTitle = true,
            snap = scroll,
        )
    }
}

/** 卡片与卡片之间（不带分组标题时）。带标题的间距由 CoCategoryTitle 自己的上边距给。 */
@Composable
fun GroupGap() = Spacer(Modifier.height(L.groupTop))

/** 页脚说明：卡片外、与卡片里的文字对齐，12sp 次要色。只放隐私、数据上传这类必须写的话（DESIGN §10）。 */
@Composable
fun Footer(text: String) {
    BasicText(
        text,
        Modifier.fillMaxWidth().padding(start = L.categoryIndent, end = L.categoryIndent, top = L.categoryMarginV),
        style = CoTokens.Type.bodyXS.toTextStyle().copy(color = CoTokens.Color.label2.current),
    )
}

/** 元信息的分隔符（DESIGN §9：多段用“ ｜ ”连成一行，分隔符再淡一级）。 */
private const val META_SEPARATOR = " ｜ "

@Composable
fun metaText(parts: List<String>): AnnotatedString {
    val separator = CoTokens.Color.label3.current
    return buildAnnotatedString {
        parts.filter { it.isNotEmpty() }.forEachIndexed { i, part ->
            if (i > 0) withStyle(SpanStyle(color = separator)) { append(META_SEPARATOR) }
            append(part)
        }
    }
}

/** 卡片分组里第 [i] 行（共 [n] 行）的位置。 */
fun positionOf(i: Int, n: Int): CoCardPosition = when {
    n == 1 -> CoCardPosition.Full
    i == 0 -> CoCardPosition.Head
    i == n - 1 -> CoCardPosition.Tail
    else -> CoCardPosition.Middle
}

/** 点开弹出菜单的一行：右侧当前值 + 上下箭头，菜单从行尾弹出（COUIMenuPreference）。选中即保存，不弹 toast（DESIGN §11.2）。 */
@Composable
fun MenuRow(title: String, position: CoCardPosition, value: String, items: List<CoMenuItem>) {
    var open by remember { mutableStateOf(false) }
    Box {
        CoListItem(title, position, trailing = CoTrailing.Menu(value), onClick = { open = true })
        // 锚点放在行尾的当前值上：锚在整行上的话，菜单右缘会对到屏幕边缘外
        Box(Modifier.align(Alignment.CenterEnd).padding(end = L.cardMarginH + L.paddingH)) { CoPopupMenu(open, { open = false }, items) }
    }
}

/** 页面里的图标按钮。库外自绘控件，触控区不小于 48dp（DESIGN §16）；按压叠圆形蒙层。 */
@Composable
fun IconButton(glyph: Glyph, contentDescription: String, onClick: () -> Unit, enabled: Boolean = true) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier.size(48.dp)
            .clickable(interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        CoPressMask(interaction, CoCircleShape, L.pressMask, L.pressMaskMinProgress, Modifier.size(CoTokens.TopBar.buttonSize).clip(CoCircleShape))
        GlyphIcon(glyph, if (enabled) CoTokens.Color.label1.current else CoTokens.Color.label3.current)
    }
}
