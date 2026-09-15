package click.erikaalk.kinetrail.hc.designsystem

/**
 * WCAG 相对亮度、对比度与 alpha 合成。
 *
 * 半透明材质上的文字要按**最终合成背景**验收（全局 2.1），所以除了对比度还得有
 * [blend]：材质层压在什么上面，合成出来的那个颜色才是真正的背景。
 *
 * 输入是 0xAARRGGBB 或 0xRRGGBB 的 Int，alpha 被忽略。
 */
object ColorContrast {

    fun relativeLuminance(color: Int): Double {
        val r = channel((color shr 16) and 0xFF)
        val g = channel((color shr 8) and 0xFF)
        val b = channel(color and 0xFF)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    fun contrastRatio(a: Int, b: Int): Double {
        val la = relativeLuminance(a)
        val lb = relativeLuminance(b)
        val hi = maxOf(la, lb)
        val lo = minOf(la, lb)
        return (hi + 0.05) / (lo + 0.05)
    }

    /** 把 [top] 以 [alpha] 压在 [bottom] 上，得到合成后的实色。 */
    fun blend(top: Int, bottom: Int, alpha: Double): Int {
        val t = alpha.coerceIn(0.0, 1.0)
        fun mix(shift: Int): Int {
            val a = (top shr shift) and 0xFF
            val b = (bottom shr shift) and 0xFF
            return (b + (a - b) * t).toInt().coerceIn(0, 255)
        }
        return (0xFF shl 24) or (mix(16) shl 16) or (mix(8) shl 8) or mix(0)
    }

    private fun channel(v: Int): Double {
        val s = v / 255.0
        return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
    }
}
