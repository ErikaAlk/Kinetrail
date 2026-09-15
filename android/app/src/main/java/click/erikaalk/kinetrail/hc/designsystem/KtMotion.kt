package click.erikaalk.kinetrail.hc.designsystem

import android.content.Context
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.TweenSpec
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * 动效。**静态状态克制，状态之间柔和。**
 *
 * 动效用来解释"发生了什么"，不做入场表演：Hover 不夸张放大，
 * 主按钮不做 Glow 或弹跳。时长是固定值，不是区间。
 *
 * 曲线用全局 2.7 的两条，不是 Web 缓动。
 */
object KtMotion {

    /** Pressed、颜色反馈。 */
    const val IMMEDIATE = 120

    /** Toggle、Indicator、局部展开。 */
    const val SMALL = 180

    /** Sheet、Dialog、页面内层级切换。 */
    const val MEDIUM = 260

    /** 重要空间转换。确有必要时才用。 */
    const val LARGE = 360

    /** 进入与状态变化。 */
    val enter: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    /** 离场。 */
    val exit: Easing = CubicBezierEasing(0.4f, 0f, 1f, 1f)

    /** 减少动态时，颜色和透明度反馈统一压到这个时长——是压短，不是取消。 */
    const val REDUCED_FEEDBACK = 100
}

/**
 * "减少动态效果"。
 *
 * 打开时**位移和缩放时长归零，颜色和透明度改成 100ms**。
 * 关掉动画不等于关掉反馈，所以不是一律清零。
 *
 * 值来自系统的动画时长缩放为 0。
 */
val LocalReducedMotion = staticCompositionLocalOf { false }

internal fun systemReducedMotion(context: Context): Boolean = runCatching {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
}.getOrDefault(false)

/** 颜色 / 透明度动画。组件不要自己写 `tween(300)`。 */
@Composable
@ReadOnlyComposable
fun <T> ktColorTween(
    durationMillis: Int,
    easing: Easing = KtMotion.enter,
): TweenSpec<T> = tween(
    durationMillis = if (LocalReducedMotion.current) KtMotion.REDUCED_FEEDBACK else durationMillis,
    easing = easing,
)

/** 位移 / 缩放动画。减少动态时直接到位，不做中间过程。 */
@Composable
@ReadOnlyComposable
fun <T> ktTransformTween(
    durationMillis: Int,
    easing: Easing = KtMotion.enter,
): TweenSpec<T> = tween(
    durationMillis = if (LocalReducedMotion.current) 0 else durationMillis,
    easing = easing,
)
