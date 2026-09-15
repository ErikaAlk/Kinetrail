package click.erikaalk.kinetrail.hc.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.designsystem.FocusRingPlacement
import click.erikaalk.kinetrail.hc.designsystem.KtBackdrop
import click.erikaalk.kinetrail.hc.designsystem.KtElevation
import click.erikaalk.kinetrail.hc.designsystem.LocalReducedMotion
import click.erikaalk.kinetrail.hc.designsystem.KtMotion
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.headerMaterial
import click.erikaalk.kinetrail.hc.designsystem.ktColorTween
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing
import click.erikaalk.kinetrail.hc.designsystem.ktShadow

/**
 * 顶部页面导航的尺寸与收起口径。
 *
 * 参考页面 2026-09-06 的顶栏纠正：**移除常驻应用名、Logo 和副标题**，
 * 初始状态大标题与画布连续；大标题随内容滚出后渐入紧凑标题和顶部材质，下缘柔化；
 * 滚回顶部恢复连续背景，换页重置。
 */
object KtHeader {

    /**
     * 紧凑标题条的内容区高度，不含状态栏。
     *
     * 参考页面用的是 52 个 CSS 像素。**Web 参数不直接当 dp 用**，这里取 Android 的
     * 常规工具栏高度 56：它同时是两个 48dp 触控目标加上下各 4 的最小容身高度。
     * 系统字号放大时允许继续长高，见 [KtPageHeader]。
     */
    val minHeight = 56.dp

    /**
     * 条里既没有返回键也没有操作图标时的高度。
     *
     * [minHeight] 的 56 是按"两个 48dp 触控目标加上下各 4"算的。首页和设置页这两条里
     * 一个按钮都没有，那 8dp 是在给不存在的东西留位置——大标题跟着往下掉一截，
     * 状态栏到标题之间空出一大块死白。这一档只要容得下紧凑标题（20/26）就够。
     *
     * 系统字号放大时照样往上长，见 [KtPageHeader]：给的是下限，不是定值。
     */
    val titleOnlyMinHeight = 48.dp

    /**
     * 材质渐入的距离，从大标题**顶边**开始钻到条后面那一刻算起。
     *
     * 触发点仍看**顶边**：拿底边试过，大标题在系统字号 2.0 下先和返回键叠在一起、
     * 材质却还没出来——那一档的大标题比整条还高，"底边越过条"的时候标题头部早压在返回键上了。
     *
     * **2026-09-07 从 16dp 拉到 28dp。** 16dp 只有四五帧，刚一往上滑条就"啪"地泛白
     * （材质是 `surfaceElevated`，压在画布上比画布亮六个亮度级，一次到位就是一道白带）。
     * 28dp 差不多是字号 1.0 下大标题整个走进条里所需的距离：材质到位的时候，
     * 底下也刚好真有东西需要遮。
     */
    val materialFade = 28.dp

    /**
     * 紧凑标题**跟着大标题走的距离**。
     *
     * 2026-09-07 重做：上一版是两个标题各走各的——大标题在条底下继续往上滚，
     * 条上方另外淡入一个同名标题，中间还有一段谁都看不见的空窗。看着就是两个东西在顶替。
     *
     * 现在只有一个标题在动：紧凑标题的位置**由大标题的中心算出来**，
     * 从槽位下方 40dp 处一路跟着大标题升到槽位再停住。交接发生在两者
     * 位置、左边界和字号都对齐的那一刻（见 [KtPageHeader] 里的缩放和横移），
     * 所以看不出是换了一个 Text 在画。
     *
     * 40 是这样定的：交接开始时大标题中心在条底下方 12dp，还露着大半个字，
     * 紧凑标题正好压在它身上；再滚 40dp 走完。短了交接太急，长了紧凑标题
     * 会在条外面飘太久。
     */
    val titleFollow = 40.dp

    /**
     * 材质下缘柔化的高度。不用硬分隔线，也不做成一块实色矩形。
     *
     * 走过 10 → 6 → 20 → **14**：6dp 是材质还只有 0.48 那么薄的时候定的，
     * 那会儿渐隐带一长就会把一行正文冲成半截；材质加厚到 0.72 之后 6dp 反而短得像一条硬边。
     * 20dp 化得又太开，正在钻进去的那行字有一半还读得出来。
     * 挪到条外面之后（见 [edgeOverhang]）这一档就不再和"遮不遮得住"打架了，
     * 于是从 14 拉到 **24**：它整段都花在条以外，拉长只让边界更化得开。
     * 配合 [softeningStops] 的缓入缓出曲线，看不出斜坡是从哪儿起的。
     */
    val edgeSoftening = 24.dp

    /**
     * 材质往条**下沿之外**多探出的高度，和 [edgeSoftening] 等长。
     *
     * 柔化带原本占的是条自己的最后 14dp，于是紧凑标题下方那一截是半透的——
     * 从底下经过的字还认得出来。整段往下挪一个身位之后：条的范围内是满遮挡，
     * 渐隐发生在条的下沿以外，标题底下不再有看得清的余字。
     *
     * 这一层是 `matchParentSize` 之上再套一个只改**放置尺寸**的 layout：
     * 上报给父容器的仍是条的高度，多出来的部分画在外面。
     * 条的实测高度不受影响，页面的顶部余量也不用跟着改。
     */
    val edgeOverhang = edgeSoftening

    /**
     * 柔化曲线上的中间档。
     *
     * 线性斜坡在**起点**有个折角：上面是恒定的满遮挡，下面突然开始匀速变淡，
     * 那个折角看着就是一条边——这也是"柔化带做得再长也还是硬"的原因。
     * 这三档取 smoothstep（`1 - (3t² - 2t³)`）在 1/4、1/2、3/4 处的值，
     * 把两端的折角都磨掉。
     */
    val softeningStops = floatArrayOf(0.844f, 0.5f, 0.156f)

    /**
     * 材质的渐入进度：大标题**顶边**钻进条底下之后开始。
     *
     * 坐标都是窗口里的未裁剪像素——`boundsInWindow()` 会被滚动容器裁到边缘，
     * 标题滚出去之后永远停在边界上，算不出滚了多远。
     */
    fun materialProgress(titleTopPx: Float, headerBottomPx: Float, fadePx: Float): Float {
        val p = ((headerBottomPx - titleTopPx) / fadePx).coerceIn(0f, 1f)
        // 缓入（p²）而不是线性：白得最扎眼的是"从没有到有"那一小段，
        // 线性会把它全压在最开始的一两帧里。平方之后开头几乎看不出来，
        // 等到真有内容钻进条底下时才厚起来。
        return p * p
    }

    /**
     * 紧凑标题的落位进度：**从大标题的中心算**，不是从它的底边。
     *
     * 0 = 大标题中心还在槽位下方 [titleFollow] 以外，紧凑标题不画；
     * 1 = 已经落到槽位，停住。中间任何一个值都同时是它的透明度、纵向偏移、
     * 横移和缩放的插值系数——四样东西一个来源，才不会各走各的。
     */
    fun followProgress(titleCenterPx: Float, slotCenterPx: Float, followPx: Float): Float =
        (1f - (titleCenterPx - slotCenterPx) / followPx).coerceIn(0f, 1f)

    /**
     * 交接进度：大标题淡出、顶栏那一份淡入，两条曲线加起来恒为 1，中间不会一起变淡。
     *
     * 走 [followProgress] 的前 45%。横向和缩放走 `1 - q²`，交接这一段里它俩几乎还没动，
     * 两份严丝合缝地重合，所以可以放心拉长——25% 时交接太急，收起像"啪"地换了一下。
     *
     * **减少动态时不交接，直接换。** 那一档没有位移也没有缩放，两份标题一左一右
     * 差着一大截，再叠加淡入淡出就是同屏两个同名标题（用户实拍指出过）。
     * 参考页面的口径是"减少动态时即时切换"：等大标题整个走到条后面（[followProgress] 满）
     * 再一步换过去，中间任何时刻都只有一个标题。
     */
    fun handoverProgress(follow: Float, reducedMotion: Boolean): Float = when {
        reducedMotion -> if (follow >= 1f) 1f else 0f
        else -> (follow / HANDOVER_SPAN).coerceIn(0f, 1f)
    }

    private const val HANDOVER_SPAN = 0.45f
}

/**
 * 顶部页面导航。**一层，不是两层**：没有常驻应用名，也没有装饰 Logo，
 * 它显示的就是当前页面的标题，只是在大标题滚走之后才出现。
 *
 * 两层分别渐入，**不是同一个进度**：[materialAlpha] 在大标题顶边钻进条底下时就开始，
 * 保证任何时候有内容跑到条后面都有一层东西把它们分开；[titleFollow] 是标题自己的落位进度，
 * 由大标题的中心算出来。
 *
 * **看上去只有一个标题在动。** 紧凑标题从槽位下方跟着大标题往上走，同时缩到 20sp、
 * 横移到返回键右边；交接那一刻两者的中心、左边界和字号都对齐，所以看不出换了一个 Text 在画。
 * 上一版是两个标题各走各的，中间还有一段谁都看不见的空窗——那才是"顶上又出现一个标题"。
 *
 * 两者都返回 0 时这里只有返回键和操作图标，背后什么都不画，和页面背景连续。
 * 中间态全部是绘制阶段的透明度、位移和缩放，**布局尺寸一处没动**，所以收起过程不会跳动。
 *
 * 它们是**函数不是值**：透明度在绘制阶段才读，滚动时不触发重组，整棵页面树不用每帧重算。
 * 材质层的存废走 [derivedStateOf]，只在真正跨过阈值时才重组一次。
 *
 * 返回键和操作图标在任何进度下都在，命中区 48dp；顶部让开状态栏安全区。
 */
@Composable
fun KtPageHeader(
    title: String,
    materialAlpha: () -> Float,
    titleFollow: () -> Float,
    backdrop: KtBackdrop,
    topInset: Dp,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
) {
    val colors = ktColors
    val materialVisible by remember(materialAlpha) { derivedStateOf { materialAlpha() > 0.002f } }
    val reduced = LocalReducedMotion.current
    val density = LocalDensity.current

    // 交接开始时，紧凑标题要和大标题严丝合缝地重合，所以三样都得对上：
    // 纵向差（跟着中心走）、横向差（大标题在页边距上，紧凑标题在返回键右边）、
    // 字号差（24 对 20）。差一样就会在交接那一帧看出破绽。
    val followPx = with(density) { KtHeader.titleFollow.toPx() }
    val startScale = KtType.pageTitle.fontSize.value / KtType.title.fontSize.value
    val leadingWidth = if (onBack != null) {
        KtIconButton.size
    } else {
        KtSpacing.Padding.pageX - KtSpacing.Gap.control
    }
    // 大标题的左边界是页边距；紧凑标题的是 Row 内边距 + 前导槽 + 自己的内边距
    val startDxPx = with(density) {
        (
            KtSpacing.Padding.pageX -
                (KtSpacing.Gap.control + leadingWidth + KtSpacing.Gap.related)
            ).toPx()
    }
    Box(modifier.fillMaxWidth()) {
        if (materialVisible) {
            // matchParentSize 不参与父容器定尺，所以这一层的出现与消失是布局中性的
            val overhangPx = with(LocalDensity.current) { KtHeader.edgeOverhang.roundToPx() }
            Box(
                Modifier
                    .matchParentSize()
                    .layout { measurable, constraints ->
                        // 量的时候多给一截，报给父容器的还是条的高度——布局中性
                        val taller = constraints.maxHeight + overhangPx
                        val placeable = measurable.measure(
                            constraints.copy(minHeight = taller, maxHeight = taller),
                        )
                        layout(placeable.width, constraints.maxHeight) { placeable.place(0, 0) }
                    }
                    .graphicsLayer {
                        alpha = materialAlpha()
                        // 下缘的 DstIn 渐隐要有自己的离屏缓冲，否则会把底下的页面一起挖掉
                        compositingStrategy = CompositingStrategy.Offscreen
                    }
                    .drawWithContent {
                        drawContent()
                        val fade = (KtHeader.edgeSoftening.toPx() / size.height).coerceIn(0f, 1f)
                        val start = 1f - fade
                        val stops = KtHeader.softeningStops
                        drawRect(
                            brush = Brush.verticalGradient(
                                0f to Color.Black,
                                start to Color.Black,
                                start + fade * 0.25f to Color.Black.copy(alpha = stops[0]),
                                start + fade * 0.50f to Color.Black.copy(alpha = stops[1]),
                                start + fade * 0.75f to Color.Black.copy(alpha = stops[2]),
                                1f to Color.Transparent,
                            ),
                            blendMode = BlendMode.DstIn,
                        )
                    }
                    .headerMaterial(backdrop),
            )
        }
        Row(
            Modifier
                .padding(top = topInset)
                .heightIn(
                    min = if (onBack == null && actions == null) {
                        KtHeader.titleOnlyMinHeight
                    } else {
                        KtHeader.minHeight
                    },
                )
                .padding(horizontal = KtSpacing.Gap.control),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) {
                KtIconButton(
                    icon = R.drawable.ic_arrow_left,
                    contentDescription = "返回",
                    onClick = onBack,
                )
            } else {
                // 没有返回键时，紧凑标题也要落在页面水平边距上，不贴着屏幕边
                Spacer(Modifier.width(KtSpacing.Padding.pageX - KtSpacing.Gap.control))
            }
            Text(
                title,
                style = KtType.title,
                color = colors.text.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = KtSpacing.Gap.related)
                    .graphicsLayer {
                        // 一次读完，别调两遍：两次调用之间滚动可能已经走了一帧
                        val q = titleFollow()
                        alpha = KtHeader.handoverProgress(q, reduced)
                        if (!reduced) {
                            // 缩放从左中开始，左边界才不会跟着字号一起漂
                            transformOrigin = TransformOrigin(0f, 0.5f)
                            // 纵向必须线性：它是照大标题的中心算出来的，改了就跟不住了
                            translationY = (1f - q) * followPx
                            // 横向和缩放**故意后置**（1 - q²）：交接发生在 q 很小的时候，
                            // 那一刻这两样几乎还没动，两份标题严丝合缝地重合，
                            // 看不出是换了一个 Text 在画。线性的话交接那一帧会差出十来个像素，
                            // 表现就是一层重影。
                            val back = 1f - q * q
                            translationX = back * startDxPx
                            val scale = 1f + back * (startScale - 1f)
                            scaleX = scale
                            scaleY = scale
                        }
                    },
            )
            if (actions != null) actions()
        }
    }
}

