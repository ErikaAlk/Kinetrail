package click.erikaalk.kinetrail.hc.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtTheme
import click.erikaalk.kinetrail.hc.designsystem.LocalReducedMotion
import click.erikaalk.kinetrail.hc.designsystem.component.KtHeader
import click.erikaalk.kinetrail.hc.designsystem.component.KtPageHeader
import click.erikaalk.kinetrail.hc.designsystem.component.LocalTitleHandover
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.provideBackdrop
import click.erikaalk.kinetrail.hc.designsystem.rememberBackdrop

@Composable
fun KinetrailApp(state: AppState, actions: AppActions) {
    KtTheme(darkTheme = isSystemInDarkTheme()) { Root(state, actions) }
}

/** 页面共用的上下余量：顶栏量出来的高度，底部是手势条加页面内边距。 */
data class PageInsets(val top: Dp, val bottom: Dp, val onTitleBounds: (Float, Float) -> Unit)

@Composable
private fun Root(state: AppState, actions: AppActions) {
    val colors = ktColors
    val reducedMotion = LocalReducedMotion.current
    val backdrop = rememberBackdrop()
    val density = LocalDensity.current
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val navInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val home = state.screen == Screen.Home

    var headerHeight by remember(topInset) { mutableStateOf(topInset + KtHeader.minHeight) }
    // 大标题的上下边在布局阶段写入、顶栏在绘制阶段读取，滚动不触发重组（沿用 Android 基础参考的收起口径）。
    val titleTopPx = remember { mutableFloatStateOf(Float.MAX_VALUE) }
    val titleBottomPx = remember { mutableFloatStateOf(Float.MAX_VALUE) }
    val headerBottomPx = with(density) { headerHeight.toPx() }
    val topInsetPx = with(density) { topInset.toPx() }
    val fadePx = with(density) { KtHeader.materialFade.toPx() }
    val followPx = with(density) { KtHeader.titleFollow.toPx() }
    val slotCenterPx = topInsetPx + (headerBottomPx - topInsetPx) / 2f
    val materialAlpha = remember(headerBottomPx, fadePx) {
        { KtHeader.materialProgress(titleTopPx.floatValue, headerBottomPx, fadePx) }
    }
    val titleFollow = remember(slotCenterPx, followPx) {
        { KtHeader.followProgress((titleTopPx.floatValue + titleBottomPx.floatValue) / 2f, slotCenterPx, followPx) }
    }
    LaunchedEffect(state.screen) {
        titleTopPx.floatValue = Float.MAX_VALUE
        titleBottomPx.floatValue = Float.MAX_VALUE
    }
    BackHandler(enabled = !home) { actions.navigate(Screen.Home) }

    val insets = PageInsets(
        top = headerHeight,
        bottom = navInset + KtSpacing.space8,
        onTitleBounds = remember {
            { top: Float, bottom: Float ->
                titleTopPx.floatValue = top
                titleBottomPx.floatValue = bottom
            }
        },
    )

    Box(Modifier.fillMaxSize().background(colors.canvas)) {
        Box(Modifier.fillMaxSize().provideBackdrop(backdrop)) {
            CompositionLocalProvider(
                LocalTitleHandover provides { KtHeader.handoverProgress(titleFollow(), reducedMotion) },
            ) {
                when (state.screen) {
                    Screen.Home -> HomeScreen(state, actions, insets)
                    Screen.Calendar -> CalendarScreen(state, actions, insets)
                    Screen.Report -> ReportScreen(state, actions, insets)
                    Screen.Token -> TokenScreen(actions, insets)
                }
            }
        }
        KtPageHeader(
            title = when (state.screen) {
                Screen.Home -> "身迹同步"
                Screen.Calendar -> "训练日历"
                Screen.Report -> "核对报告"
                Screen.Token -> "推送令牌"
            },
            materialAlpha = materialAlpha,
            titleFollow = titleFollow,
            backdrop = backdrop,
            topInset = topInset,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .onSizeChanged { headerHeight = with(density) { it.height.toDp() } },
            onBack = if (home) null else ({ actions.navigate(Screen.Home) }),
        )
    }
}
