package click.erikaalk.kinetrail.hc.ui

import androidx.compose.runtime.Composable
import click.erikaalk.coloroskit.components.CoCardPosition
import click.erikaalk.coloroskit.components.CoCategoryTitle
import click.erikaalk.coloroskit.components.CoListItem
import click.erikaalk.coloroskit.components.CoTrailing
import click.erikaalk.kinetrail.hc.report.ReportFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 同步页：把体测推上去的两件事都在这里——Health Connect 里的称重，和报告图片补的读数。
 * 行尾是当前值（上次同步时间、权限状态），第二行是这次同步的结果，或者现在做不了的原因（DESIGN §9、§10）。
 */
@Composable
fun SyncScreen(state: AppState, actions: AppActions) {
    val granted = state.grantedPermissions
    val complete = granted != null && granted == state.totalPermissions
    KtPage(Screen.Sync.title, bottomExtra = TabBarRoom) {
        CoCategoryTitle("Health Connect")
        CoListItem(
            "立即同步", CoCardPosition.Head,
            summary = when {
                granted == null -> "这台手机的 Health Connect 不可用"
                !state.tokenSaved -> "先在“设置 - 推送令牌”保存令牌"
                !complete -> "开启全部读取权限后可用"
                state.syncing -> null
                else -> state.lastSyncMessage
            },
            trailing = CoTrailing.Status(if (state.syncing) "正在同步…" else syncTime(state.lastSyncAt), arrow = false),
            enabled = state.tokenSaved && complete && !state.syncing,
            onClick = actions::sync,
        )
        val canRequest = granted != null && !complete
        CoListItem(
            "读取权限", CoCardPosition.Tail,
            trailing = CoTrailing.Status(
                when {
                    granted == null -> "不可用"
                    complete -> "已开启"
                    else -> "缺 ${state.totalPermissions - granted} 项"
                },
                arrow = canRequest,
            ),
            onClick = if (canRequest) actions::requestPermissions else null,
        )

        CoCategoryTitle("体测报告")
        CoListItem(
            "识别报告图片", CoCardPosition.Full,
            summary = "报告版式未适配，识别不出读数".takeIf { state.reportFormat == ReportFormat.XiaomiS800 },
            trailing = CoTrailing.Arrow,
            onClick = actions::pickReport,
        )
        // 数据离开设备要写清发什么（DESIGN §10）
        Footer("图片在本机识别，只上传识别出的读数")
    }
}

/** 过去的时间：今天、昨天写“今天 10:23”，再往前写日期，跨年加年份（DESIGN §14）。 */
private fun syncTime(at: Long?): String {
    if (at == null) return "未同步"
    val time = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault())
    val today = LocalDate.now()
    val clock = time.format(DateTimeFormatter.ofPattern("HH:mm"))
    return when (time.toLocalDate()) {
        today -> "今天 $clock"
        today.minusDays(1) -> "昨天 $clock"
        else -> time.format(DateTimeFormatter.ofPattern(if (time.year == today.year) "M月d日 HH:mm" else "yyyy年M月d日 HH:mm"))
    }
}
