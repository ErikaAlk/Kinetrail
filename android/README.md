# 身迹（Kinetrail Health Connect 客户端）

读取手机上 FitDays+ 写入 Health Connect 的体测，推送到 Kinetrail 的 `POST /ingest/health-connect`；也能识别 FitDays+ 的人体成分分析报告图片，把 HC 里没有的读数挂到同一次称重上；还有一个从服务端读数据的训练日历。设计、实测与服务端规则见 [`research/HEALTHCONNECT.md`](../research/HEALTHCONNECT.md)（报告见第 6 节），日历的服务端规则见 [`DATA_CONTRACT.md`](../DATA_CONTRACT.md) 第 9 节，令牌与运维见 [`docs/operations.md`](../docs/operations.md) 第 9、10 节。

当前版本 0.7.0：Compose 界面与启动图标；底栏三个一级页面（记录 / 同步 / 设置）；打开 App 时自动同步一次（需已保存令牌且 7 项读取权限齐全），另有“立即同步”；识图报告；训练日历；设置里可选默认首页和体测报告版式。没有后台任务。

## 同步

- FitDays+ 只把测量页出现动画的称重写入 HC；秤端缓存、补传的称重读不到。
- 只读 FitDays+（`cn.icomon.fitdayspro`）写入的体重、体脂、水分质量、骨量、基础代谢、去脂体重、心率。
- 首次同步：先取 changes token，再读最近 30 天（HC 对其他 App 数据的默认历史上限），按时刻分组推送。
- 之后：按 token 取变更，对每个变更时刻重读整组再推送；HC 里的删除只推送记录 id。
- 所有请求返回 200 才保存新 token；401、413、415、429、503 等失败时 token 不前进，下次重来，服务端按内容去重。服务端报 `HC_GROUP_CONFLICT` 时也不前进，并提示轮换令牌。
- token 过期时退回首次流程，这时拿不到过期期间在 HC 里做的删除，App 会提示去 Kinetrail 核对。
- 按序列化后的字节分块（≤ 48 KiB），重读变更时刻时窗口前后各放宽 1 毫秒再精确筛选。
- 推送令牌用 Android Keystore 中不可导出的 AES-GCM 密钥加密后存放；只走 HTTPS；不打印令牌或体测数值。最近一次同步的时间和结果存在 SharedPreferences，同步页显示。

## 识图报告

- 入口：FitDays+ 报告页点分享选“身迹”，或同步页“识别报告图片”（系统相册选择器，不申请存储权限）。
- 版式：设置页「体测报告」选 FitDays+ 或小米体脂秤 S800。S800 只是占位：识别照常跑（调试版照常导出文本行），结果只提示还没有适配，不给上传。怎么适配见 [`docs/xiaomi-s800.md`](../docs/xiaomi-s800.md)。
- 识别：ML Kit 中文文字识别，模型打包在 APK 里，离线运行，图片不上传。`report/ReportParser.kt` 按分区标题和同一行右侧的数字取值，标签比较容忍一处形近字或多认/少认一个字，数字按报告的固定小数位还原读丢的小数点；两份真实识别结果（模拟器近似图、真机原图）在 `app/src/test/resources/` 下当回归夹具。
- 核对页列出全部读数；有字段没认出或报告内交叉校验不过（成分 kg 与百分比、去脂体重、体重控制、BMI、阻抗随频率下降等）时不给上传，只能重新选图。
- 上传：先同步一次 HC，再发 `reports[]`（只有数字，格式与 `tests/fixtures/android-report.json` 一致，单测逐字比对）。服务端只把报告挂到同一分钟、体重相同的那次已入库称重上，挂上后不可改；找不到、有歧义、体脂率对不上时不写入并给出原因。
- 调试版会把最近一次识别的文本行写到应用私有目录 `files/last-ocr.json`，用于对照真实报告调解析规则：`adb shell run-as click.erikaalk.kinetrail.hc cat files/last-ocr.json`。发布版不写。

## 训练日历

- 入口：底栏“记录”。数据全部来自 `GET /app/calendar`（与推送同一个令牌），一次取一个月；与 Health Connect 无关，打开日历不会触发同步，也不需要额外权限。
- 日期数字下面是标记行：活动波形图标表示当天有训练，体重秤图标表示当天称过体重，两枚是同一家族的线条图标、灰色，选中时跟着反色，靠轮廓区分。标记行空着也占位，同一周的日期数字对齐。月历下的图例用的是同样两枚图标。今天是数字下面一道短线，选中是实色底，两者可以同时出现。
- 点日期看当天，再点一次收起。有训练的日子，日期标题下写当天热量：「已记录消耗 500 千卡」是当天训练会话 `calories_kcal` 的合计——手表的消耗要由模型在结束训练时写进 Kinetrail（用户把手表截图给模型），没写就是「消耗未记录」。每次训练一张卡片：抬头是「训练」和时间段，下面一排「标签在上、数值在下」的时长、消耗、RPE（时长照 `duration_seconds` 显示，不用起止时间推算），再下面是场馆。动作默认收起，只列动作名，点卡底「展开动作」后每个动作一张逐组表格：组数、负重、次数、时长、距离，相邻几组负重和次数（含时长、距离）全一样时合成一行，只列这个动作里填过的字段，某组没填写「—」；单位照服务端给的写，不补默认单位。会话和动作的备注不显示（那是给模型看的上下文，服务端照常保存）。每次称重一张卡片，版式参照 FitDays+：左边大字体重，竖线右边竖排体脂率和 BMI；其余指标（含报告补的内脏脂肪、骨骼肌这些）点卡底的「展开指标」后按脂肪、肌肉与骨骼、水分与蛋白质、其他读数分组，一项一行、数值靠右。有体脂、肌肉这类阻抗推算值时，卡内有一条 BIA 说明；只有体重、BMI、心率时没有。系统字号放大后，表格改成逐组竖排，称重主区改成上下排。
- 月份标题右边是刷新按钮，读取中换成转圈。冷启动后第一次进记录页、翻月、点刷新会请求服务端；切到别的 tab 再回来不会重读。取回的每个月原样存一份在应用缓存目录（`cache/calendar-YYYY-MM.json`；App 不开备份，系统空间紧张时可能被清掉），下次打开这个月先显示这份，刷新期间照常显示，取回来再整体替换。
- 请求失败、没保存令牌、服务端没部署日历接口都会在页面上说明原因，失败时可以重试；本机有这个月的数据时照常显示，并说明那是上次取回的记录。本机和服务端都没有数据之前，选中的日期只显示标题，不会假装那天没有记录。服务端按上限截断时页面会明说只是一部分。
- 解析与格式化在 `calendar/CalendarData.kt`，单测 `CalendarDataTest` 读的是服务端测试逐字比对的 `tests/fixtures/calendar-response.json`，两边不会各自漂移。

## 界面

沿用 `~\.claude\design-references\android-reference.md` 已确认的 Android 基础（顶栏收起、材质、分组节奏、行与箭头），设计系统代码在 `designsystem/`，从 `lab/android-design-sample` 复制后按本 App 裁剪。色板为品牌方向「孔雀蓝」，由 `palette.py` 生成后按文字承载面集合收敛，`KtContrastTest` 钉住对比度；卡片不画描边，靠底色和画布分层（浅 1.11:1、深 1.25:1，调整记录见 `KtPalette` 注释）；启动图标是 `assets/icon.svg` 的自适应图标版本。

一级导航是全局 4.6 的悬浮 Tab Bar：记录（训练日历）、同步（Health Connect 与报告识图）、设置（默认首页、体测报告版式、令牌与版本）。设置里「默认首页」「体测报告」点一下在原地展开选项，选中即保存（SharedPreferences）并收起；默认首页只能选记录或同步，默认同步，冷启动时落在这一页。核对报告和推送令牌是从所属 tab 进去的子页面，返回键和顶栏返回都回到那个 tab，底栏仍高亮它。底栏材质的厚度是登记在案的覆盖：日历选中的日期格和详情页主按钮是 `accent.primary` 填充，会滚到条底下，全局默认的 0.48 那一档标签只有 2.6:1，两套都收到 0.86（理由与实测值见 `KtMaterial`，`KtMaterialContrastTest` 钉住）。

## 构建

App 连接的服务端地址不进仓库：在 `local.properties` 里写 `kinetrail.origin=https://<你的 Kinetrail 域名>`，构建时进 `BuildConfig.KINETRAIL_ORIGIN`（推送和日历共用），没写这行构建直接失败。完整部署流程见 [`docs/operations.md`](../docs/operations.md) 第 2 节。

工具链与本机其他 Android 项目一致：Gradle 8.14 / AGP 8.12.1 / Kotlin 2.2.20（含 Compose 编译插件），JDK 用 Android Studio 自带的 JBR 21。haze 固定 1.6.10（1.7+ 需要 Kotlin 2.3）。`local.properties` 不入库，内容为 `sdk.dir=<Android SDK 路径>` 和 `kinetrail.origin=<服务端地址>` 两行。

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

日历需要服务端先应用 `0002_session_calories.sql` 并部署新版 Worker，否则页面会提示接口不存在。

手机要直插电脑（不要经过 USB 集线器），ColorOS 会在手机上弹安装确认。首次安装后按 `docs/operations.md` 第 9 节生成并保存令牌；从 0.2.0 覆盖安装会保留令牌和同步进度。
