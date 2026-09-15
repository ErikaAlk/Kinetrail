package click.erikaalk.kinetrail.hc.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.designsystem.KtMotion
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.ktColorTween
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing

/** 触控下限，同时也是按钮高度。 */
private val BUTTON_MIN_HEIGHT = 48.dp

/** 图标按钮的尺寸。顶栏要拿它算紧凑标题的左边界，所以是公开的。 */
object KtIconButton {
    /** 命中区。视觉图形 20–24dp，命中区不跟着缩。 */
    val size = 48.dp
}

private val ICON_BUTTON_SIZE = KtIconButton.size

/**
 * 主操作按钮。**一个决策点最多一个**——两个填充按钮并排，用户得先读完才知道该点哪个。
 *
 * 设置页里没有它：那一页每一行都是平级的开关和入口，没有"主操作"。
 * 需要它的是详情页和弹窗这种一屏只为一件事存在的地方。
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()

    val background by animateColorAsState(
        targetValue = when {
            !enabled -> colors.fill.control
            pressed -> colors.accent.pressed
            focused -> colors.accent.hover
            else -> colors.accent.primary
        },
        animationSpec = ktColorTween(KtMotion.IMMEDIATE),
        label = "primaryButtonBackground",
    )

    Box(
        modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = BUTTON_MIN_HEIGHT)
            // 焦点环画在外面：按钮不像行那样贴着 Card 边缘，扩出去不会被切
            .ktFocusRing(interaction, KtRadius.mediumShape)
            .clip(KtRadius.mediumShape)
            .background(background)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(
                horizontal = KtSpacing.Padding.controlX,
                vertical = KtSpacing.Padding.controlY,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = KtType.button,
            // Disabled 用 text.disabled 这个角色，不整体调 alpha——调 alpha 会掉到对比度以下
            color = if (enabled) colors.accent.onAccent else colors.text.disabled,
        )
    }
}

/**
 * 次操作。**同一决策点里跟在主按钮后面的那个**，不是"另一个主按钮换了个颜色"。
 *
 * 用描边而不是填充：全局 1.5 的视觉重量预算里，一个决策点只给一个填充块，
 * 第二个动作靠边界识别就够。边界用 `border` 这个角色（对全部控件承载面 ≥3:1），
 * 不用 `separator.strong`——那是分隔线的角色，画出来撑不住"边界是唯一识别线索"这一条。
 */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()

    val background by animateColorAsState(
        targetValue = when {
            !enabled -> Color.Transparent
            pressed -> colors.fill.pressed
            focused -> colors.fill.hover
            else -> Color.Transparent
        },
        animationSpec = ktColorTween(KtMotion.IMMEDIATE),
        label = "secondaryButtonBackground",
    )

    Box(
        modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = BUTTON_MIN_HEIGHT)
            .ktFocusRing(interaction, KtRadius.mediumShape)
            .clip(KtRadius.mediumShape)
            .background(background)
            .border(
                width = 1.dp,
                color = if (enabled) colors.border else colors.separator.subtle,
                shape = KtRadius.mediumShape,
            )
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(
                horizontal = KtSpacing.Padding.controlX,
                vertical = KtSpacing.Padding.controlY,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = KtType.button,
            color = if (enabled) colors.text.primary else colors.text.disabled,
        )
    }
}

/**
 * 只有图标的动作。**必须给 [contentDescription]**——触屏和读屏用户拿不到 Tooltip，
 * 常驻文字之外唯一的等价获取方式就是它。
 *
 * 只给含义明确的高频动作用（返回、关闭、切换外观）。低频、危险或含义不清的动作
 * 必须有常驻文字。
 */
@Composable
fun KtIconButton(
    @DrawableRes icon: Int,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color? = null,
) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier
            .size(ICON_BUTTON_SIZE)
            .ktFocusRing(interaction, KtRadius.full)
            .clip(KtRadius.full)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = contentDescription,
            tint = tint ?: colors.text.secondary,
            modifier = Modifier.size(24.dp),
        )
    }
}
