package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * 自绘 Surface 的阴影。
 *
 * 只有 Floating / Elevated Surface 才有阴影，普通 Surface 靠与 Canvas 的背景差建立层级。
 * **Border 与 Shadow 不默认同时出现。**
 *
 * 全局给的是结构化定义（`x / y / blur / spread / color`）。Compose 的 `shadow()` 不吃
 * 偏移和模糊半径，只吃一个 elevation，全局 2.5 因此要求"按视觉等价校准一次并把结果
 * 固化到主题，不逐字照搬数值"。这里的折算就是那一次校准的结果：
 * `elevation.1` 的 3px 模糊落到 2dp，`elevation.2` 的 16px 落到 8dp，
 * 透明度原样落到 ambient / spot 上。
 */
@Immutable
data class KtShadow(
    val elevation: Dp,
    private val lightAlpha: Float,
    private val darkAlpha: Float,
) {
    fun color(isDark: Boolean): Color = Color.Black.copy(alpha = if (isDark) darkAlpha else lightAlpha)
}

object KtElevation {

    /** `0 1 3`。轻微抬起。 */
    val level1 = KtShadow(elevation = 2.dp, lightAlpha = 0.10f, darkAlpha = 0.28f)

    /** `0 4 16`。Dialog、Sheet、悬浮导航条。 */
    val level2 = KtShadow(elevation = 8.dp, lightAlpha = 0.14f, darkAlpha = 0.32f)
}

fun Modifier.ktShadow(shadow: KtShadow, shape: Shape, isDark: Boolean): Modifier =
    shadow(
        elevation = shadow.elevation,
        shape = shape,
        ambientColor = shadow.color(isDark),
        spotColor = shadow.color(isDark),
    )
