package click.erikaalk.kinetrail.hc.designsystem

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * 字号语义角色。**先选角色，再由平台映射字号**，不要用字号大小替代信息层级设计。
 *
 * 数值是全局规范 Mobile 那一列的确定值，不是区间。本 App 没有需要更密档位的场景，
 * 所以**一个项目级覆盖都没有**——九个角色照抄全局表，单测逐项钉住。
 *
 * **不指定字族**：全局 9.2 要求继承用户当前的系统界面字体，用户选了衬线就得是衬线，
 * 不许为了视觉风格强按成 Roboto。只有 [mono] 例外，走系统等宽。
 *
 * 全部用 sp，跟随系统字号缩放；布局不许依赖固定行高容纳固定字数。
 */
object KtType {

    /**
     * 页面或窗口一级标题。
     *
     * 24sp 是 WCAG「大号文本」的下限，所以这一档（和 [metric]）可以按 3:1 验收；
     * [title] 及以下一律 4.5:1。
     */
    val pageTitle = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold)

    /** 重要模块标题、核心对象名称。详情页的对象名走它。 */
    val title = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold)

    /**
     * Section 或设置组标题。
     *
     * **必须大于 [body] 且用 Semibold + `text.primary`**，禁止拿 [secondary]、[caption]
     * 或弱灰文字冒充组标题——那样组标题比它统辖的行标题还弱，层级是反的。
     */
    val sectionTitle = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)

    /** 主体 UI 文本。设置行标题、列表行标题都是它。 */
    val body = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Normal)

    /** 补充信息、次要值、行内说明。 */
    val secondary = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal)

    /** 时间、单位、极弱辅助信息。**不作小标题用。** */
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Normal)

    /** 关键数字。不必再用彩色 Card 强调。 */
    val metric = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold)

    /** 控件文字。 */
    val button = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)

    /** 路径、代码、日志。 */
    val mono = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
    )

    /**
     * 解析后的字号表。全局 10.1 门槛第 6 条要求开发构建能输出它，
     * 也用来钉住"同平台同 Token 逐项一致"——单测直接比这张表。
     *
     * 打出来的是 sp 数值本身，不乘 density、不乘 fontScale：系统字号缩放
     * 只能由框架应用一次。
     */
    fun resolvedTable(): String = buildString {
        appendLine("designSystemRevision = $KT_DESIGN_SYSTEM_REVISION")
        appendLine("Token            size/lineHeight  weight")
        listOf(
            "pageTitle" to pageTitle, "title" to title, "sectionTitle" to sectionTitle,
            "body" to body, "secondary" to secondary, "caption" to caption,
            "metric" to metric, "button" to button, "mono" to mono,
        ).forEach { (name, style) ->
            appendLine(
                name.padEnd(16) +
                    "${style.fontSize.value.toInt()}/${style.lineHeight.value.toInt()}".padEnd(17) +
                    (style.fontWeight?.weight?.toString() ?: "400"),
            )
        }
    }
}
