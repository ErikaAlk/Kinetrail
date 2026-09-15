// 打开即同步：有令牌、权限齐全时 onStart 自动推送一次；V1 没有后台任务（research/HEALTHCONNECT.md 2.3）。

package click.erikaalk.kinetrail.hc

import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.Base64
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.security.KeyStore
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : ComponentActivity() {
    private val permissions = TYPES.map { HealthPermission.getReadPermission(it) }.toSet()
    private val prefs by lazy { getSharedPreferences("sync", MODE_PRIVATE) }
    private lateinit var output: TextView
    private var running: Job? = null

    private val requestPermissions =
        registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            if (granted.containsAll(permissions)) sync() else show("读取权限不完整（${granted.intersect(permissions).size}/${permissions.size}）")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply { setTextIsSelectable(true) }
        val tokenInput = EditText(this).apply {
            hint = "推送令牌"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(
                TextView(this@MainActivity).apply {
                    text = "把 FitDays+ 写入 Health Connect 的体测推送到 Kinetrail。只读取 FitDays+ 的体重、体脂、水分、骨量、基础代谢、去脂体重和心率。"
                },
            )
            addView(tokenInput)
            addButton("保存令牌") {
                val token = tokenInput.text.toString().trim()
                tokenInput.text.clear()
                if (token.length < 32) return@addButton show("令牌太短，没有保存")
                TokenStore.save(prefs, token)
                show("令牌已保存")
                sync()
            }
            addButton("立即同步") { sync() }
            addView(output)
        }
        setContentView(ScrollView(this).apply { fitsSystemWindows = true; addView(column) })
    }

    override fun onStart() {
        super.onStart()
        if (TokenStore.load(prefs) != null) sync(requestIfMissing = false)
    }

    private fun LinearLayout.addButton(label: String, onClick: () -> Unit) =
        addView(Button(context).apply { text = label; setOnClickListener { onClick() } })

    private fun show(line: String) {
        output.append("\n${LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))} $line")
    }

    // 协程里的异常必须接住，否则整页按钮失效且没有提示。
    private fun launchSafely(label: String, block: suspend () -> Unit): Job = lifecycleScope.launch {
        try {
            block()
        } catch (e: PushException) {
            show(e.message.orEmpty())
        } catch (e: Exception) {
            show("$label 失败：${e.javaClass.simpleName}")
        }
    }

    private fun client(): HealthConnectClient? {
        val status = HealthConnectClient.getSdkStatus(this)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            show("Health Connect 不可用（sdkStatus=$status）")
            return null
        }
        return HealthConnectClient.getOrCreate(this)
    }

    /** 自动同步不弹权限页：用户拒绝后回到前台会再次 onStart，弹窗会形成循环。 */
    private fun sync(requestIfMissing: Boolean = true) {
        if (running?.isActive == true) return
        running = launchSafely("同步") {
            val token = TokenStore.load(prefs) ?: return@launchSafely show("请先保存推送令牌")
            val client = client() ?: return@launchSafely
            if (!client.permissionController.getGrantedPermissions().containsAll(permissions)) {
                if (requestIfMissing) requestPermissions.launch(permissions) else show("缺少读取权限，点“立即同步”授权")
                return@launchSafely
            }
            show("同步中…")
            show(HealthSync(client, prefs, token).run())
        }
    }
}

/** 推送令牌用 Android Keystore 里不可导出的 AES-GCM 密钥加密后存放。 */
private object TokenStore {
    private const val ALIAS = "kinetrail-ingest-token"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }

    fun save(prefs: android.content.SharedPreferences, token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.doFinal(token.toByteArray())
        prefs.edit()
            .putString("token_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("token_ct", Base64.encodeToString(sealed, Base64.NO_WRAP))
            .apply()
    }

    fun load(prefs: android.content.SharedPreferences): String? {
        val iv = prefs.getString("token_iv", null) ?: return null
        val sealed = prefs.getString("token_ct", null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            }
            String(cipher.doFinal(Base64.decode(sealed, Base64.NO_WRAP)))
        }.getOrNull()
    }
}
