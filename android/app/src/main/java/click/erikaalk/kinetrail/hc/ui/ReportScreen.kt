package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import click.erikaalk.coloroskit.components.CoAlertDialog
import click.erikaalk.coloroskit.components.CoBarAction
import click.erikaalk.coloroskit.components.CoButton
import click.erikaalk.coloroskit.components.CoCard
import click.erikaalk.coloroskit.components.CoCategoryTitle
import click.erikaalk.coloroskit.components.CoDialogButton
import click.erikaalk.coloroskit.components.CoDialogButtonRole
import click.erikaalk.coloroskit.components.CoEmptyState
import click.erikaalk.coloroskit.components.CoListItem
import click.erikaalk.coloroskit.components.CoLoading
import click.erikaalk.coloroskit.components.CoTrailing
import click.erikaalk.coloroskit.tokens.CoTokens
import click.erikaalk.kinetrail.hc.report.BodyReport
import click.erikaalk.kinetrail.hc.report.Measured
import click.erikaalk.kinetrail.hc.report.SegmentValue
import click.erikaalk.kinetrail.hc.report.Segments
import click.erikaalk.kinetrail.hc.report.fmt
import java.time.LocalDate
import java.time.format.DateTimeFormatter

private val L = CoTokens.List

/**
 * 识图结果核对页：摘要 → 各分区读数 → 上传。
 * 交叉校验不过（数字读错了）或者连时间、体重都没认出时不给上传，只给重新选择：服务端对同一次称重的报告不可变，
 * 宁可拦下来也不把读错的数写进去。个别指标没认出不拦，值写“未识别”；上传前用确认框说清缺的几项补不回来。
 */
@Composable
fun ReportScreen(state: AppState, actions: AppActions) {
    KtPage(
        Screen.Report.title,
        onBack = { actions.navigate(Screen.Sync) },
        actions = listOf(CoBarAction("重新选择图片", onClick = actions::pickReport, icon = { GlyphIcon(Glyph.Image, it) })),
    ) {
        when (val report = state.report) {
            ReportState.Recognizing -> Column(
                Modifier.fillMaxWidth().padding(vertical = CoTokens.EmptyState.unboundedPaddingV),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CoLoading(large = true)
                BasicText(
                    "正在识别…",
                    Modifier.padding(top = L.categoryMarginV),
                    style = CoTokens.Type.bodyM.toTextStyle().copy(color = CoTokens.Color.label2.current),
                )
            }
            is ReportState.Failed -> CoEmptyState("无法读取图片", subtitle = report.message, actionText = "重新选择", onAction = actions::pickReport)
            is ReportState.Parsed -> {
                val result = report.result
                val body = result.report
                when {
                    body == null -> CoEmptyState(
                        "无法识别报告", subtitle = result.problems.joinToString("；"), actionText = "重新选择", onAction = actions::pickReport,
                    )
                    // 读错了不能只写“未识别”：逐条列出哪里对不上，下面的读数照常摆出来对照
                    !result.uploadable -> {
                        CoCategoryTitle("读数对不上，不能上传")
                        CoCard {
                            result.problems.forEach {
                                BasicText(it, style = L.summary.toTextStyle().copy(color = CoTokens.Color.label1.current))
                            }
                        }
                    }
                }
                if (body != null) {
                    Summary(body)
                    ReportSections(body)
                    if (result.uploadable) UploadBar(state, actions, result.missed)
                }
            }
        }
    }
}

/**
 * 上传按钮和结果。缺项时先弹确认框：报告挂上后不可改，缺的几项补不回来（DESIGN §11.4：不可逆后果写在确认框里）。
 * 成功后按钮收起，只留结果；失败时结果写在按钮上方，按钮还能再点。
 */
@Composable
private fun UploadBar(state: AppState, actions: AppActions, missed: List<String>) {
    val upload = state.upload
    var confirming by remember { mutableStateOf(false) }
    val note = when {
        upload is UploadState.Done -> upload.message
        !state.tokenSaved -> "先在“设置 - 推送令牌”保存令牌"
        else -> null
    }
    Column(Modifier.fillMaxWidth().padding(top = L.groupTop * 2), horizontalAlignment = Alignment.CenterHorizontally) {
        note?.let {
            BasicText(
                it,
                Modifier.fillMaxWidth().padding(horizontal = L.categoryIndent),
                style = CoTokens.Type.bodyS.toTextStyle().copy(color = CoTokens.Color.label2.current, textAlign = TextAlign.Center),
            )
        }
        if (upload is UploadState.Done && upload.ok) return@Column
        CoButton(
            when {
                upload == UploadState.Uploading -> "正在上传…"
                missed.isNotEmpty() -> "上传（缺 ${missed.size} 项）"
                else -> "上传到 Kinetrail"
            },
            onClick = { if (missed.isEmpty()) actions.uploadReport() else confirming = true },
            modifier = Modifier.fillMaxWidth().padding(horizontal = L.categoryIndent).padding(top = L.categoryMarginV),
            enabled = state.tokenSaved && upload != UploadState.Uploading,
        )
    }
    if (confirming) {
        CoAlertDialog(
            onDismissRequest = { confirming = false },
            title = "要上传缺 ${missed.size} 项的报告吗？",
            message = "未识别：${missed.joinToString("、")}。报告挂到这次称重上之后不能修改，缺的这几项补不回来",
            buttons = listOf(
                CoDialogButton("上传", CoDialogButtonRole.Recommended, onClick = actions::uploadReport),
                CoDialogButton("取消", onClick = {}),
            ),
        )
    }
}

@Composable
private fun Summary(r: BodyReport) {
    val today = LocalDate.now()
    CoCategoryTitle(r.measuredAt.format(DateTimeFormatter.ofPattern(if (r.measuredAt.year == today.year) "M月d日 HH:mm" else "yyyy年M月d日 HH:mm")))
    CoCard {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(L.statusGap), verticalArrangement = Arrangement.spacedBy(L.paddingV)) {
            Metric("${"%.2f".format(r.weight.value)} kg", "体重")
            Metric(r.bodyFatPct?.let { "${one(it)}%" } ?: MISSING, "体脂率")
            Metric(r.bodyScore?.let { fmt(it) } ?: MISSING, "身体得分")
        }
        val meta = listOfNotNull(r.age?.let { "年龄 $it" }, r.heightCm?.let { "身高 ${fmt(it)} cm" })
        if (meta.isNotEmpty()) BasicText(
            metaText(meta),
            Modifier.padding(top = L.paddingV),
            style = L.summary.toTextStyle().copy(color = CoTokens.Color.label2.current),
        )
    }
}

@Composable
private fun Metric(value: String, label: String) {
    Column(Modifier.semantics(mergeDescendants = true) {}) {
        BasicText(value, style = CoTokens.Type.headlineM.toTextStyle().copy(color = CoTokens.Color.label1.current, fontFeatureSettings = "tnum"))
        BasicText(label, style = CoTokens.Type.bodyXS.toTextStyle().copy(color = CoTokens.Color.label2.current))
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
    CoCategoryTitle("身体成分")
    composition.forEachIndexed { i, (label, m, pct) ->
        CoListItem(
            label, positionOf(i, composition.size),
            summary = range(m),
            trailing = CoTrailing.Status(mass(m, pct) ?: MISSING, arrow = false),
        )
    }
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
    CoCategoryTitle(title)
    rows.forEachIndexed { i, (label, value) ->
        CoListItem(label, positionOf(i, rows.size), trailing = CoTrailing.Status(value ?: MISSING, arrow = false))
    }
}
