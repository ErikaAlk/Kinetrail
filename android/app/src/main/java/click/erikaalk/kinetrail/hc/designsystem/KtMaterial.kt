package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeDefaults
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState

/** [Blurred] 为正常表现；[Solid] 是设备没有可靠模糊能力时的语义实色回退。 */
enum class KtMaterialMode { Blurred, Solid }

val LocalMaterialMode = staticCompositionLocalOf { KtMaterialMode.Blurred }

val ktMaterialMode: KtMaterialMode
    @Composable @ReadOnlyComposable
    get() = if (KtMaterial.isBlurSupported) LocalMaterialMode.current else KtMaterialMode.Solid

/**
 * 本 App 只有一个材质角色：通栏顶栏（`material.floating` 的顶部操作层）。没有悬浮导航和弹窗材质。
 *
 * 参数沿用已确认的 Android 基础参考（design-references/android-reference.md）：模糊 24dp，
 * 顶栏厚度浅 0.72 / 深 0.66，无模糊回退 0.96 / 0.94。换色板后由 [KtMaterialContrastTest]
 * 按最终合成背景重新验过，没有改值。
 */
object KtMaterial {
    val isBlurSupported: Boolean get() = HazeDefaults.blurEnabled()

    val headerBlurRadius = 24.dp

    const val HEADER_LIGHT_ALPHA = 0.72f
    const val HEADER_DARK_ALPHA = 0.66f
    const val FALLBACK_LIGHT_ALPHA = 0.96f
    const val FALLBACK_DARK_ALPHA = 0.94f

    fun headerAlpha(isDark: Boolean, blurred: Boolean): Float = when {
        !blurred -> if (isDark) FALLBACK_DARK_ALPHA else FALLBACK_LIGHT_ALPHA
        isDark -> HEADER_DARK_ALPHA
        else -> HEADER_LIGHT_ALPHA
    }

    internal fun headerStyle(colors: KtColors) = HazeStyle(
        backgroundColor = colors.canvas,
        tint = HazeTint(colors.surfaceElevated.copy(alpha = headerAlpha(colors.isDark, true))),
        blurRadius = headerBlurRadius,
        noiseFactor = 0f,
        fallbackTint = HazeTint(colors.surfaceElevated.copy(alpha = headerAlpha(colors.isDark, false))),
    )
}

/** 顶栏要采样的那块内容。haze 的类型不出这个文件（全局 4.6：不手写 GraphicsLayer 采样）。 */
@Stable
class KtBackdrop internal constructor(internal val haze: HazeState)

@Composable
fun rememberBackdrop(): KtBackdrop {
    val haze = rememberHazeState()
    return remember(haze) { KtBackdrop(haze) }
}

/** 挂在被采样的内容上；顶栏必须在这个范围之外。 */
fun Modifier.provideBackdrop(backdrop: KtBackdrop): Modifier = hazeSource(backdrop.haze)

/** 顶栏材质：背后内容的实时模糊 + 半透明材质层。通栏顶栏的左右边就是屏幕边，不画镜面描边。 */
@Composable
fun Modifier.headerMaterial(backdrop: KtBackdrop): Modifier {
    val colors = ktColors
    return when (ktMaterialMode) {
        KtMaterialMode.Solid -> background(colors.surfaceElevated.copy(alpha = KtMaterial.headerAlpha(colors.isDark, false)))
        KtMaterialMode.Blurred -> hazeEffect(state = backdrop.haze, style = KtMaterial.headerStyle(colors))
    }
}
