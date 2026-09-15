# 身迹同步（Kinetrail Health Connect 客户端）

读取手机上 FitDays+ 写入 Health Connect 的体测，推送到 Kinetrail 的 `POST /ingest/health-connect`；也能识别 FitDays+ 的人体成分分析报告图片，把 HC 里没有的读数挂到同一次称重上。设计、实测与服务端规则见 [`research/HEALTHCONNECT.md`](../research/HEALTHCONNECT.md)（报告见第 6 节），令牌与运维见 [`docs/operations.md`](../docs/operations.md) 第 9 节。

当前版本 0.3.0：Compose 界面与启动图标；打开 App 时自动同步一次（需已保存令牌且 7 项读取权限齐全），另有“立即同步”；识图报告。没有后台任务。

## 同步

- FitDays+ 只把测量页出现动画的称重写入 HC；秤端缓存、补传的称重读不到。
- 只读 FitDays+（`cn.icomon.fitdayspro`）写入的体重、体脂、水分质量、骨量、基础代谢、去脂体重、心率。
- 首次同步：先取 changes token，再读最近 30 天（HC 对其他 App 数据的默认历史上限），按时刻分组推送。
- 之后：按 token 取变更，对每个变更时刻重读整组再推送；HC 里的删除只推送记录 id。
- 所有请求返回 200 才保存新 token；401、413、415、429、503 等失败时 token 不前进，下次重来，服务端按内容去重。服务端报 `HC_GROUP_CONFLICT` 时也不前进，并提示轮换令牌。
- token 过期时退回首次流程，这时拿不到过期期间在 HC 里做的删除，App 会提示去 Kinetrail 核对。
- 按序列化后的字节分块（≤ 48 KiB），重读变更时刻时窗口前后各放宽 1 毫秒再精确筛选。
- 推送令牌用 Android Keystore 中不可导出的 AES-GCM 密钥加密后存放；只走 HTTPS；不打印令牌或体测数值。最近一次同步的时间和结果存在 SharedPreferences，首页显示。

## 识图报告

- 入口：FitDays+ 报告页点分享选“身迹同步”，或首页“识别报告图片”（系统相册选择器，不申请存储权限）。
- 识别：ML Kit 中文文字识别，模型打包在 APK 里，离线运行，图片不上传。`report/ReportParser.kt` 按分区标题和同一行右侧的数字取值，容忍实测到的形近字与符号读错。
- 核对页列出全部读数；有字段没认出或报告内交叉校验不过（成分 kg 与百分比、去脂体重、体重控制、BMI、阻抗随频率下降等）时不给上传，只能重新选图。
- 上传：先同步一次 HC，再发 `reports[]`（只有数字，格式与 `tests/fixtures/android-report.json` 一致，单测逐字比对）。服务端只把报告挂到同一分钟、体重相同的那次已入库称重上，挂上后不可改；找不到、有歧义、体脂率对不上时不写入并给出原因。
- 调试版会把最近一次识别的文本行写到应用私有目录 `files/last-ocr.json`，用于对照真实报告调解析规则：`adb shell run-as click.erikaalk.kinetrail.hc cat files/last-ocr.json`。发布版不写。

## 界面

沿用 `~\.claude\design-references\android-reference.md` 已确认的 Android 基础（顶栏收起、材质、分组节奏、行与箭头），设计系统代码在 `designsystem/`，从 `lab/android-design-sample` 复制后按本 App 裁剪。色板为品牌方向「孔雀蓝」，由 `palette.py` 生成后按文字承载面集合收敛，`KtContrastTest` 钉住对比度；启动图标是 `assets/icon.svg` 的自适应图标版本。

## 构建

工具链与本机其他 Android 项目一致：Gradle 8.14 / AGP 8.12.1 / Kotlin 2.2.20（含 Compose 编译插件），JDK 用 Android Studio 自带的 JBR 21。haze 固定 1.6.10（1.7+ 需要 Kotlin 2.3）。`local.properties` 不入库，内容为 `sdk.dir=<Android SDK 路径>`。

在 Claude Code 里直接运行 `gradlew` 会报 `Unable to establish loopback connection`，需要用 WMI 把 `gw.bat` 拉出进程树并隐藏窗口，再轮询日志里的 `KT_BUILD_EXIT=`：

```powershell
$log = "$env:TEMP\hc-build.log"
$cmd = 'cmd /c ""<仓库>\android\gw.bat" :app:testDebugUnitTest :app:assembleDebug > "' + $log + '" 2>&1"'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = [CimInstance]$startup }
```

在普通终端里可以直接运行 `android\gw.bat :app:testDebugUnitTest :app:assembleDebug`。

APK 只打 arm64-v8a（手机）和 x86_64（模拟器验证识图）两种 ABI；ML Kit 识别库每种约 11 MB，调试版 APK 约 60 MB。

`tools/report-replica.py` 按报告版式画一张近似图（Pillow + Noto Serif SC），真实报告图片不方便入库时，用它在模拟器上验证识图流程。它不是 FitDays+ 原图，真实图片的识别结果仍要在真机上核对。

## 安装

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

手机要直插电脑（不要经过 USB 集线器），ColorOS 会在手机上弹安装确认。首次安装后按 `docs/operations.md` 第 9 节生成并保存令牌；从 0.2.0 覆盖安装会保留令牌和同步进度。
