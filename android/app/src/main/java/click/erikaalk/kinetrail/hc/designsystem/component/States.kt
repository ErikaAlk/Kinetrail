package click.erikaalk.kinetrail.hc.designsystem.component

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.R
import click.erikaalk.kinetrail.hc.designsystem.KtRadius
import click.erikaalk.kinetrail.hc.designsystem.KtSemanticFamily
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.designsystem.ktFocusRing

/** 提示条的语气。语义色独立于品牌色，别拿 accent 当状态色使。 */
enum class BannerTone { Success, Info, Warning, Error }

/**
 * 行内提示条。
 *
 * 带颜色的状态提示**必须同时挂形状**：颜色不能成为状态的唯一载体，
 * 色觉障碍和高对比度模式下只剩形状和文字。
 */
@Composable
fun InlineBanner(
    text: String,
    modifier: Modifier = Modifier,
    tone: BannerTone = BannerTone.Warning,
) {
    val colors = ktColors
    val family: KtSemanticFamily = when (tone) {
        BannerTone.Success -> colors.semantic.success
        BannerTone.Info -> colors.semantic.info
        BannerTone.Warning -> colors.semantic.warning
        BannerTone.Error -> colors.semantic.error
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(KtRadius.mediumShape)
            .background(family.subtle)
            .padding(
                horizontal = KtSpacing.Padding.controlX,
                vertical = KtSpacing.Padding.controlY,
            ),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline),
    ) {
        Icon(
            painter = painterResource(if (tone == BannerTone.Success) R.drawable.ic_circle_check else R.drawable.ic_triangle_alert),
            contentDescription = null,
            tint = family.text,
            modifier = Modifier.size(20.dp),
        )
        Text(
            text,
            style = KtType.secondary,
            color = family.text,
            modifier = Modifier.weight(1f),
        )
    }
}
