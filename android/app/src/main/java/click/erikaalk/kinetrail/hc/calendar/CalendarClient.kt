// 拉取日历数据：GET /app/calendar，鉴权用的是同一个推送令牌。
// 只读，不写任何东西；不打印令牌、日期以外的内容与体测数值。

package click.erikaalk.kinetrail.hc.calendar

import click.erikaalk.kinetrail.hc.BuildConfig
import click.erikaalk.kinetrail.hc.KINETRAIL_ORIGIN
import click.erikaalk.kinetrail.hc.PushException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId

private const val ENDPOINT = "$KINETRAIL_ORIGIN/app/calendar"

/**
 * 取一个月（含首尾整月）的训练与体测，返回服务端原文和解析结果；原文给调用方原样存进本机缓存。
 * 失败抛 [PushException]，消息直接给界面看。
 */
suspend fun fetchCalendar(token: String, month: YearMonth, zone: ZoneId = ZoneId.systemDefault()): Pair<String, CalendarRange> =
    fetchCalendar(token, month.atDay(1), month.atEndOfMonth(), zone)

suspend fun fetchCalendar(token: String, from: LocalDate, to: LocalDate, zone: ZoneId): Pair<String, CalendarRange> =
    withContext(Dispatchers.IO) {
        val url = URL("$ENDPOINT?from=$from&to=$to&tz=$zone")
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("authorization", "Bearer $token")
            connection.setRequestProperty("accept", "application/json")
            connection.setRequestProperty("user-agent", "KinetrailHc/${BuildConfig.VERSION_NAME}")
            val status = connection.responseCode
            val text = (if (status < 400) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status != 200) {
                throw PushException(
                    when (status) {
                        401 -> "令牌无效，请重新保存令牌"
                        404 -> "服务端还没有日历接口，先部署新版 Worker 再试"
                        400 -> "服务端拒绝了查询范围（400）"
                        429 -> "请求过于频繁（429），稍后再试"
                        else -> "读取失败：HTTP $status"
                    },
                )
            }
            text to parseCalendar(text)
        } finally {
            connection.disconnect()
        }
    }
