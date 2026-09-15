package click.erikaalk.kinetrail.hc.designsystem

/**
 * 全项目**唯一**允许写十六进制的地方（另一处是 `res/values/colors.xml` 与 `res/values-night/colors.xml`，那是 XML 读不到 Kotlin 常量时的镜像，
 * 改这里必须同时改那里）。
 *
 * 生成口径：`~\Workspace\lab\设计系统重做\palette.py gen Kinetrail`，品牌方向「孔雀蓝」
 * （OKLCH hue 218 / chroma 0.125 / cool）。候选值只对 canvas 校验过，下列几项按 DESIGN.md 2.1
 * 的文字承载面集合收敛（[KtColorContrastTest] 钉着）：
 *
 * - 浅色 `text.tertiary` #707678 → #5C6264：原值压在 fill.control 上不到 4.5。
 * - `border` 浅 #C2C9CB → #798082、深 #2F3436 → #6C7375：候选值对控件承载面只有 1.3–1.5:1。
 * - 浅色 accent 三态整体压深到白字达标（#00A3C2 → #007C94）：原值只能配墨字，
 *   主按钮文字会成为整页最黑的东西（1.5 视觉重量预算）。深色保持墨字。
 * - 深色 `accent.text` 与 `accent.primary` 原本同值，单独拉开一档。
 *
 * 启动图标沿用 `assets/icon.svg` 的 #00778F，它与浅色 accent.text 同一色相。
 */
internal object KtPalette {

    object Light {
        const val CANVAS = 0xFFF3FBFD.toInt()
        const val SURFACE = 0xFFFBFEFF.toInt()
        const val SURFACE_ELEVATED = 0xFFFFFFFF.toInt()
        const val SURFACE_SUNKEN = 0xFFEBF2F4.toInt()
        const val TEXT_PRIMARY = 0xFF14191B.toInt()
        const val TEXT_SECONDARY = 0xFF4E5455.toInt()
        const val TEXT_TERTIARY = 0xFF5C6264.toInt()
        const val TEXT_DISABLED = 0xFF8D9395.toInt()
        const val TEXT_INVERSE = 0xFFFFFFFF.toInt()
        const val SEPARATOR_SUBTLE = 0xFFCFD6D8.toInt()
        const val SEPARATOR_STRONG = 0xFFB3B9BB.toInt()
        const val BORDER = 0xFF798082.toInt()
        const val FILL_CONTROL = 0xFFE2E9EB.toInt()
        const val FILL_HOVER = 0xFFD8DFE1.toInt()
        const val FILL_PRESSED = 0xFFCDD4D6.toInt()
        const val SCRIM = 0xFF14191B.toInt()
        const val SCRIM_ALPHA = 0.34f
    }

    object Dark {
        const val CANVAS = 0xFF090E10.toInt()
        const val SURFACE = 0xFF121718.toInt()
        const val SURFACE_ELEVATED = 0xFF1C2123.toInt()
        const val SURFACE_SUNKEN = 0xFF050809.toInt()
        const val TEXT_PRIMARY = 0xFFE6EDEF.toInt()
        const val TEXT_SECONDARY = 0xFFA6ACAE.toInt()
        const val TEXT_TERTIARY = 0xFF8E9496.toInt()
        const val TEXT_DISABLED = 0xFF606668.toInt()
        const val TEXT_INVERSE = 0xFF181A20.toInt()
        const val SEPARATOR_SUBTLE = 0xFF252B2C.toInt()
        const val SEPARATOR_STRONG = 0xFF393F40.toInt()
        const val BORDER = 0xFF6C7375.toInt()
        const val FILL_CONTROL = 0xFF191E20.toInt()
        const val FILL_HOVER = 0xFF262B2D.toInt()
        const val FILL_PRESSED = 0xFF323839.toInt()
        const val SCRIM = 0xFF000000.toInt()
        const val SCRIM_ALPHA = 0.60f
    }

    object AccentLight {
        const val PRIMARY = 0xFF007C94.toInt()
        const val HOVER = 0xFF00738A.toInt()
        const val PRESSED = 0xFF006A80.toInt()
        const val SUBTLE = 0xFFDCF3FA.toInt()
        const val SUBTLE_HOVER = 0xFFD2E9F0.toInt()
        const val TEXT = 0xFF00708A.toInt()
        const val BORDER = 0xFF3A90A6.toInt()
        const val FOCUS = 0xFF0093B0.toInt()
        const val ON_ACCENT = 0xFFFFFFFF.toInt()
    }

    object AccentDark {
        const val PRIMARY = 0xFF34C4E6.toInt()
        const val HOVER = 0xFF42CDF0.toInt()
        const val PRESSED = 0xFF20B8DA.toInt()
        const val SUBTLE = 0xFF032B35.toInt()
        const val SUBTLE_HOVER = 0xFF0F3640.toInt()
        const val TEXT = 0xFF4FCBEA.toInt()
        const val BORDER = 0xFF1E8BA5.toInt()
        const val FOCUS = 0xFF34C4E6.toInt()
        const val ON_ACCENT = 0xFF181A20.toInt()
    }

    // 顺序：solid / subtle / text / border / onSolid。四个独立色族，不从品牌色推导。
    object SemanticLight {
        val SUCCESS = intArrayOf(0xFF519D55.toInt(), 0xFFE1F5E0.toInt(), 0xFF2E7C35.toInt(), 0xFF5F9160.toInt(), 0xFF181A20.toInt())
        val WARNING = intArrayOf(0xFFEAAA40.toInt(), 0xFFFFEFDB.toInt(), 0xFF956400.toInt(), 0xFFA87E3C.toInt(), 0xFF181A20.toInt())
        val ERROR = intArrayOf(0xFFE0514E.toInt(), 0xFFFFE9E7.toInt(), 0xFFC63738.toInt(), 0xFFCB6862.toInt(), 0xFF181A20.toInt())
        val INFO = intArrayOf(0xFF3C93D5.toInt(), 0xFFE1F1FF.toInt(), 0xFF0D71B1.toInt(), 0xFF538AB7.toInt(), 0xFF181A20.toInt())
    }

    object SemanticDark {
        val SUCCESS = intArrayOf(0xFF78BF7B.toInt(), 0xFF1A2C1A.toInt(), 0xFF78BF7B.toInt(), 0xFF467347.toInt(), 0xFF181A20.toInt())
        val WARNING = intArrayOf(0xFFF4B85B.toInt(), 0xFF342611.toInt(), 0xFFF4B85B.toInt(), 0xFF876224.toInt(), 0xFF181A20.toInt())
        val ERROR = intArrayOf(0xFFF97770.toInt(), 0xFF3A1D1B.toInt(), 0xFFF97770.toInt(), 0xFFA44F4A.toInt(), 0xFF181A20.toInt())
        val INFO = intArrayOf(0xFF72B8F2.toInt(), 0xFF142838.toInt(), 0xFF72B8F2.toInt(), 0xFF406D92.toInt(), 0xFF181A20.toInt())
    }
}
