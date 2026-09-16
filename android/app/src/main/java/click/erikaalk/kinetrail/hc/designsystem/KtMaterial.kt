package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
 * 两个材质角色：通栏顶栏和悬浮底栏（都属于 `material.floating` 的导航层）。没有弹窗材质。
 *
 * 顶栏参数沿用已确认的 Android 基础参考（design-references/android-reference.md）：模糊 24dp，
 * 厚度浅 0.72 / 深 0.66，无模糊回退 0.96 / 0.94。换色板后由 [KtMaterialContrastTest]
 * 按最终合成背景重新验过，没有改值。
 */
object KtMaterial {
    val isBlurSupported: Boolean get() = HazeDefaults.blurEnabled()

    val headerBlurRadius = 24.dp

    /** 悬浮底栏的模糊半径。全局 4.6 悬浮导航的默认值；顶栏那档 24 是通栏条的口径。 */
    val navBlurRadius = 10.dp

    const val HEADER_LIGHT_ALPHA = 0.72f
    const val HEADER_DARK_ALPHA = 0.66f
    const val FALLBACK_LIGHT_ALPHA = 0.96f
    const val FALLBACK_DARK_ALPHA = 0.94f

    /**
     * 悬浮底栏的材质厚度。**登记在案的项目覆盖**：全局 4.6 的默认是浅 0.48 / 深 0.44。
     *
     * 底栏底下会经过 `accent.primary` 的填充块（日历里选中的日期格、详情页的主按钮），
     * 0.48 那一档未选中标签只剩 2.63:1（浅）/ 2.29:1（深），过不了 caption 的 4.5:1。
     * 收到 0.86 / 0.80 之后最差档回到 4.69:1 / 4.77:1，由 [KtMaterialContrastTest] 钉住。
     * 想更通透只能先换掉"强色填充可以滚到条底下"这件事，不能直接减材质。
     */
    const val NAV_LIGHT_ALPHA = 0.86f
    const val NAV_DARK_ALPHA = 0.80f

    /** 镜面描边。悬浮条的左右边在屏幕内，需要它交代边界；通栏顶栏不画。 */
    val navStrokeWidth = 0.75.dp
    private const val NAV_STROKE_LIGHT_ALPHA = 0.90f
    private const val NAV_STROKE_DARK_ALPHA = 0.30f

    fun headerAlpha(isDark: Boolean, blurred: Boolean): Float = when {
        !blurred -> if (isDark) FALLBACK_DARK_ALPHA else FALLBACK_LIGHT_ALPHA
        isDark -> HEADER_DARK_ALPHA
        else -> HEADER_LIGHT_ALPHA
    }

    fun navAlpha(isDark: Boolean, blurred: Boolean): Float = when {
        !blurred -> if (isDark) FALLBACK_DARK_ALPHA else FALLBACK_LIGHT_ALPHA
        isDark -> NAV_DARK_ALPHA
        else -> NAV_LIGHT_ALPHA
    }

    /** 上亮下透的竖直渐变，不是一圈等亮的描边——那样看着是个边框，不是高光。 */
    fun navStroke(isDark: Boolean): Brush = Brush.verticalGradient(
        listOf(
            Color.White.copy(alpha = if (isDark) NAV_STROKE_DARK_ALPHA else NAV_STROKE_LIGHT_ALPHA),
            Color.White.copy(alpha = 0f),
        ),
    )

    internal fun headerStyle(colors: KtColors) = HazeStyle(
        backgroundColor = colors.canvas,
        tint = HazeTint(colors.surfaceElevated.copy(alpha = headerAlpha(colors.isDark, true))),
        blurRadius = headerBlurRadius,
        noiseFactor = 0f,
        fallbackTint = HazeTint(colors.surfaceElevated.copy(alpha = headerAlpha(colors.isDark, false))),
    )

    internal fun navStyle(colors: KtColors) = HazeStyle(
        backgroundColor = colors.canvas,
        tint = HazeTint(colors.surfaceElevated.copy(alpha = navAlpha(colors.isDark, true))),
        blurRadius = navBlurRadius,
        noiseFactor = 0f,
        fallbackTint = HazeTint(colors.surfaceElevated.copy(alpha = navAlpha(colors.isDark, false))),
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

/** 悬浮底栏材质。镜面描边由 `KtTabBar` 自己画在这一层之上，两者的圆角必须是同一个。 */
@Composable
fun Modifier.navMaterial(backdrop: KtBackdrop): Modifier {
    val colors = ktColors
    return when (ktMaterialMode) {
        KtMaterialMode.Solid -> background(colors.surfaceElevated.copy(alpha = KtMaterial.navAlpha(colors.isDark, false)))
        KtMaterialMode.Blurred -> hazeEffect(state = backdrop.haze, style = KtMaterial.navStyle(colors))
    }
}
