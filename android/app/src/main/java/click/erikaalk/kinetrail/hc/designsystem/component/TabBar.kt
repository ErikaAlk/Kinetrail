package click.erikaalk.kinetrail.hc.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.designsystem.FocusRingPlacement
import click.erikaalk.kinetrail.hc.designsystem.KtBackdrop
import click.erikaalk.kinetrail.hc.designsystem.KtElevation
import click.erikaalk.kinetrail.hc.designsystem.KtMaterial
import click.erikaalk.kinetrail.hc.designsystem.KtMotion
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.ktColorTween
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing
import click.erikaalk.kinetrail.hc.designsystem.ktShadow
import click.erikaalk.kinetrail.hc.designsystem.navMaterial

/** 底栏的尺寸与内容避让口径，全部是全局 4.6 的确定值。 */
object KtTabBar {

    /** 紧凑默认高度。系统字号放大时由 `heightIn` 继续长高，不是定值。 */
    val minHeight = 64.dp

    /** 条到安全区顶边的距离。 */
    val bottomGap = KtSpacing.space2

    /** 条到视口左右边。 */
    val sideMargin = KtSpacing.space4

    /** 单个目的地的最小宽度，条按内容定宽，不铺满屏幕——铺满就不是悬浮条了。 */
    val tabMinWidth = 88.dp

    /**
     * 滚动容器底部要让开的高度，安全区由调用方另加。
     *
     * 条高 + 条到安全区的间距 + 一档内容余量：最后一个内容项要能整个滚到条上方，
     * 只让开条自己的高度会让它贴在条的下缘。[barHeight] 传量出来的实际条高：
     * 系统字号放大后条会比 [minHeight] 高，按定值让开会让最后一行压在条底下。
     */
    fun contentInset(barHeight: Dp): Dp = barHeight + bottomGap + KtSpacing.space4
}

/** 底栏上的一个一级目的地。 */
class KtTabItem(
    val label: String,
    @param:DrawableRes val icon: Int,
    val selected: Boolean,
    val onClick: () -> Unit,
)

/**
 * 悬浮底栏。少量长期存在的一级目的地（2–5 个）走这个，不做侧栏也不做 More 层级。
 *
 * 材质是 `material.floating`：背后内容的实时模糊 + 半透明材质层 + 镜面描边，
 * 三层的圆角都是 [KtRadius.full]。**它必须画在被采样的内容之外**，
 * 否则采样会把自己也圈进去（见 [KtBackdrop]）。
 *
 * 选中项用 `accent.text`，未选中用 `text.secondary`，不加内层胶囊——图标和标签
 * 一起换色已经足够识别，再叠一层填充就是额外的视觉重量。颜色过渡走 `motion.immediate`。
 */
@Composable
fun KtTabBar(
    items: List<KtTabItem>,
    backdrop: KtBackdrop,
    modifier: Modifier = Modifier,
) {
    val colors = ktColors
    Row(
        modifier
            .padding(horizontal = KtTabBar.sideMargin)
            .ktShadow(KtElevation.level2, KtRadius.full, colors.isDark)
            .clip(KtRadius.full)
            .navMaterial(backdrop)
            .border(KtMaterial.navStrokeWidth, KtMaterial.navStroke(colors.isDark), KtRadius.full)
            .heightIn(min = KtTabBar.minHeight)
            .padding(KtSpacing.space2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { Tab(it) }
    }
}

@Composable
private fun Tab(item: KtTabItem) {
    val colors = ktColors
    val interaction = remember { MutableInteractionSource() }
    val tint by animateColorAsState(
        targetValue = if (item.selected) colors.accent.text else colors.text.secondary,
        animationSpec = ktColorTween(KtMotion.IMMEDIATE),
        label = "tabTint",
    )
    Column(
        Modifier
            // 焦点环画在里面：往外扩会被条的胶囊 clip 切掉，理由见 FocusRingPlacement。
            .ktFocusRing(interaction, KtRadius.full, FocusRingPlacement.Inside)
            .clip(KtRadius.full)
            .selectable(
                selected = item.selected,
                interactionSource = interaction,
                indication = LocalIndication.current,
                role = Role.Tab,
                onClick = item.onClick,
            )
            .defaultMinSize(minWidth = KtTabBar.tabMinWidth, minHeight = 48.dp)
            .padding(horizontal = KtSpacing.Padding.controlX, vertical = KtSpacing.space1),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            painter = painterResource(item.icon),
            // 图标不重复朗读标签：整个目的地是一个可选对象
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(24.dp),
        )
        Text(
            item.label,
            style = KtType.caption,
            color = tint,
            modifier = Modifier.padding(top = KtSpacing.Gap.related),
        )
    }
}
