package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/**
 * 圆角。按 Surface 尺寸映射，不在各组件里随手写值。嵌套时外大内小。
 */
object KtRadius {

    /** 小控件、输入框、图标底块。 */
    val small = 6.dp

    /** 普通容器、按钮、面板。 */
    val medium = 10.dp

    /** Sheet、Dialog、设置组 Card 这类大型面。 */
    val large = 14.dp

    val smallShape: Shape = RoundedCornerShape(small)
    val mediumShape: Shape = RoundedCornerShape(medium)
    val largeShape: Shape = RoundedCornerShape(large)

    /** Sheet 只有上面两个角是圆的。 */
    val sheetShape: Shape = RoundedCornerShape(topStart = large, topEnd = large)

    /**
     * 胶囊。**只给真正有胶囊语义的元素**——悬浮导航条。
     * 普通按钮不默认做成药丸。
     */
    val full: Shape = CircleShape
}
