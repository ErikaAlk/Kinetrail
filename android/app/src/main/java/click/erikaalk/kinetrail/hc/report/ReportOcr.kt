// ML Kit 中文文字识别（模型打包在 APK 里，离线），把图片变成文本行交给 ReportParser。图片不离开手机。

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

suspend fun recognizeReport(context: Context, uri: Uri): ParseResult = withContext(Dispatchers.Default) {
    val image = InputImage.fromFilePath(context, uri)
    val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    try {
        val text = recognizer.process(image).await()
        val lines = text.textBlocks.flatMap { it.lines }.mapNotNull { line ->
            line.boundingBox?.let { OcrLine(line.text, it.left.toFloat(), it.top.toFloat(), it.right.toFloat(), it.bottom.toFloat()) }
        }
        // 调试版把识别出的文本行留在应用私有目录，便于对照真实报告调解析规则（adb run-as 才能取）。
        if (BuildConfig.DEBUG) dumpLines(context, lines, image.width)
        ReportParser.parse(lines, image.width.toFloat())
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
