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
 * 识图结果核对页：摘要 → 各分区读数 → 上传。
 * 交叉校验不过（数字读错了）或者连时间、体重都没认出时不给上传，只给重新选择：服务端对同一次称重的报告不可变，
 * 宁可拦下来也不把读错的数写进去。个别指标没认出不拦——列在页顶，上传的 JSON 里没有这几项，同时说清楚补不回来。
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
        PageTitle(text = Screen.Report.title, onTitleBounds = insets.onTitleBounds)
        val parsed = (state.report as? ReportState.Parsed)?.result
        if (parsed?.uploadable != true || parsed.missed.isNotEmpty()) Column(
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
                is ReportState.Parsed -> {
                    val result = report.result
                    if (!result.uploadable) {
                        InlineBanner(result.problems.joinToString("\n"), tone = BannerTone.Warning)
                        SecondaryButton("重新选择图片", onClick = actions::pickReport)
                    } else if (result.missed.isNotEmpty()) {
                        InlineBanner(
                            "没认出：${result.missed.joinToString("、")}。\n" +
                                "其余读数可以照常上传，缺的这几项报告挂上去之后补不回来；想要完整的就换一张更清楚的图。",
                            tone = BannerTone.Warning,
                        )
                        SecondaryButton("重新选择图片", onClick = actions::pickReport)
                    }
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
                    text = when {
                        upload == UploadState.Uploading -> "上传中…"
                        parsed.missed.isNotEmpty() -> "仍然上传（缺 ${parsed.missed.size} 项）"
                        else -> "上传到 Kinetrail"
                    },
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
            Metric(r.bodyFatPct?.let { "${one(it)}%" } ?: MISSING, "体脂率")
            Metric(r.bodyScore?.let { fmt(it) } ?: MISSING, "身体得分")
        }
        val meta = listOfNotNull(r.age?.let { "年龄 $it" }, r.heightCm?.let { "身高 ${fmt(it)} cm" })
        if (meta.isNotEmpty()) Text(
            meta.joinToString(" · "),
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
    fun mass(m: Measured?, pct: Double?): String? {
        if (m == null) return null
        // 报告里只有体重是两位小数
        return if (pct == null) "${"%.2f".format(m.value)} kg" else "${one(m.value)} kg · ${one(pct)}%"
    }
    fun range(m: Measured?) = m?.let { "标准 ${one(it.min)}–${one(it.max)} kg" }
    val composition = listOf(
        Triple("体重", r.weight, null), Triple("体脂", r.bodyFat, r.bodyFatPct), Triple("骨重量", r.boneMass, r.boneMassPct),
        Triple("蛋白质", r.protein, r.proteinPct), Triple("身体水份", r.bodyWater, r.bodyWaterPct),
        Triple("肌肉", r.muscle, r.musclePct), Triple("骨骼肌", r.skeletalMuscle, r.skeletalMusclePct),
    )
    SettingsSection(
        title = "身体成分",
        rows = composition.map { (label, m, pct) ->
            { SettingRow(title = label, subtitle = range(m), value = mass(m, pct) ?: MISSING) }
        },
    )
    Values(
        "体重控制",
        listOf(
            "目标体重" to r.targetWeight?.let { "${one(it)} kg" }, "体重控制" to r.weightControl?.let { "${one(it)} kg" },
            "脂肪控制" to r.fatControl?.let { "${one(it)} kg" }, "肌肉控制" to r.muscleControl?.let { "${one(it)} kg" },
        ),
    )
    Values(
        "其他指标",
        listOf(
            "BMI" to r.bmi?.let { one(it) }, "肥胖度" to r.obesityDegreePct?.let { "${fmt(it)}%" },
            "内脏脂肪等级" to r.visceralFat?.let { fmt(it) },
            "基础代谢率" to r.bmr?.let { "${fmt(it)} 千卡" }, "去脂体重" to r.fatFreeMass?.let { "${one(it)} kg" },
            "皮下脂肪" to r.subcutaneousFatPct?.let { "${one(it)}%" }, "SMI" to r.smi?.let { "${one(it)} kg/m²" },
            "身体年龄" to r.bodyAge?.let { fmt(it) }, "腰臀比" to r.whr?.let { one(it) },
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

/** 这一项没认出来：行照常留着，值写清楚，免得以为是报告上没有。 */
private const val MISSING = "未识别"

private val SEGMENT_LABELS = listOf("left_arm" to "左臂", "right_arm" to "右臂", "trunk" to "躯干", "left_leg" to "左腿", "right_leg" to "右腿")

@Composable
private fun Segment(title: String, s: Segments<SegmentValue>) {
    val values = s.toList().toMap()
    Values(title, SEGMENT_LABELS.map { (key, label) -> values.getValue(key).let { label to "${one(it.kg)} kg · ${one(it.pct)}%" } })
}

@Composable
private fun Values(title: String, rows: List<Pair<String, String?>>) {
    SettingsSection(title = title, rows = rows.map { (label, value) -> { SettingRow(title = label, value = value ?: MISSING) } })
}
