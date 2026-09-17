package click.erikaalk.kinetrail.hc.designsystem.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.ktColors

/**
 * 收起时大标题的退场进度，0 = 完整显示，1 = 已经交给顶栏那一份。
 *
 * 由 `KtRoot` 提供。做成 CompositionLocal 而不是参数，是因为五个页面都调 [PageTitle]，
 * 而它们谁也不关心这个数——它属于顶栏和大标题之间的交接，不属于页面。
 * 和收起进度一样是**函数**：在绘制阶段才读，滚动不触发重组。
 */
val LocalTitleHandover = staticCompositionLocalOf<() -> Float> { { 0f } }

/**
 * 页面大标题。放在滚动内容的最前面，**和画布连续**——顶部没有另一条实色标题栏，
 * 也不再重复一遍应用名。
 *
 * 收起时它**在原地淡出**，同一瞬间顶栏那一份在同一个位置、同一个字号接上，
 * 然后继续往上、往右走进条里。两份的交接发生在还没分开的时候，所以看着是一个标题在动。
 *
 * 它把自己的**上下边**都报给 [onTitleBounds]，顶部导航据此分别算材质和紧凑标题的渐入进度：
 * 材质看顶边（有内容钻到条底下就该有分隔），紧凑标题看底边（大标题走干净了才出现）。
 *
 * 报的是 `positionInWindow` 而不是 `boundsInWindow`：后者会被滚动容器裁到边缘，
 * 标题滚出去之后就永远停在边界上，算不出滚了多远。
 */
@Composable
fun PageTitle(
    text: String,
    onTitleBounds: (top: Float, bottom: Float) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
) {
    val colors = ktColors
    Column(modifier.padding(horizontal = KtSpacing.Padding.pageX)) {
        val handover = LocalTitleHandover.current
        Text(
            text,
            style = KtType.pageTitle,
            color = colors.text.primary,
            modifier = Modifier
                .onGloballyPositioned {
                    val top = it.positionInWindow().y
                    onTitleBounds(top, top + it.size.height)
                }
                // 只改透明度，尺寸照旧——上报的边界必须一直是真实布局，不然收起进度会跟着抖
                .graphicsLayer { alpha = 1f - handover() },
        )
        if (subtitle != null) {
            Text(
                subtitle,
                style = KtType.secondary,
                color = colors.text.secondary,
                modifier = Modifier.padding(top = KtSpacing.Gap.related),
            )
        }
    }
}

/**
 * 一组设置。Mobile 的默认结构是 **Inset Grouped**：组标题在 Card 外，选项行在 Card 内。
 *
 * Card 是层级工具，不是装饰。规矩：
 * - 一张 Card 只承载一个语义组，不硬塞两组进去；
 * - 同层不许 Card 套 Card，单个开关或动作也不再包一层内层 Card；
 * - `surface` + `radius.large` + `separator.subtle` 描边、**无阴影**（描边的理由见 [cardSurface]）；
 * - 组内相邻行用 `separator.subtle`，从文字起始线开始画，不切穿外圆角；
 * - 同层连续超过 6 张 Card 就该考虑换成列表或分段页面。
 *
 * [footer] 是整组的说明或后果提示，画在 Card **下方**，不能夹在组标题和 Card 之间。
 * 只跟某一行有关的说明写进那一行的 `subtitle`。
 *
 * [hasIcons] = true 时分割线额外让开行首图标槽，落在文字起始线上。
 *
 * [card] = false 用于浮层内部：Sheet 本身已经是 `surfaceElevated`，
 * 在它上面再放 `surface` Card 在浅色下几乎看不见。
 */
@Composable
fun SettingsSection(
    rows: List<@Composable () -> Unit>,
    modifier: Modifier = Modifier,
    title: String? = null,
    footer: String? = null,
    hasIcons: Boolean = false,
    card: Boolean = true,
) {
    if (rows.isEmpty() && footer == null) return
    val colors = ktColors
    val inset = if (card) KtSpacing.cardPaddingX else KtSpacing.Padding.pageX
    val dividerInset = if (hasIcons) inset + ROW_ICON_SLOT + KtSpacing.Gap.inline else inset

    Column(modifier.fillMaxWidth().padding(top = KtSpacing.Gap.section)) {
        if (title != null) SectionHeader(title, contentInset = inset)

        CompositionLocalProvider(LocalRowInset provides inset) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .then(
                        if (card) {
                            Modifier
                                .padding(horizontal = KtSpacing.Padding.pageX)
                                .cardSurface()
                        } else {
                            Modifier
                        },
                    ),
            ) {
                rows.forEachIndexed { index, row ->
                    row()
                    if (index != rows.lastIndex) RowDivider(inset = dividerInset)
                }
            }
        }

        if (footer != null) SectionFooter(footer, contentInset = inset)
    }
}

/**
 * 组标题。固定 `sectionTitle` + `text.primary`，**必须比行标题大**。
 * 不许用 `secondary`、`caption`、整体透明度或 Disabled 色来画它。
 */
@Composable
fun SectionHeader(
    text: String,
    modifier: Modifier = Modifier,
    contentInset: Dp = KtSpacing.cardPaddingX,
) {
    Text(
        text = text,
        style = KtType.sectionTitle,
        color = ktColors.text.primary,
        modifier = modifier.padding(
            // 和 Card 里的文字起始线对齐
            start = KtSpacing.Padding.pageX + contentInset,
            end = KtSpacing.Padding.pageX + contentInset,
            bottom = KtSpacing.sectionTitleToCard,
        ),
    )
}

/** 组级说明。画在 Card 下方。 */
@Composable
fun SectionFooter(
    text: String,
    modifier: Modifier = Modifier,
    contentInset: Dp = KtSpacing.cardPaddingX,
) {
    Text(
        text = text,
        style = KtType.secondary,
        color = ktColors.text.secondary,
        modifier = modifier.padding(
            start = KtSpacing.Padding.pageX + contentInset,
            end = KtSpacing.Padding.pageX + contentInset,
            top = KtSpacing.cardToFooter,
        ),
    )
}

/**
 * 独立的一张 Card，给不是「行」的内容用（详情页的属性组、正文块这类）。
 * 规矩和 [SettingsSection] 的 Card 一样：surface、large 圆角、描边、无阴影、不嵌套。
 */
@Composable
fun KtCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KtSpacing.Padding.pageX)
            .cardSurface()
            .padding(
                horizontal = KtSpacing.cardPaddingX,
                vertical = KtSpacing.Padding.container,
            ),
        content = content,
    )
}

/**
 * Card 的底：`surface` 填充加一圈 `separator.subtle`。
 *
 * 全局 2.5 规定普通 Surface 与 Canvas 对比度低于 1.1:1 时加这圈描边。本 App 两套都不够
 * （浅 1.035、深 1.074），深色下只靠背景差时卡片几乎融进画布，真机上看不出边界。
 */
@Composable
private fun Modifier.cardSurface(): Modifier {
    val colors = ktColors
    return clip(KtRadius.largeShape)
        .background(colors.surface)
        .border(1.dp, colors.separator.subtle, KtRadius.largeShape)
}
