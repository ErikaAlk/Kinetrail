package click.erikaalk.kinetrail.hc.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import click.erikaalk.kinetrail.hc.calendar.CalendarDay
import click.erikaalk.kinetrail.hc.report.ParseResult
import java.time.LocalDate
import java.time.YearMonth

/** 前三个是底栏上的一级目的地，后两个是从它们进去的子页面。 */
enum class Screen(val title: String) {
    Records("训练日历"),
    Sync("体测同步"),
    Settings("设置"),
    Report("核对报告"),
    Token("推送令牌"),
}

/**
 * 这个页面归属的一级目的地。底栏据此高亮，返回键据此回退；
 * 一级目的地自己返回自己，所以 `screen.tab == screen` 就是"没有可返回的上一层"。
 */
val Screen.tab: Screen
    get() = when (this) {
        Screen.Report -> Screen.Sync
        Screen.Token -> Screen.Settings
        else -> this
    }

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
    /** 打开就落在同步页：打开 App 会自动同步一次，结果显示在这一页。 */
    var screen by mutableStateOf(Screen.Sync)

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
    fun showMonth(month: YearMonth)
    fun selectDate(date: LocalDate)
    fun requestPermissions()
    fun pickReport()
    fun uploadReport()
    fun saveToken(token: String): Boolean
    fun navigate(screen: Screen)
}
