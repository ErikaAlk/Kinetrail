package click.erikaalk.kinetrail.hc.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import click.erikaalk.coloroskit.tokens.CoTokens
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 自定义主题色的对比度（设计库只校验了自带的蓝和橙）。
 * primary 上是白字（按钮、选中的日期），primaryText 是灰底和卡片上的可点文字、今天的日期。
 */
class ThemeColorContrastTest {
    private fun contrast(a: Color, b: Color): Float {
        val (hi, lo) = listOf(a.luminance(), b.luminance()).sortedDescending()
        return (hi + 0.05f) / (lo + 0.05f)
    }

    private val c = CoTokens.Color

    @Test
    fun whiteTextOnPrimary() {
        for (dark in listOf(false, true)) {
            val ratio = contrast(c.onPrimary.of(dark), KinetrailThemeColor.primary.of(dark))
            assertTrue("dark=$dark 白字在 primary 上只有 $ratio", ratio >= 3f)
        }
    }

    @Test
    fun primaryTextOnPageAndCard() {
        for (dark in listOf(false, true)) {
            val page = c.bgGrouped.of(dark)
            for (bg in listOf(page, c.card.of(dark).compositeOver(page))) {
                val ratio = contrast(KinetrailThemeColor.primaryText.of(dark), bg)
                assertTrue("dark=$dark primaryText 在 $bg 上只有 $ratio", ratio >= 4.5f)
            }
        }
    }
}
