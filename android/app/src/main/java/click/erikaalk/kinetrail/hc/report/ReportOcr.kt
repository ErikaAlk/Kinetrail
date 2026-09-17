// ML Kit 中文文字识别（模型打包在 APK 里，离线），把图片变成文本行，按设置里选的报告版式交给对应的解析器。图片不离开手机。

package click.erikaalk.kinetrail.hc.report

import android.content.Context
import android.net.Uri
import click.erikaalk.kinetrail.hc.BuildConfig
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 体测报告的版式，设置页里选。适配新的秤见 `docs/xiaomi-s800.md`。 */
enum class ReportFormat(val label: String) {
    FitDaysPlus("FitDays+"),

    /** 占位：还没有解析器。识别照常跑（调试版照常导出文本行），结果只提示未适配。 */
    XiaomiS800("小米体脂秤 S800"),
}

suspend fun recognizeReport(context: Context, uri: Uri, format: ReportFormat): ParseResult = withContext(Dispatchers.Default) {
    val image = InputImage.fromFilePath(context, uri)
    val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    try {
        val text = recognizer.process(image).await()
        val lines = text.textBlocks.flatMap { it.lines }.mapNotNull { line ->
            line.boundingBox?.let { OcrLine(line.text, it.left.toFloat(), it.top.toFloat(), it.right.toFloat(), it.bottom.toFloat()) }
        }
        // 调试版把识别出的文本行留在应用私有目录，便于对照真实报告调解析规则（adb run-as 才能取）。
        if (BuildConfig.DEBUG) dumpLines(context, lines, image.width)
        when (format) {
            ReportFormat.FitDaysPlus -> ReportParser.parse(lines, image.width.toFloat())
            ReportFormat.XiaomiS800 -> ParseResult(null, listOf("还没有适配${format.label} 的报告。"))
        }
    } finally {
        recognizer.close()
    }
}

private fun dumpLines(context: Context, lines: List<OcrLine>, width: Int) {
    val body = lines.joinToString(",\n", "{\"width\":$width,\"lines\":[\n", "\n]}") {
        val text = it.text.replace("\\", "\\\\").replace("\"", "\\\"")
        "{\"text\":\"$text\",\"box\":[${it.left.toInt()},${it.top.toInt()},${it.right.toInt()},${it.bottom.toInt()}]}"
    }
    runCatching { File(context.filesDir, "last-ocr.json").writeText(body) }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnSuccessListener { cont.resume(it) }
    addOnFailureListener { cont.resumeWithException(it) }
}
