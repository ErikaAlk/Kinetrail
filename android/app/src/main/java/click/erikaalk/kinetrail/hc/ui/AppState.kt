package click.erikaalk.kinetrail.hc.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import click.erikaalk.kinetrail.hc.calendar.CalendarDay
import click.erikaalk.kinetrail.hc.report.ParseResult
import java.time.LocalDate
import java.time.YearMonth

enum class Screen { Home, Calendar, Report, Token }

sealed interface ReportState {
    data object Recognizing : ReportState
    data class Failed(val message: String) : ReportState
    data class Parsed(val result: ParseResult) : ReportState
}

sealed interface UploadState {
    data object Idle : UploadState
    data object Uploading : UploadState
    data class Done(val ok: Boolean, val message: String) : UploadState
}

/** 界面状态。Activity 声明了 configChanges，不会因旋转或换主题重建，所以不需要 ViewModel。 */
class AppState {
    var screen by mutableStateOf(Screen.Home)

    var tokenSaved by mutableStateOf(false)
    /** null = Health Connect 不可用。 */
    var grantedPermissions by mutableStateOf<Int?>(null)
    var totalPermissions by mutableStateOf(0)

    var syncing by mutableStateOf(false)
    var lastSyncAt by mutableStateOf<Long?>(null)
    var lastSyncMessage by mutableStateOf<String?>(null)
    var lastSyncOk by mutableStateOf(true)

    var report by mutableStateOf<ReportState>(ReportState.Recognizing)
    var upload by mutableStateOf<UploadState>(UploadState.Idle)

    /** 日历：一次显示一个月，数据来自服务端，与 Health Connect 同步互不影响。 */
    var month by mutableStateOf<YearMonth>(YearMonth.now())
    var selectedDate by mutableStateOf<LocalDate?>(null)
    var calendarDays by mutableStateOf<Map<LocalDate, CalendarDay>>(emptyMap())
    /** 已经取回来的是哪个月；为 null 表示当前这个月还没有可用数据。 */
    var calendarLoadedMonth by mutableStateOf<YearMonth?>(null)
    var calendarLoading by mutableStateOf(false)
    var calendarError by mutableStateOf<String?>(null)
    var calendarTruncated by mutableStateOf(false)
}

/** 界面发给 Activity 的动作。 */
interface AppActions {
    fun sync()
    fun openCalendar()
    fun showMonth(month: YearMonth)
    fun selectDate(date: LocalDate)
    fun requestPermissions()
    fun pickReport()
    fun uploadReport()
    fun saveToken(token: String): Boolean
    fun navigate(screen: Screen)
}
