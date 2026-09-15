package click.erikaalk.kinetrail.hc.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.designsystem.FocusRingPlacement
import click.erikaalk.kinetrail.hc.designsystem.KtMotion
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.ktColorTween
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing

/** 单行设置项。全局「Settings 默认结构」的 Mobile 定值，正好等于触控下限。 */
private val ROW_MIN_HEIGHT = 48.dp

/** 带一行说明时的最小高度。 */
private val ROW_MIN_HEIGHT_WITH_SUBTITLE = 64.dp

/** 行首图标槽。图标本身 20dp，底块 32dp，两者都不改变触控命中区。 */
val ROW_ICON_SLOT = 32.dp
private val ROW_ICON_SIZE = 20.dp

/**
 * 行尾 › 的尺寸。**全页一个值**，不在各处随手写。
 *
 * 比行首图标小一档（18 对 20）、颜色用 `text.tertiary`：它是"还有下一屏"的提示，
 * 不是内容，重量必须低于行标题。右侧距离由行自己的内边距决定，所以每一行的 › 都收在同一条线上。
 */
private val ROW_CHEVRON_SIZE = 18.dp

/**
 * 行内容距容器左右边缘的距离。
 *
 * 在 Card 里是 Card 的水平内边距，在浮层里是页面边距。由 [SettingsSection] 注入，
 * 调用方不用管。注意内边距加在**行自己身上**而不是 Card 上：
 * 那样 Pressed 的填充才能铺满整张 Card 的宽度。
 */
internal val LocalRowInset = staticCompositionLocalOf { KtSpacing.cardPaddingX }

/**
 * 行首图标。统一 20dp 线条图标、统一描边重量、统一中性色，来自同一个图标家族。
 *
 * **同级的行用同一种图标语气，没有底块。** 全局 2.6 允许设置页配少量低饱和底色，
 * 但那是用来**分类**的；按「每组第一行」上色分不出任何类，只是给每组挑一行加重量，
 * 反而让同级的行看起来不同级。分不出类就全用中性。
 *
 * 不用彩色 Emoji：它的渲染跨系统不一致，尺寸和光学重量也对不齐相邻文字。
 */
@Composable
fun RowIcon(
    @DrawableRes icon: Int,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = ktColors
    val tint = if (enabled) colors.text.secondary else colors.text.disabled
    Box(
        modifier.size(ROW_ICON_SLOT),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(icon),
            // 图标不重复朗读行标题：整行已经是一个可点对象，图标只是视觉线索
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(ROW_ICON_SIZE),
        )
    }
}

/**
 * 行与行之间的分割线，从**文字起始线**开始，不通栏，也不切穿外圆角。
 *
 * 分割线只用在确实需要视觉边界的相邻内容之间，不为每一行机械加线。
 */
@Composable
fun RowDivider(modifier: Modifier = Modifier, inset: Dp = LocalRowInset.current) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(0.5.dp)
            .background(ktColors.separator.subtle),
    )
}

/**
 * 一行设置。[trailing] 放右侧控件或值。
 *
 * [enabled] = false 时**整个语义单元一起降级**（标题、副标题、值、右侧控件），
 * 不是只把控件灰掉。降级用 `text.disabled` 这个角色，不用整体调 alpha
 * ——调 alpha 会把文字压到对比度以下。
 */
@Composable
fun SettingRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    value: String? = null,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
    /**
     * 行尾的 ›。**只给"点了会打开另一个页面"的行**，原地执行的动作行不给
     * ——它表示"还有下一屏"，用在动作上是骗人。
     */
    chevron: Boolean = false,
    role: Role = Role.Button,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
    val actionable = onClick != null && enabled

    // Android 是触控优先，没有 Hover；Pressed 用中性填充给即时反馈，
    // Focus 是外接键盘时才出现的那一态，另外画一圈焦点环。
    val background by animateColorAsState(
        targetValue = when {
            !actionable -> Color.Transparent
            pressed -> colors.fill.pressed
            focused -> colors.fill.hover
            else -> Color.Transparent
        },
        animationSpec = ktColorTween(KtMotion.IMMEDIATE),
        label = "rowBackground",
    )

    val titleColor = if (enabled) colors.text.primary else colors.text.disabled
    // fill.hover / fill.pressed 不在文字承载面保证集合里，所以整行按下时
    // 行内辅助文字用 secondary，不用 tertiary。
    val supportColor = if (enabled) colors.text.secondary else colors.text.disabled

    Row(
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (actionable) {
                    Modifier.clickable(
                        interactionSource = interaction,
                        indication = null,
                        role = role,
                        onClick = onClick,
                    )
                } else {
                    Modifier
                },
            )
            .background(background)
            // 焦点环画在行里面：行是通栏坐在圆角 Card 里的，往外扩会被 Card 的 clip 切掉。
            // 登记为项目覆盖，理由见 FocusRingPlacement。
            .ktFocusRing(
                focused = focused && actionable,
                shape = KtRadius.smallShape,
                colors = colors,
                placement = FocusRingPlacement.Inside,
            )
            .defaultMinSize(
                minHeight = if (subtitle == null) ROW_MIN_HEIGHT else ROW_MIN_HEIGHT_WITH_SUBTITLE,
            )
            .padding(
                horizontal = LocalRowInset.current,
                vertical = KtSpacing.Padding.controlY,
            )
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        if (icon != null) {
            RowIcon(
                icon = icon,
                enabled = enabled,
                modifier = Modifier.padding(end = KtSpacing.Gap.inline),
            )
        }
        Column(Modifier.weight(1f, fill = true)) {
            Text(title, style = KtType.body, color = titleColor)
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = KtType.secondary,
                    color = supportColor,
                    modifier = Modifier.padding(top = KtSpacing.Gap.related),
                )
            }
        }
        if (value != null) {
            Text(
                value,
                style = KtType.body,
                color = supportColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = KtSpacing.Gap.inline),
            )
        }
        if (trailing != null) {
            CompositionLocalProvider(LocalContentColor provides supportColor) {
                Box(Modifier.padding(start = KtSpacing.Gap.control)) { trailing() }
            }
        }
        if (chevron) {
            Icon(
                painter = painterResource(R.drawable.ic_chevron_right),
                // 读屏不用听"箭头"：整行已经是一个按钮，它只是视觉上的可点提示
                contentDescription = null,
                tint = if (enabled) colors.text.tertiary else colors.text.disabled,
                modifier = Modifier
                    .padding(start = KtSpacing.Gap.inline)
                    .size(ROW_CHEVRON_SIZE),
            )
        }
    }
}

