// 打开即同步：有令牌、权限齐全时 onStart 自动推送一次；V1 没有后台任务（research/HEALTHCONNECT.md 2.3）。
// 记录页：每次切过来、在记录页回到前台都静默重读当前月份（refreshRecords）。
// 报告识图：相册选图或从 FitDays+ 分享进来 → 本机 OCR → 核对页 → 先同步再上传（报告只能挂到已入库的称重上）。

package click.erikaalk.kinetrail.hc

import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.IntentCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.lifecycle.lifecycleScope
import click.erikaalk.kinetrail.hc.calendar.CalendarRange
import click.erikaalk.kinetrail.hc.calendar.fetchCalendar
import click.erikaalk.kinetrail.hc.calendar.parseCalendar
import click.erikaalk.kinetrail.hc.calendar.postDeleteMeasurement
import click.erikaalk.kinetrail.hc.report.ReportFormat
import click.erikaalk.kinetrail.hc.report.recognizeReport
import click.erikaalk.kinetrail.hc.report.toIngestJson
import click.erikaalk.kinetrail.hc.ui.AppActions
import click.erikaalk.kinetrail.hc.ui.AppState
import click.erikaalk.kinetrail.hc.ui.KinetrailApp
import click.erikaalk.kinetrail.hc.ui.ReportState
import click.erikaalk.kinetrail.hc.ui.Screen
import click.erikaalk.kinetrail.hc.ui.UploadState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId

class MainActivity : ComponentActivity(), AppActions {
    private val permissions = TYPES.map { HealthPermission.getReadPermission(it) }.toSet()
    private val prefs by lazy { getSharedPreferences("sync", MODE_PRIVATE) }
    private val state = AppState()
    private var running: Job? = null
    private var reportAttempt = 0
    private var calendarAttempt = 0
    private var calendarJob: Job? = null

    private val requestPermissions =
        registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            state.grantedPermissions = granted.intersect(permissions).size
            if (granted.containsAll(permissions)) sync()
        }

    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) openReport(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        state.totalPermissions = permissions.size
        state.lastSyncAt = prefs.getLong(LAST_AT, 0L).takeIf { it > 0 }
        state.lastSyncMessage = prefs.getString(LAST_MESSAGE, null)
        state.lastSyncOk = prefs.getBoolean(LAST_OK, true)
        // 存的是枚举名；改名或读不出来就退回默认，不报错
        state.homeScreen = Screen.entries.firstOrNull { it.name == prefs.getString(HOME_SCREEN, null) } ?: Screen.Sync
        state.reportFormat = ReportFormat.entries.firstOrNull { it.name == prefs.getString(REPORT_FORMAT, null) } ?: ReportFormat.FitDaysPlus
        setContent { KinetrailApp(state, this) }
        // 走 navigate 而不是直接赋值：首页是记录时要顺带读日历
        navigate(state.homeScreen)
        if (savedInstanceState == null) handleShare(intent)
    }

    // 声明了 uiMode 的 configChanges，切深浅色不重建 Activity；重新套一次，状态栏图标才会跟着换色。
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        enableEdgeToEdge()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    override fun onStart() {
        super.onStart()
        state.tokenSaved = TokenStore.load(prefs) != null
        lifecycleScope.launch {
            val client = client()
            state.grantedPermissions = client?.permissionController?.getGrantedPermissions()?.intersect(permissions)?.size
            // 自动同步不弹权限页：用户拒绝后回到前台会再次 onStart，弹窗会形成循环。
            if (state.tokenSaved && state.grantedPermissions == permissions.size) sync()
        }
        refreshRecords()
    }

    private fun handleShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(::openReport)
    }

    private fun client(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(this) else null

    override fun navigate(screen: Screen) {
        state.screen = screen
        refreshRecords()
    }

    /**
     * 切到记录页（含点底栏上已经选中的记录）、在记录页回到前台时，静默重读屏幕上这个月。
     * 选中的日期、展开的卡片、正在弹的删除确认都不动；已经在读或正在删除时不另发（删完自己会重读）。
     */
    private fun refreshRecords() {
        if (state.screen != Screen.Records || calendarJob?.isActive == true || state.deletingRecord != null) return
        loadCalendar(state.month, silent = true)
    }

    override fun setHomeScreen(screen: Screen) {
        state.homeScreen = screen
        prefs.edit().putString(HOME_SCREEN, screen.name).apply()
    }

    override fun setReportFormat(format: ReportFormat) {
        state.reportFormat = format
        prefs.edit().putString(REPORT_FORMAT, format.name).apply()
    }

    override fun requestPermissions() = requestPermissions.launch(permissions)

    override fun pickReport() = pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))

    override fun saveToken(token: String): Boolean {
        if (token.length < 32) return false
        TokenStore.save(prefs, token)
        state.tokenSaved = true
        if (state.grantedPermissions == permissions.size) sync() else if (state.grantedPermissions != null) requestPermissions()
        return true
    }

    override fun sync() {
        if (running?.isActive == true) return
        running = lifecycleScope.launch { runSync() }
    }

    override fun showMonth(month: YearMonth) {
        // 换月份时只有当月默认选中今天，别的月份先不选、等用户点；同一个月重读（重试）保留已选的日期。
        if (month != state.month || state.selectedDate == null) {
            state.selectedDate = LocalDate.now().takeIf { YearMonth.from(it) == month }
        }
        state.month = month
        loadCalendar(month)
    }

    override fun selectDate(date: LocalDate) {
        state.selectedDate = if (state.selectedDate == date) null else date
    }

    /**
     * 物理删除一次称重（界面已经确认过），删完重读当前月份；失败的原因写在那次称重的详情面板里。
     * 服务端删成功后先在本机去掉：屏幕上的这条立刻消失，那个月的本机缓存也作废，
     * 后面的重读失败或离线重启都不会再把删掉的称重显示出来。
     */
    override fun deleteMeasurement(recordId: String) {
        val token = TokenStore.load(prefs) ?: return
        if (state.deletingRecord != null) return
        val month = state.month
        state.deletingRecord = recordId
        state.deleteFailure = null
        lifecycleScope.launch {
            val result = runCatching { postDeleteMeasurement(token, recordId) }
            state.deletingRecord = null
            result
                .onSuccess {
                    withContext(Dispatchers.IO) { calendarFile(month).delete() }
                    if (state.calendarLoadedMonth == month) {
                        state.calendarDays = state.calendarDays.mapValues { (_, day) ->
                            day.copy(measurements = day.measurements.filterNot { it.recordId == recordId })
                        }
                    }
                }
                .onFailure { state.deleteFailure = recordId to it.userMessage("删除") }
            loadCalendar(state.month)
        }
    }

    /**
     * 只读服务端日历。屏幕上已经是这个月时，刷新期间照常显示，取回来再整体替换；
     * 换到别的月份（含冷启动）先摆出上次存在本机的那份。失败时本机那份留着。
     * 晚回来的旧请求不覆盖新结果（同 [openReport] 的做法）。
     *
     * [silent]：屏幕上有这个月的数据（含刚摆出的本机那份）时不转圈、不先收起错误提示，
     * 页面不跳动，结果回来再一起换；什么都没有时和手动刷新一样显示读取中。
     */
    private fun loadCalendar(month: YearMonth, silent: Boolean = false) {
        val attempt = ++calendarAttempt
        val token = TokenStore.load(prefs)
        if (!silent || token == null) {
            state.calendarLoading = token != null
            state.calendarError = if (token == null) "保存推送令牌后才能读取日历" else null
        }
        calendarJob = lifecycleScope.launch {
            if (state.calendarLoadedMonth != month) {
                val cached = withContext(Dispatchers.IO) {
                    runCatching { parseCalendar(calendarFile(month).readText()) }.getOrNull()
                }
                if (attempt != calendarAttempt) return@launch
                showCalendar(month, cached)
            }
            if (token == null) return@launch
            if (silent && state.calendarLoadedMonth != month) {
                state.calendarLoading = true
                state.calendarError = null
            }
            val result = runCatching { fetchCalendar(token, month) }
            if (attempt != calendarAttempt) return@launch
            state.calendarLoading = false
            result
                .onSuccess { (json, range) ->
                    state.calendarError = null
                    showCalendar(month, range)
                    // 先写临时文件再改名，写到一半被杀也不会留下半份
                    withContext(Dispatchers.IO) {
                        runCatching {
                            File(cacheDir, "calendar-$month.json.tmp").apply { writeText(json) }.renameTo(calendarFile(month))
                        }
                    }
                }
                .onFailure {
                    // 屏幕上已有这个月的数据时照常显示：静默刷新失败不打扰（离线时照常看上次的），
                    // 手动刷新失败用 Snackbar 说一声，不占页面位置、不把卡片往下推
                    val message = it.userMessage("读取")
                    when {
                        state.calendarLoadedMonth != month -> state.calendarError = message
                        !silent -> toast("$message，显示的是上次取回的记录")
                    }
                }
        }
    }

    /** [range] 为 null 表示这个月本机和服务端都还没有可用数据。 */
    private fun showCalendar(month: YearMonth, range: CalendarRange?) {
        state.calendarDays = range?.days.orEmpty()
        state.calendarTruncated = range?.truncated == true
        state.calendarLoadedMonth = month.takeIf { range != null }
    }

    /** 每个月一份服务端原文。放应用缓存目录：App 不开备份，系统空间紧张时可以清掉，清了只是下次先空着。 */
    private fun calendarFile(month: YearMonth) = File(cacheDir, "calendar-$month.json")

    /** 协程里的异常必须接住，否则界面停在“同步中”且没有提示。结果写进 prefs，下次打开还能看到。 */
    private suspend fun runSync() {
        val token = TokenStore.load(prefs) ?: return
        val client = client() ?: return
        if (!client.permissionController.getGrantedPermissions().containsAll(permissions)) return
        state.syncing = true
        val (ok, message) = try {
            true to HealthSync(client, prefs, token).run()
        } catch (e: Exception) {
            false to e.userMessage("同步")
        }
        state.syncing = false
        state.lastSyncOk = ok
        state.lastSyncMessage = message
        state.lastSyncAt = System.currentTimeMillis()
        prefs.edit().putLong(LAST_AT, state.lastSyncAt!!).putString(LAST_MESSAGE, message).putBoolean(LAST_OK, ok).apply()
    }

    private fun openReport(uri: Uri) {
        state.report = ReportState.Recognizing
        state.upload = UploadState.Idle
        state.screen = Screen.Report
        // 识别中又选了另一张图时，只认最后一次的结果
        val attempt = ++reportAttempt
        lifecycleScope.launch {
            val result = try {
                ReportState.Parsed(recognizeReport(this@MainActivity, uri, state.reportFormat))
            } catch (e: Exception) {
                ReportState.Failed("图片打不开或已损坏（${e.javaClass.simpleName}），换一张再试")
            }
            if (attempt == reportAttempt) state.report = result
        }
    }

    override fun uploadReport() {
        val report = (state.report as? ReportState.Parsed)?.result?.takeIf { it.uploadable }?.report ?: return
        val token = TokenStore.load(prefs) ?: return
        if (state.upload == UploadState.Uploading) return
        state.upload = UploadState.Uploading
        lifecycleScope.launch {
            // 先把 Health Connect 里的称重推上去，报告才有地方挂。
            running?.join()
            runSync()
            val minute = report.measuredAt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            state.upload = try {
                postReport(token, report.toIngestJson(minute)).let { UploadState.Done(it.ok, it.message) }
            } catch (e: Exception) {
                UploadState.Done(false, e.userMessage("上传"))
            }
        }
    }

    private fun toast(text: String) {
        lifecycleScope.launch { state.snackbar.show(text) }
    }

    /** 给人看的失败原因（DESIGN §14：说发生了什么、怎么补救）。服务端给的原因本来就是中文，原样用。 */
    private fun Throwable.userMessage(action: String): String = when (this) {
        is PushException -> message.orEmpty()
        is SocketTimeoutException -> "连接 Kinetrail 超时，请稍后重试"
        is IOException -> "无法连接 Kinetrail，请检查网络"
        else -> "${action}失败（${javaClass.simpleName}）"
    }

    private companion object {
        const val LAST_AT = "last_sync_at"
        const val LAST_MESSAGE = "last_sync_message"
        const val LAST_OK = "last_sync_ok"
        const val HOME_SCREEN = "home_screen"
        const val REPORT_FORMAT = "report_format"
    }
}
