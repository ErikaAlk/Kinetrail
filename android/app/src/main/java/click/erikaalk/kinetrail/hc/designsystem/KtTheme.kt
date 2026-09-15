package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * 这套主题对齐的全局设计规范版本。
 *
 * 全局 10.1 要求每个项目记录它，并且**同一设备上的跨项目视觉对比只在版本一致时验收**。
 * 它是"这套实现按这一版规范重新做过"的标记，不是一个可以单独抬高的数字：
 * 规范升版时必须整套重过色板、字号、材质和场景契约，改完才动它。
 */
const val KT_DESIGN_SYSTEM_REVISION = "2026.09.05-material-contract"

/**
 * 主题入口。颜色、字号、间距、圆角、材质、动效六组 Token 都从这里进 Composition，
 * 业务组件只消费语义角色，不散写十六进制、sp、dp 和动画时长。
 *
 * Light 与 Dark 是[两套独立映射][lightKtColors]，不是反色。
 *
 * 减少动态只读系统设置（动画时长缩放为 0）；材质回退由设备能力决定。
 */
@Composable
fun KtTheme(
    darkTheme: Boolean,
    reducedMotion: Boolean = false,
    materialMode: KtMaterialMode = KtMaterialMode.Blurred,
    content: @Composable () -> Unit,
) {
    val colors = remember(darkTheme) { if (darkTheme) darkKtColors() else lightKtColors() }
    val context = LocalContext.current
    val systemReduced = remember(context) { systemReducedMotion(context) }

    CompositionLocalProvider(
        LocalKtColors provides colors,
        LocalReducedMotion provides (reducedMotion || systemReduced),
        LocalMaterialMode provides materialMode,
        LocalContentColor provides colors.text.primary,
    ) {
        MaterialTheme(
            colorScheme = colors.toMaterialScheme(),
            typography = ktTypography,
            content = content,
        )
    }
}

/** 取当前主题色板。 */
val ktColors: KtColors
    @Composable @ReadOnlyComposable get() = LocalKtColors.current

/**
 * 把语义角色桥接到 Material3，让 ModalBottomSheet、Switch、Snackbar
 * 这些原生控件直接落在我们的色板上。
 *
 * 优先用框架原生控件加语义主题映射，不重造基础交互。
 */
private fun KtColors.toMaterialScheme(): ColorScheme {
    val base = if (isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        // primary 在 Material3 里同时充当"填充色"和"强调文字色"。这里指向 accent.text：
        // TextButton、光标、聚焦边框这些默认拿 primary 当前景色，用 accent.primary
        // 在浅色 canvas 上不够正文 AA。需要填充时由调用方显式传 accent.primary。
        primary = accent.text,
        onPrimary = text.inverse,
        primaryContainer = accent.subtle,
        onPrimaryContainer = accent.text,

        background = canvas,
        onBackground = text.primary,

        // Sheet 这些浮层走 surface 系列，所以指到 surfaceElevated
        surface = surfaceElevated,
        onSurface = text.primary,
        surfaceVariant = fill.control,
        onSurfaceVariant = text.secondary,
        surfaceContainerLowest = canvas,
        surfaceContainerLow = surface,
        surfaceContainer = surfaceElevated,
        surfaceContainerHigh = surfaceElevated,
        surfaceContainerHighest = surfaceElevated,

        error = semantic.error.text,
        onError = semantic.error.onSolid,
        errorContainer = semantic.error.subtle,
        onErrorContainer = semantic.error.text,

        // outline 是原生控件的**边界**，按全局 2.1 至少 3:1，所以指到 border
        // 而不是 separator.strong——后者是分隔线的角色，画出来等于没有边界。
        outline = border,
        outlineVariant = separator.subtle,
        scrim = scrim,

        inverseSurface = text.primary,
        inverseOnSurface = text.inverse,
    )
}

// 全局 9.2：原生 Material 控件的可见文字仍要映射到本文 Token，
// 不能以"原生默认字号"为由跳过。
private val ktTypography = Typography(
    displayLarge = KtType.pageTitle,
    displayMedium = KtType.pageTitle,
    displaySmall = KtType.pageTitle,
    headlineLarge = KtType.pageTitle,
    headlineMedium = KtType.title,
    headlineSmall = KtType.title,
    titleLarge = KtType.pageTitle,
    titleMedium = KtType.title,
    titleSmall = KtType.sectionTitle,
    bodyLarge = KtType.body,
    bodyMedium = KtType.body,
    bodySmall = KtType.secondary,
    labelLarge = KtType.button,
    labelMedium = KtType.secondary,
    labelSmall = KtType.caption,
)
