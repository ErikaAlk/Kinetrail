package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.coloroskit.tokens.CoTokens

/**
 * 应用自己的图标（设计库不带图标资产，DESIGN §13）。24 格画布、圆头；路径取自 Lucide（ISC 许可），体重秤是按同一规格自绘的。
 * 底栏选中换实心版：[solid] 填充，[cut] 从实心里挖掉（离屏合成），[keep] 在实心版里仍按线画。
 */
enum class Glyph(
    val outline: List<String>,
    val solid: List<String> = emptyList(),
    val cut: List<String> = emptyList(),
    val keep: List<String> = emptyList(),
) {
    Calendar(
        outline = listOf(
            "M8 2v4", "M16 2v4", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M3 10h18",
            "M8 14h.01", "M12 14h.01", "M16 14h.01", "M8 18h.01", "M12 18h.01", "M16 18h.01",
        ),
        solid = listOf("M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"),
        cut = listOf("M5.5 10h13", "M8 14h.01", "M12 14h.01", "M16 14h.01", "M8 18h.01", "M12 18h.01", "M16 18h.01"),
        keep = listOf("M8 2v4", "M16 2v4"),
    ),

    /** 实心版是一枚圆牌，里面挖出缩到 0.6 倍的同一对箭头。 */
    Sync(
        outline = listOf(
            "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5",
            "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5",
        ),
        solid = listOf("M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z"),
        cut = listOf(
            "M6.6 12a5.4 5.4 0 0 1 5.4-5.4 5.85 5.85 0 0 1 4.044 1.644L17.4 8.4", "M17.4 5.4v3h-3",
            "M17.4 12a5.4 5.4 0 0 1-5.4 5.4 5.85 5.85 0 0 1-4.044-1.644L6.6 15.6", "M9.6 15.6H6.6v3",
        ),
    ),
    Settings(
        outline = listOf(
            "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
            "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
        ),
        solid = listOf(
            "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
        ),
        cut = listOf("M9.2 12a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0Z"),
    ),
    Refresh(outline = listOf("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5")),
    ChevronLeft(outline = listOf("m15 18-6-6 6-6")),
    ChevronRight(outline = listOf("m9 18 6-6-6-6")),
    Image(
        outline = listOf(
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
            "M7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
        ),
    ),

    /** 月历里“当天有训练”的标记：活动波形。 */
    Activity(outline = listOf("M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2")),

    /** 月历里“当天称过体重”的标记：圆角秤身 + 半圆表盘 + 指针。 */
    Scale(outline = listOf("M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z", "M7.5 11.5a4.5 4.5 0 0 1 9 0", "M12 11.5l1.8-2.6")),
}

/** [stroke] 是屏幕上的线宽（DESIGN §13：约 1.33～1.4dp），图标缩小时按比例换算回 24 格单位，线不跟着变细。 */
@Composable
fun GlyphIcon(
    glyph: Glyph,
    tint: Color,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    size: Dp = CoTokens.TopBar.iconSize,
    stroke: Dp = 1.4.dp,
) {
    val solid = selected && glyph.solid.isNotEmpty()
    Canvas(
        modifier.size(size)
            .then(if (solid) Modifier.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen } else Modifier),
    ) {
        val k = this.size.minDimension / 24f
        if (k <= 0f) return@Canvas
        val line = Stroke(stroke.toPx() / k, cap = StrokeCap.Round, join = StrokeJoin.Round)
        scale(k, k, pivot = Offset.Zero) {
            if (!solid) {
                glyph.outline.forEach { drawPath(pathOf(it), tint, style = line) }
                return@scale
            }
            // 实心版：填充 + 同一线宽描一圈，外轮廓和线性版一样大
            glyph.solid.forEach { drawPath(pathOf(it), tint); drawPath(pathOf(it), tint, style = line) }
            glyph.cut.forEach { drawPath(pathOf(it), Color.Black, style = line, blendMode = BlendMode.Clear) }
            glyph.keep.forEach { drawPath(pathOf(it), tint, style = line) }
        }
    }
}

private val pathCache = HashMap<String, Path>()

private fun pathOf(data: String): Path = pathCache.getOrPut(data) { PathParser().parsePathString(data).toPath() }
