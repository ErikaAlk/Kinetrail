package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.ui.unit.dp

/**
 * 间距。基础单位 4。
 *
 * > 间距不是为了让界面透气，而是为了表达元素之间的关系。
 *
 * [Gap] 和 [Padding] 是全局规范 Mobile 那一列的确定值。**组件只用语义值**，
 * 要调密度就重映射这里，不许在页面里临时发明一个相邻数值。
 */
object KtSpacing {

    val space1 = 4.dp
    val space2 = 8.dp
    val space3 = 12.dp
    val space4 = 16.dp
    val space5 = 20.dp
    val space6 = 24.dp
    val space8 = 32.dp
    val space10 = 40.dp

    /** 越相关的元素越近，层级越远才逐步拉开。 */
    object Gap {
        /** 图标与标签、同一行紧密元素。**比 [related] 大**，别把这两个记反了。 */
        val inline = space2

        /** 标题与说明、值与单位。整套里最紧的一档。 */
        val related = space1

        /** 同组相邻控件。 */
        val control = space2

        /** 同一 Section 内的小组。 */
        val group = space4

        /** 两个 Section。 */
        val section = space6
    }

    object Padding {
        val controlX = space4
        val controlY = 10.dp

        /** Surface 内边距。 */
        val container = 14.dp

        val pageX = space5
        val pageY = space4
    }

    /** 页面标题到第一个组标题。 */
    val pageTitleToSection = space6

    /** 组标题到它下面那张 Card。 */
    val sectionTitleToCard = space2

    /** Card 到组级说明。 */
    val cardToFooter = space2

    /** Card 自己的水平内边距。垂直内边距是 0，高度由行的最小高度决定。 */
    val cardPaddingX = space4
}
