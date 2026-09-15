package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.component.BannerTone
import click.erikaalk.kinetrail.hc.designsystem.component.InlineBanner
import click.erikaalk.kinetrail.hc.designsystem.component.KtCard
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.PrimaryButton
import click.erikaalk.kinetrail.hc.designsystem.component.SecondaryButton
import click.erikaalk.kinetrail.hc.designsystem.component.SettingRow
import click.erikaalk.kinetrail.hc.designsystem.component.SettingsSection
import click.erikaalk.kinetrail.hc.designsystem.ktColors
import click.erikaalk.kinetrail.hc.report.BodyReport
import click.erikaalk.kinetrail.hc.report.Measured
import click.erikaalk.kinetrail.hc.report.SegmentValue
import click.erikaalk.kinetrail.hc.report.Segments
import click.erikaalk.kinetrail.hc.report.fmt
import java.time.format.DateTimeFormatter

/**
 * 识图结果核对页：摘要 → 各分区读数 → 上传。读不全或交叉校验不过时不给上传，只给重新选择。
 * 服务端对同一次称重的报告不可变，所以宁可拦下来，也不把读错的数写进去。
 */
@Composable
fun ReportScreen(state: AppState, actions: AppActions, insets: PageInsets) {
    val pad = Modifier.padding(horizontal = KtSpacing.Padding.pageX)
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = insets.top, bottom = insets.bottom),
    ) {
        PageTitle(text = "核对报告", onTitleBounds = insets.onTitleBounds)
        val parsed = (state.report as? ReportState.Parsed)?.result
        if (parsed?.uploadable != true) Column(
            pad.padding(top = KtSpacing.pageTitleToSection),
            verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.group),
        ) {
            when (val report = state.report) {
                ReportState.Recognizing -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KtSpacing.Gap.inline),
                ) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = ktColors.accent.text, strokeWidth = 2.dp)
                    Text("正在识别…", style = KtType.body, color = ktColors.text.secondary)
                }
                is ReportState.Failed -> {
                    InlineBanner(report.message, tone = BannerTone.Error)
                    SecondaryButton("重新选择图片", onClick = actions::pickReport)
                }
                is ReportState.Parsed -> if (!report.result.uploadable) {
                    InlineBanner(report.result.problems.joinToString("\n"), tone = BannerTone.Warning)
                    SecondaryButton("重新选择图片", onClick = actions::pickReport)
                }
            }
        }
        val body = parsed?.report ?: return@Column

        Summary(body)
        ReportSections(body)

        Column(
            pad.padding(top = KtSpacing.Gap.section),
            verticalArrangement = Arrangement.spacedBy(KtSpacing.Gap.group),
        ) {
            val upload = state.upload
            if (upload is UploadState.Done) {
                InlineBanner(upload.message, tone = if (upload.ok) BannerTone.Success else BannerTone.Error)
            }
            if (!state.tokenSaved) InlineBanner("保存推送令牌后才能上传。", tone = BannerTone.Warning)
            if (parsed.uploadable && !(upload is UploadState.Done && upload.ok)) {
                PrimaryButton(
                    text = if (upload == UploadState.Uploading) "上传中…" else "上传到 Kinetrail",
                    enabled = state.tokenSaved && upload != UploadState.Uploading,
                    onClick = actions::uploadReport,
                )
            }
        }
    }
}

@Composable
private fun Summary(r: BodyReport) {
    val colors = ktColors
    KtCard(Modifier.padding(top = KtSpacing.pageTitleToSection)) {
        Text(
            r.measuredAt.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")),
            style = KtType.secondary,
            color = colors.text.secondary,
        )
        Row(
            Modifier.padding(top = KtSpacing.Gap.related),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(KtSpacing.space6),
        ) {
            Metric("${"%.2f".format(r.weight.value)} kg", "体重")
            Metric("${one(r.bodyFatPct)}%", "体脂率")
            Metric(fmt(r.bodyScore), "身体得分")
        }
        Text(
            "年龄 ${r.age} · 身高 ${fmt(r.heightCm)} cm",
            style = KtType.secondary,
            color = colors.text.secondary,
            modifier = Modifier.padding(top = KtSpacing.Gap.inline),
        )
    }
}

@Composable
private fun Metric(value: String, label: String) {
    Column {
        Text(value, style = KtType.metric, color = ktColors.text.primary)
        Text(label, style = KtType.caption, color = ktColors.text.secondary)
    }
}

@Composable
private fun ReportSections(r: BodyReport) {
    fun mass(m: Measured, pct: Double?) = buildString {
        // 报告里只有体重是两位小数
        append(if (pct == null) "${"%.2f".format(m.value)} kg" else "${one(m.value)} kg")
        if (pct != null) append(" · ${one(pct)}%")
    }
    fun range(m: Measured) = "标准 ${one(m.min)}–${one(m.max)} kg"
    val composition = listOf(
        Triple("体重", r.weight, null), Triple("体脂", r.bodyFat, r.bodyFatPct), Triple("骨重量", r.boneMass, r.boneMassPct),
        Triple("蛋白质", r.protein, r.proteinPct), Triple("身体水份", r.bodyWater, r.bodyWaterPct),
        Triple("肌肉", r.muscle, r.musclePct), Triple("骨骼肌", r.skeletalMuscle, r.skeletalMusclePct),
    )
    SettingsSection(
        title = "身体成分",
        rows = composition.map { (label, m, pct) -> { SettingRow(title = label, subtitle = range(m), value = mass(m, pct)) } },
    )
    Values(
        "体重控制",
        listOf(
            "目标体重" to "${one(r.targetWeight)} kg", "体重控制" to "${one(r.weightControl)} kg",
            "脂肪控制" to "${one(r.fatControl)} kg", "肌肉控制" to "${one(r.muscleControl)} kg",
        ),
    )
    Values(
        "其他指标",
        listOf(
            "BMI" to one(r.bmi), "肥胖度" to "${fmt(r.obesityDegreePct)}%", "内脏脂肪等级" to fmt(r.visceralFat),
            "基础代谢率" to "${fmt(r.bmr)} 千卡", "去脂体重" to "${one(r.fatFreeMass)} kg",
            "皮下脂肪" to "${one(r.subcutaneousFatPct)}%", "SMI" to "${one(r.smi)} kg/m²",
            "身体年龄" to fmt(r.bodyAge), "腰臀比" to one(r.whr),
        ),
    )
    r.segmentFat?.let { Segment("分段脂肪", it) }
    r.segmentMuscle?.let { Segment("分段肌肉", it) }
    r.impedance?.let { imp ->
        val freqs = imp.keys.sorted()
        Values(
            "生物电阻抗（${freqs.joinToString(" / ")} kHz）",
            SEGMENT_LABELS.map { (key, label) ->
                label to freqs.joinToString(" / ") { f -> one(imp.getValue(f).toList().toMap().getValue(key)) } + " Ω"
            },
        )
    }
}

/** 报告里质量、比例、阻抗都显示一位小数（2.0 kg、338.0 Ω），核对时照原样显示。 */
private fun one(v: Double) = "%.1f".format(v)

private val SEGMENT_LABELS = listOf("left_arm" to "左臂", "right_arm" to "右臂", "trunk" to "躯干", "left_leg" to "左腿", "right_leg" to "右腿")

@Composable
private fun Segment(title: String, s: Segments<SegmentValue>) {
    val values = s.toList().toMap()
    Values(title, SEGMENT_LABELS.map { (key, label) -> values.getValue(key).let { label to "${one(it.kg)} kg · ${one(it.pct)}%" } })
}

@Composable
private fun Values(title: String, rows: List<Pair<String, String>>) {
    SettingsSection(title = title, rows = rows.map { (label, value) -> { SettingRow(title = label, value = value) } })
}
