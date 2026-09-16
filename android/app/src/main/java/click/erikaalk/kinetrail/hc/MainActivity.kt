// 打开即同步：有令牌、权限齐全时 onStart 自动推送一次；V1 没有后台任务（research/HEALTHCONNECT.md 2.3）。
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
import click.erikaalk.kinetrail.hc.calendar.fetchCalendar
import click.erikaalk.kinetrail.hc.report.recognizeReport
import click.erikaalk.kinetrail.hc.report.toIngestJson
import click.erikaalk.kinetrail.hc.ui.AppActions
import click.erikaalk.kinetrail.hc.ui.AppState
import click.erikaalk.kinetrail.hc.ui.KinetrailApp
import click.erikaalk.kinetrail.hc.ui.ReportState
import click.erikaalk.kinetrail.hc.ui.Screen
import click.erikaalk.kinetrail.hc.ui.UploadState
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
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
        setContent { KinetrailApp(state, this) }
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
    }

    private fun handleShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(::openReport)
    }

    private fun client(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(this) else null

    override fun navigate(screen: Screen) {
        state.screen = screen
        // 记录页：当月数据还没取到（首次进入、上次失败、或换过月份）才发请求；已经取到就保留上次选中的日期。
        if (screen == Screen.Records && state.calendarLoadedMonth != state.month) showMonth(state.month)
    }

    override fun requestPermissions() = requestPermissions.launch(permissions)

    override fun pickReport() = pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))

    override fun saveToken(token: String): Boolean {
        if (token.length < 32) return false
        TokenStore.save(prefs, token)
        state.tokenSaved = true
        state.screen = Screen.Settings
        if (state.grantedPermissions == permissions.size) sync() else if (state.grantedPermissions != null) requestPermissions()
        return true
    }

    override fun sync() {
        if (running?.isActive == true) return
        running = lifecycleScope.launch { runSync() }
    }

    override fun showMonth(month: YearMonth) {
        state.month = month
        // 只有当月默认选中今天；翻到别的月份先不选，等用户点。
        state.selectedDate = LocalDate.now().takeIf { YearMonth.from(it) == month }
        loadCalendar(month)
    }

    override fun selectDate(date: LocalDate) {
        state.selectedDate = if (state.selectedDate == date) null else date
    }

    /** 只读服务端日历。晚回来的旧请求不覆盖新结果（同 [openReport] 的做法）。 */
    private fun loadCalendar(month: YearMonth) {
        val attempt = ++calendarAttempt
        val token = TokenStore.load(prefs)
        state.calendarDays = emptyMap()
        state.calendarTruncated = false
        state.calendarLoadedMonth = null
        if (token == null) {
            state.calendarLoading = false
            state.calendarError = "保存推送令牌后才能读取日历。"
            return
        }
        state.calendarLoading = true
        state.calendarError = null
        lifecycleScope.launch {
            val result = runCatching { fetchCalendar(token, month) }
            if (attempt != calendarAttempt) return@launch
            state.calendarLoading = false
            result
                .onSuccess {
                    state.calendarDays = it.days
                    state.calendarTruncated = it.truncated
                    state.calendarLoadedMonth = month
                }
                .onFailure {
                    state.calendarError =
                        if (it is PushException) it.message else "读取失败：${it.javaClass.simpleName}"
                }
        }
    }

    /** 协程里的异常必须接住，否则界面停在“同步中”且没有提示。结果写进 prefs，下次打开还能看到。 */
    private suspend fun runSync() {
        val token = TokenStore.load(prefs) ?: return
        val client = client() ?: return
        if (!client.permissionController.getGrantedPermissions().containsAll(permissions)) return
        state.syncing = true
        val (ok, message) = try {
            true to HealthSync(client, prefs, token).run()
        } catch (e: PushException) {
            false to e.message.orEmpty()
        } catch (e: Exception) {
            false to "同步失败：${e.javaClass.simpleName}"
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
                ReportState.Parsed(recognizeReport(this@MainActivity, uri))
            } catch (e: Exception) {
                ReportState.Failed("图片读不出来（${e.javaClass.simpleName}）")
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
            } catch (e: PushException) {
                UploadState.Done(false, e.message.orEmpty())
            } catch (e: Exception) {
                UploadState.Done(false, "上传失败：${e.javaClass.simpleName}")
            }
        }
    }

    private companion object {
        const val LAST_AT = "last_sync_at"
        const val LAST_MESSAGE = "last_sync_message"
        const val LAST_OK = "last_sync_ok"
    }
}
