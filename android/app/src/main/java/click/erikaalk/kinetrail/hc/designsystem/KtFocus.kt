package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.unit.dp

/**
 * 焦点环。全局 2.5「Focus 指示」：**可见 Focus 是底线**，不能用"点一下就没了"
 * 或者只换个填充色来顶替。
 *
 * 默认是 `accent.focus` 2dp 的环，向外偏移 2dp，中间那圈露出控件所在的 Surface。
 */
object KtFocusRing {
    /** 环本身的粗细。 */
    val width = 2.dp

    /** 环与控件之间那圈缝，露出控件所在的 Surface。 */
    val gap = 2.dp

    /** 双色环的内圈：彩色底上靠它把控件本体和外圈分开。 */
    val innerWidth = 1.dp
}

/**
 * 焦点环画在控件外面还是里面。
 *
 * 全局默认是 [Outside]。[Inside] 是**登记在案的项目覆盖**，只给通栏坐在圆角容器里的
 * 元素用：设置行外扩会被 Card 的 `clip` 切掉，导航项外扩会被胶囊切掉。
 * 全局同时要求「焦点环不得被父容器裁剪」，这两处画在里面才满足那一条。
 */
enum class FocusRingPlacement { Outside, Inside }

/**
 * 给控件挂焦点环。和 `clickable` 共用同一个 [interaction]，别各开一个。
 *
 * [onColoredSurface] = true 时画**双色环**：外圈 `accent.focus`，内圈 1dp 的
 * `canvas`（深色下用 `surfaceElevated`）。彩色填充上单色环压在同色系的块上分不出边界。
 *
 * 放在 `clip` / `background` **之前**——修饰符是由外向内包的，
 * 放在后面会被自己的 `clip` 切掉。
 */
@Composable
fun Modifier.ktFocusRing(
    interaction: MutableInteractionSource,
    shape: Shape,
    placement: FocusRingPlacement = FocusRingPlacement.Outside,
    onColoredSurface: Boolean = false,
): Modifier {
    val focused by interaction.collectIsFocusedAsState()
    val colors = ktColors
    return ktFocusRing(focused, shape, colors, placement, onColoredSurface)
}

/** 已经自己收好焦点状态时用这个重载。 */
fun Modifier.ktFocusRing(
    focused: Boolean,
    shape: Shape,
    colors: KtColors,
    placement: FocusRingPlacement = FocusRingPlacement.Outside,
    onColoredSurface: Boolean = false,
): Modifier = drawWithContent {
    drawContent()
    if (!focused) return@drawWithContent

    val ring = KtFocusRing.width.toPx()
    val gap = KtFocusRing.gap.toPx()
    val inner = KtFocusRing.innerWidth.toPx()
    val outward = placement == FocusRingPlacement.Outside
    val sign = if (outward) 1f else -1f

    // 彩色底上，控件紧挨着的第一圈是画出来的浅色；普通底上那一圈留空，露出 Surface。
    val innerBand = if (onColoredSurface) inner else gap

    if (onColoredSurface) {
        drawRing(
            shape = shape,
            expand = sign * inner / 2f,
            strokeWidth = inner,
            color = if (colors.isDark) colors.surfaceElevated else colors.canvas,
        )
    }
    drawRing(
        shape = shape,
        expand = sign * (innerBand + ring / 2f),
        strokeWidth = ring,
        color = colors.accent.focus,
    )
}

/** [expand] 为正向外长，为负向内缩。 */
private fun DrawScope.drawRing(shape: Shape, expand: Float, strokeWidth: Float, color: Color) {
    val width = size.width + expand * 2f
    val height = size.height + expand * 2f
    if (width <= 0f || height <= 0f) return
    val outline = shape.createOutline(Size(width, height), layoutDirection, this)
    translate(-expand, -expand) {
        drawOutline(outline, color = color, style = Stroke(width = strokeWidth))
    }
}
