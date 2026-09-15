package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * 语义颜色角色。业务代码只认这里的名字，不认视觉名（`green500` 这类），
 * 也不许自己 `copy(alpha = ...)` 临时造一个状态色——每个状态都有生成好的独立值。
 *
 * 三套体系互相独立：
 * - [KtColors] 的 Neutral 部分构成绝大部分界面，负责空间、结构和信息层级；
 * - [KtAccentColors] 负责品牌识别、当前选中和主要操作；
 * - [KtSemanticColors] 负责系统状态、结果和风险，**不受品牌色影响**。
 */
@Immutable
data class KtTextColors(
    val primary: Color,
    val secondary: Color,
    val tertiary: Color,
    val disabled: Color,
    val inverse: Color,
)

@Immutable
data class KtSeparatorColors(
    val subtle: Color,
    val strong: Color,
)

/** 中性控件填充。也是行的 Pressed / Focus 底色。 */
@Immutable
data class KtFillColors(
    val control: Color,
    val hover: Color,
    val pressed: Color,
)

@Immutable
data class KtAccentColors(
    val primary: Color,
    val hover: Color,
    val pressed: Color,
    val subtle: Color,
    val subtleHover: Color,
    val text: Color,
    val border: Color,
    val focus: Color,
    /** Default / Hover / Pressed 三态共用，交互时文字不会突然反色。 */
    val onAccent: Color,
)

/**
 * 一个语义色族的完整角色。
 *
 * [solid] 用于强状态和需要大面积辨识的状态图形。[onSolid] **逐族计算**，
 * 不是全套统一一个墨色——这套色板下八个族都落在墨字，那是算出来的结果，不是省事。
 *
 * 浅色 `warning.solid` 对 canvas 不足 3:1，是登记在案的标定例外：
 * 它可以作大面积填充，**作状态图形时必须加 [border] 描边**。
 */
@Immutable
data class KtSemanticFamily(
    val solid: Color,
    val subtle: Color,
    val text: Color,
    val border: Color,
    val onSolid: Color,
)

@Immutable
data class KtSemanticColors(
    val success: KtSemanticFamily,
    val warning: KtSemanticFamily,
    val error: KtSemanticFamily,
    val info: KtSemanticFamily,
)

@Immutable
data class KtColors(
    val isDark: Boolean,
    /** 页面基础背景。 */
    val canvas: Color,
    /** 空间或交互上独立的区域：设置组 Card、详情页属性组。 */
    val surface: Color,
    /** 位于内容上方：Dialog、Sheet、悬浮条的实色回退。 */
    val surfaceElevated: Color,
    /** 视觉上内嵌：只读的长正文、引文块。 */
    val surfaceSunken: Color,
    val text: KtTextColors,
    val separator: KtSeparatorColors,
    val fill: KtFillColors,
    /**
     * 控件边界（全局的 `border.default`）。
     *
     * **不是每个控件都要有边框。** 全局 2.1 的要求是：先看清承担识别作用的到底是轮廓、
     * 填充、图标还是状态标记，再测它和相邻背景。只有当边界确实是唯一识别线索、
     * 而填充又不够时，才必须让边界达标。
     *
     * 这个角色存在是为了那种情况：它对全部控件承载面 ≥3:1，有单测钉着。
     * 生成器给的候选值是浅灰 `#C7C8C5`（对白底 1.3:1），那种"看得见就行"的边界画出来
     * 等于没有——真要靠边界识别时它撑不住。
     */
    val border: Color,
    /**
     * 浮层背后的压暗层。
     *
     * 弹窗后方另有一层整页模糊，两者是**两个独立角色**：遮罩负责压暗和聚焦，
     * 模糊负责把后方内容推远。只做其中一层不算实现了两层，见 [KtMaterial]。
     */
    val scrim: Color,
    val accent: KtAccentColors,
    val semantic: KtSemanticColors,
)

/** 顺序照 [KtPalette] 的注释：solid / subtle / text / border / onSolid。 */
private fun family(values: IntArray) = KtSemanticFamily(
    solid = Color(values[0]),
    subtle = Color(values[1]),
    text = Color(values[2]),
    border = Color(values[3]),
    onSolid = Color(values[4]),
)

fun lightKtColors(): KtColors = KtColors(
    isDark = false,
    canvas = Color(KtPalette.Light.CANVAS),
    surface = Color(KtPalette.Light.SURFACE),
    surfaceElevated = Color(KtPalette.Light.SURFACE_ELEVATED),
    surfaceSunken = Color(KtPalette.Light.SURFACE_SUNKEN),
    text = KtTextColors(
        primary = Color(KtPalette.Light.TEXT_PRIMARY),
        secondary = Color(KtPalette.Light.TEXT_SECONDARY),
        tertiary = Color(KtPalette.Light.TEXT_TERTIARY),
        disabled = Color(KtPalette.Light.TEXT_DISABLED),
        inverse = Color(KtPalette.Light.TEXT_INVERSE),
    ),
    separator = KtSeparatorColors(
        subtle = Color(KtPalette.Light.SEPARATOR_SUBTLE),
        strong = Color(KtPalette.Light.SEPARATOR_STRONG),
    ),
    fill = KtFillColors(
        control = Color(KtPalette.Light.FILL_CONTROL),
        hover = Color(KtPalette.Light.FILL_HOVER),
        pressed = Color(KtPalette.Light.FILL_PRESSED),
    ),
    border = Color(KtPalette.Light.BORDER),
    scrim = Color(KtPalette.Light.SCRIM).copy(alpha = KtPalette.Light.SCRIM_ALPHA),
    accent = KtAccentColors(
        primary = Color(KtPalette.AccentLight.PRIMARY),
        hover = Color(KtPalette.AccentLight.HOVER),
        pressed = Color(KtPalette.AccentLight.PRESSED),
        subtle = Color(KtPalette.AccentLight.SUBTLE),
        subtleHover = Color(KtPalette.AccentLight.SUBTLE_HOVER),
        text = Color(KtPalette.AccentLight.TEXT),
        border = Color(KtPalette.AccentLight.BORDER),
        focus = Color(KtPalette.AccentLight.FOCUS),
        onAccent = Color(KtPalette.AccentLight.ON_ACCENT),
    ),
    semantic = KtSemanticColors(
        success = family(KtPalette.SemanticLight.SUCCESS),
        warning = family(KtPalette.SemanticLight.WARNING),
        error = family(KtPalette.SemanticLight.ERROR),
        info = family(KtPalette.SemanticLight.INFO),
    ),
)

fun darkKtColors(): KtColors = KtColors(
    isDark = true,
    canvas = Color(KtPalette.Dark.CANVAS),
    surface = Color(KtPalette.Dark.SURFACE),
    surfaceElevated = Color(KtPalette.Dark.SURFACE_ELEVATED),
    surfaceSunken = Color(KtPalette.Dark.SURFACE_SUNKEN),
    text = KtTextColors(
        primary = Color(KtPalette.Dark.TEXT_PRIMARY),
        secondary = Color(KtPalette.Dark.TEXT_SECONDARY),
        tertiary = Color(KtPalette.Dark.TEXT_TERTIARY),
        disabled = Color(KtPalette.Dark.TEXT_DISABLED),
        inverse = Color(KtPalette.Dark.TEXT_INVERSE),
    ),
    separator = KtSeparatorColors(
        subtle = Color(KtPalette.Dark.SEPARATOR_SUBTLE),
        strong = Color(KtPalette.Dark.SEPARATOR_STRONG),
    ),
    fill = KtFillColors(
        control = Color(KtPalette.Dark.FILL_CONTROL),
        hover = Color(KtPalette.Dark.FILL_HOVER),
        pressed = Color(KtPalette.Dark.FILL_PRESSED),
    ),
    border = Color(KtPalette.Dark.BORDER),
    scrim = Color(KtPalette.Dark.SCRIM).copy(alpha = KtPalette.Dark.SCRIM_ALPHA),
    accent = KtAccentColors(
        primary = Color(KtPalette.AccentDark.PRIMARY),
        hover = Color(KtPalette.AccentDark.HOVER),
        pressed = Color(KtPalette.AccentDark.PRESSED),
        subtle = Color(KtPalette.AccentDark.SUBTLE),
        subtleHover = Color(KtPalette.AccentDark.SUBTLE_HOVER),
        text = Color(KtPalette.AccentDark.TEXT),
        border = Color(KtPalette.AccentDark.BORDER),
        focus = Color(KtPalette.AccentDark.FOCUS),
        onAccent = Color(KtPalette.AccentDark.ON_ACCENT),
    ),
    semantic = KtSemanticColors(
        success = family(KtPalette.SemanticDark.SUCCESS),
        warning = family(KtPalette.SemanticDark.WARNING),
        error = family(KtPalette.SemanticDark.ERROR),
        info = family(KtPalette.SemanticDark.INFO),
    ),
)

val LocalKtColors = staticCompositionLocalOf { lightKtColors() }
