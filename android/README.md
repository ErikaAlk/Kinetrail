# 身迹同步（Kinetrail Health Connect 客户端）

读取手机上 FitDays+ 写入 Health Connect 的体测，推送到 Kinetrail 的 `POST /ingest/health-connect`。设计、实测与服务端规则见 [`research/HEALTHCONNECT.md`](../research/HEALTHCONNECT.md)，令牌与运维见 [`docs/operations.md`](../docs/operations.md) 第 9 节。

当前版本 0.2.0：打开 App 时自动同步一次（需已保存令牌且 7 项读取权限齐全），另有“立即同步”。没有后台任务。

## 行为

- 只读 FitDays+（`cn.icomon.fitdayspro`）写入的体重、体脂、水分质量、骨量、基础代谢、去脂体重、心率。
- 首次同步：先取 changes token，再读最近 30 天（HC 对其他 App 数据的默认历史上限），按时刻分组推送。
- 之后：按 token 取变更，对每个变更时刻重读整组再推送；HC 里的删除只推送记录 id。
- 所有请求返回 200 才保存新 token；401、413、415、429、503 等失败时 token 不前进，下次重来，服务端按内容去重。服务端报 `HC_GROUP_CONFLICT` 时也不前进，并提示轮换令牌。
- token 过期时退回首次流程，这时拿不到过期期间在 HC 里做的删除，App 会提示去 Kinetrail 核对。
- 按序列化后的字节分块（≤ 48 KiB），重读变更时刻时窗口前后各放宽 1 毫秒再精确筛选。
- 推送令牌用 Android Keystore 中不可导出的 AES-GCM 密钥加密后存放；只走 HTTPS；不打印令牌或体测数值。

## 构建

工具链与本机其他 Android 项目一致：Gradle 8.14 / AGP 8.12.1 / Kotlin 2.2.20，JDK 用 Android Studio 自带的 JBR 21。`local.properties` 不入库，内容为 `sdk.dir=<Android SDK 路径>`。

在 Claude Code 里直接运行 `gradlew` 会报 `Unable to establish loopback connection`，需要用 WMI 把 `gw.bat` 拉出进程树并隐藏窗口，再轮询日志里的 `KT_BUILD_EXIT=`：

```powershell
$log = "$env:TEMP\hc-build.log"
$cmd = 'cmd /c ""<仓库>\android\gw.bat" :app:assembleDebug > "' + $log + '" 2>&1"'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = [CimInstance]$startup }
```

在普通终端里可以直接运行 `android\gw.bat :app:assembleDebug`。

## 安装

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

手机要直插电脑（不要经过 USB 集线器），ColorOS 会在手机上弹安装确认。安装后按 `docs/operations.md` 第 9 节生成并保存令牌。
