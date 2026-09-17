package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import kotlin.test.Test
import kotlin.test.assertTrue

private val palettes = listOf("Light" to lightKtColors(), "Dark" to darkKtColors())

private fun assertAtLeast(min: Double, fg: Int, bg: Int, what: String) {
    val actual = ColorContrast.contrastRatio(fg, bg)
    assertTrue(actual >= min, "$what 只有 %.2f:1，要求至少 %.1f:1".format(actual, min))
}

private fun assertAtLeast(min: Double, fg: Color, bg: Color, what: String) = assertAtLeast(min, fg.toArgb(), bg.toArgb(), what)

/** DESIGN.md 2.1：每个文字 Token 在全部文字承载面上逐一达标，不只对 canvas。 */
class KtColorContrastTest {

    private fun KtColors.textBearingSurfaces() = listOf(
        "canvas" to canvas, "surface" to surface, "surfaceElevated" to surfaceElevated, "surfaceSunken" to surfaceSunken,
        "fill.control" to fill.control, "accent.subtle" to accent.subtle,
        "success.subtle" to semantic.success.subtle, "warning.subtle" to semantic.warning.subtle,
        "error.subtle" to semantic.error.subtle, "info.subtle" to semantic.info.subtle,
    )

    @Test
    fun `文字与强调文字在全部承载面上达到 AA`() = palettes.forEach { (mode, c) ->
        c.textBearingSurfaces().forEach { (name, bg) ->
            assertAtLeast(4.5, c.text.primary, bg, "$mode text.primary 对 $name")
            assertAtLeast(4.5, c.text.secondary, bg, "$mode text.secondary 对 $name")
            assertAtLeast(4.5, c.text.tertiary, bg, "$mode text.tertiary 对 $name")
            assertAtLeast(4.5, c.accent.text, bg, "$mode accent.text 对 $name")
        }
    }

    /** 普通卡片不画描边，只靠底色和画布分层（全局 2.5：低于 1.1:1 才要描边）。深色要拉开更多，暗处的明度差不显眼。 */
    @Test
    fun `卡片靠底色就能和画布分开`() = palettes.forEach { (mode, c) ->
        assertAtLeast(if (c.isDark) 1.2 else 1.11, c.surface, c.canvas, "$mode surface 对 canvas")
    }

    @Test
    fun `控件边界、强调边界与焦点达到 3 比 1`() = palettes.forEach { (mode, c) ->
        listOf(c.canvas, c.surface, c.surfaceElevated, c.surfaceSunken, c.fill.control).forEach {
            assertAtLeast(3.0, c.border, it, "$mode border")
        }
        listOf(c.canvas, c.surface, c.surfaceElevated).forEach {
            assertAtLeast(3.0, c.accent.border, it, "$mode accent.border")
            assertAtLeast(3.0, c.accent.focus, it, "$mode accent.focus")
        }
    }

    @Test
    fun `主按钮文字三态可读，语义色文字对自己的 subtle 可读`() = palettes.forEach { (mode, c) ->
        listOf(c.accent.primary, c.accent.hover, c.accent.pressed).forEach {
            assertAtLeast(4.5, c.accent.onAccent, it, "$mode onAccent")
        }
        listOf(c.semantic.success, c.semantic.warning, c.semantic.error, c.semantic.info).forEach { f ->
            listOf(c.canvas, c.surface, f.subtle).forEach { assertAtLeast(4.5, f.text, it, "$mode semantic.text") }
            assertAtLeast(4.5, f.onSolid, f.solid, "$mode onSolid")
        }
        assertTrue(c.accent.text != c.accent.primary, "$mode accent.text 不能等于 accent.primary")
    }
}

/** 材质上的文字与图标按最终合成背景验收：材质压在页面里可能出现的每种面上（含主按钮）。 */
class KtMaterialContrastTest {

    private fun KtColors.backdrops() = listOf(
        canvas, surface, surfaceSunken, fill.control, accent.subtle, accent.primary,
        semantic.error.subtle, semantic.warning.subtle, semantic.success.subtle,
    )

    @Test
    fun `顶栏材质上的标题和图标在各种背景上可读`() = palettes.forEach { (mode, c) ->
        listOf(true, false).forEach { blurred ->
            val alpha = KtMaterial.headerAlpha(c.isDark, blurred).toDouble()
            c.backdrops().forEach { backdrop ->
                val bg = ColorContrast.blend(c.surfaceElevated.toArgb(), backdrop.toArgb(), alpha)
                assertAtLeast(4.5, c.text.primary.toArgb(), bg, "$mode 顶栏（blurred=$blurred）标题")
                // 顶栏上除标题外只有返回图标，按非文本对比度 3:1 验收（深色下主按钮滚到条后面时最低 3.44:1）
                assertAtLeast(3.0, c.text.secondary.toArgb(), bg, "$mode 顶栏（blurred=$blurred）返回图标")
            }
        }
    }

    /**
     * 底栏的标签是 `caption`，按 4.5:1 验收，**不能按图标那档 3:1 放过**。
     * 这一条就是 [KtMaterial.NAV_LIGHT_ALPHA] 收到 0.86 / 0.80 的原因。
     */
    @Test
    fun `底栏材质上的选中与未选中标签在各种背景上可读`() = palettes.forEach { (mode, c) ->
        listOf(true, false).forEach { blurred ->
            val alpha = KtMaterial.navAlpha(c.isDark, blurred).toDouble()
            c.backdrops().forEach { backdrop ->
                val bg = ColorContrast.blend(c.surfaceElevated.toArgb(), backdrop.toArgb(), alpha)
                assertAtLeast(4.5, c.accent.text.toArgb(), bg, "$mode 底栏（blurred=$blurred）选中标签")
                assertAtLeast(4.5, c.text.secondary.toArgb(), bg, "$mode 底栏（blurred=$blurred）未选中标签")
            }
        }
    }
}
