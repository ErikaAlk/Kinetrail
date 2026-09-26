# 身迹（Kinetrail Health Connect 客户端）

读取手机上 FitDays+ 写入 Health Connect 的体测，推送到 Kinetrail 的 `POST /ingest/health-connect`；也能识别 FitDays+ 的人体成分分析报告图片，把 HC 里没有的读数挂到同一次称重上；还有一个从服务端读数据的训练日历。设计、实测与服务端规则见 [`research/HEALTHCONNECT.md`](../research/HEALTHCONNECT.md)（报告见第 6 节），日历的服务端规则见 [`DATA_CONTRACT.md`](../DATA_CONTRACT.md) 第 9 节，令牌与运维见 [`docs/operations.md`](../docs/operations.md) 第 9、10 节。

当前版本 0.9.0：界面按全局 DESIGN.md 用 ColorOS 17 设计库重做；底栏三个一级页面（记录 / 同步 / 设置）；打开 App 时自动同步一次（需已保存令牌且 7 项读取权限齐全），另有“立即同步”；识图报告；训练日历（每次切到记录页、在记录页回到前台都静默重读当月）；记录页点开称重卡片可以永久删除这次称重（Health Connect 与体脂秤网关来的，旧 FitDays 记录不能删；规则见 `DATA_CONTRACT.md` 第 11 节）；设置里可选默认首页和体测报告版式。没有后台任务。

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
- 识别：ML Kit 中文文字识别，模型打包在 APK 里，离线运行，图片不上传。`report/ReportParser.kt` 按分区标题和同一行右侧的数字取值，标签比较先把 ML Kit 分不清的字按组归一（含读成繁体的：龄/齡、级/級），再容忍一处读错或多认/少认一个字，数字按报告的固定小数位还原读丢的小数点；两份真实识别结果（模拟器近似图、真机原图）在 `app/src/test/resources/` 下当回归夹具。
- 核对页列出全部读数，顶栏的图片按钮随时重新选图。必需的只有检测时间和体重（服务端靠这两项挂到那次称重上），缺了整张拦下；其余指标没认出的值显示「未识别」，可以只上传认出的部分——上传的 JSON 里没有这几项，报告挂上之后补不回来，所以按钮写明缺几项，点了先弹确认框列出缺的项。
- 报告内交叉校验不过（成分 kg 与百分比、去脂体重、体重控制、BMI、阻抗随频率下降等）说明数字读错了，页顶逐条列出哪里对不上，一律不给上传，只能重新选图。读不到和读错是两回事：只有读错才拦。
- 上传：先同步一次 HC，再发 `reports[]`（只有数字，格式与 `tests/fixtures/android-report.json` 一致，单测逐字比对）。服务端只把报告挂到同一分钟、体重相同的那次已入库称重上，挂上后不可改；找不到、有歧义、体脂率对不上时不写入并给出原因。
- 调试版会把最近一次识别的文本行写到应用私有目录 `files/last-ocr.json`，用于对照真实报告调解析规则：`adb shell run-as click.erikaalk.kinetrail.hc cat files/last-ocr.json`。发布版不写。

## 训练日历

- 入口：底栏“记录”。数据全部来自 `GET /app/calendar`（与推送同一个令牌），一次取一个月；与 Health Connect 无关，打开日历不会触发同步，也不需要额外权限。
- 日期数字下面是标记行：活动波形图标表示当天有训练，体重秤图标表示当天称过体重，两枚是同一家族的线条图标、灰色，选中时跟着反色，靠轮廓区分。标记行空着也占位，同一周的日期数字对齐。月历下的图例用的是同样两枚图标。今天是数字下面一道短线，选中是实色底，两者可以同时出现。
- 点日期看当天，再点一次收起。日期标题里写当天热量：「已记录消耗 500 千卡」是当天训练会话 `calories_kcal` 的合计——手表的消耗要由模型在结束训练时写进 Kinetrail（用户把手表截图给模型），没写就是「消耗未记录」。每次训练一张卡片：抬头是「训练」和时间段，下面一排「标签在上、数值在下」的时长、消耗、RPE（时长照 `duration_seconds` 显示，不用起止时间推算），再下面是场馆和动作名单。点卡片从底部弹出详情面板，每个动作一组逐组表格：组数、负重、次数、时长、距离，相邻几组负重和次数（含时长、距离）全一样时合成一行，只列这个动作里填过的字段，某组没填写「—」；单位照服务端给的写，不补默认单位。会话和动作的备注不显示（那是给模型看的上下文，服务端照常保存）。每次称重一张卡片，版式参照 FitDays+：左边大字体重，竖线右边竖排体脂率和 BMI；点卡片弹出的面板里是全部指标（含报告补的内脏脂肪、骨骼肌这些），按脂肪、肌肉与骨骼、水分与蛋白质、其他读数分组，一项一行、数值在行尾。有体脂、肌肉这类阻抗推算值时，面板里有一条 BIA 说明；只有体重、BMI、心率时没有。能删的称重，面板最下面是删除。系统字号放大后，表格改成逐组竖排，称重主区改成上下排。
- 每次切到记录页（含点已经选中的「记录」）、停在记录页时 App 回到前台，都会静默重读屏幕上这个月：已有数据照常显示、照常能点，不转圈，已选的日期、打开的详情面板和正在弹的删除确认都不动，取回来再整体替换；面板和删除确认跟着那次称重的 `record_id`，重读插进或去掉别的称重也不会换成另一条，那次称重没了面板就收起。已经在读或正在删除时不另发。顶栏的刷新按钮保留，点刷新、翻月时读取中换成转圈；这个月本机和服务端都还没有数据时，自动重读也转圈。取回的每个月原样存一份在应用缓存目录（`cache/calendar-YYYY-MM.json`；App 不开备份，系统空间紧张时可能被清掉），下次打开这个月先显示这份再去服务端取。
- 本机没有这个月的数据时，请求失败、服务端没部署日历接口的原因写在月历下面，带「重试」；没保存令牌时带「去设置」。本机有这个月的数据时照常显示，手动刷新失败只用底部提示条说一声（注明显示的是上次取回的记录），静默刷新失败不提示。删除失败也用底部提示条。本机和服务端都没有数据之前，选中的日期只显示标题，不会假装那天没有记录。服务端按上限截断时月历下面会明说只是一部分。
- 解析与格式化在 `calendar/CalendarData.kt`，单测 `CalendarDataTest` 读的是服务端测试逐字比对的 `tests/fixtures/calendar-response.json`，两边不会各自漂移。

## 界面

按全局 `~\.claude\DESIGN.md`（规范版本 `2026.09.24-coloros17`，记在 `ui/Page.kt` 的 `DESIGN_SYSTEM_REVISION`）实现，组件和参数全部来自设计库 `coloros-ui-kit`：顶栏、悬浮底栏、卡片列表、弹出菜单、面板、对话框、输入框、空状态、加载圈、提示条都是库里的，应用里只有页面组织和少量自绘（月历格子、图标）。主题色是孔雀蓝（启动图标的色相），按 COUI 的比例派生，每屏只点一处（月历里选中的日期、核对页的上传按钮）；对比度由 `ThemeColorContrastTest` 钉住。图标在 `ui/Icons.kt`，24 格线条图标、路径取自 Lucide（ISC），底栏选中换实心版。

一级导航是库的悬浮底栏：记录（训练日历）、同步（Health Connect 与报告识图）、设置（默认首页、体测报告版式、推送令牌、版本）。首页和子页面都用折叠大标题。设置里「默认首页」「体测报告」点开弹出菜单，选中即保存（SharedPreferences）；默认首页只能选记录或同步，默认同步，冷启动时落在这一页。推送令牌在面板里输入。核对报告是从同步页进去的子页面，不露底栏，返回键和顶栏返回都回到同步页。训练和称重的详情是从卡片弹出的面板，页面里不做原地展开（DESIGN §8）。

## 构建

App 连接的服务端地址不进仓库：在 `local.properties` 里写 `kinetrail.origin=https://<你的 Kinetrail 域名>`，构建时进 `BuildConfig.KINETRAIL_ORIGIN`（推送和日历共用），没写这行构建直接失败。完整部署流程见 [`docs/operations.md`](../docs/operations.md) 第 2 节。

设计库 `coloros-ui-kit` 经 `includeBuild` 进来，要和 Kinetrail 并排放在 `code/` 下（`settings.gradle.kts` 逐级往上找，worktree 里也能构建）。工具链跟设计库同一代：Gradle 9.7.1 / AGP 9.4.1（内置 Kotlin）/ Kotlin 2.4.20 / Compose BOM 2026.09.00，compileSdk 37；升级跟着设计库一起升。JDK 用 Android Studio 自带的 JBR 21。`local.properties` 不入库，内容为 `sdk.dir=<Android SDK 路径>` 和 `kinetrail.origin=<服务端地址>` 两行。

构建和单测：

```powershell
android\gw.bat :app:testDebugUnitTest :app:assembleDebug
```

`gw.bat` 设好了 `JAVA_HOME` 和 `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\Windows\Temp`；后者在 Claude Code 的进程树里是必需的，否则报 `Unable to establish loopback connection`。

APK 只打 arm64-v8a（手机）和 x86_64（模拟器验证识图）两种 ABI；ML Kit 识别库每种约 11 MB，调试版 APK 约 60 MB。

`tools/report-replica.py` 按报告版式画一张近似图（Pillow + Noto Serif SC），真实报告图片不方便入库时，用它在模拟器上验证识图流程。它不是 FitDays+ 原图，真实图片的识别结果仍要在真机上核对。

## 安装

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

日历需要服务端先应用 `0002_session_calories.sql` 并部署新版 Worker，否则页面会提示接口不存在。

手机要直插电脑（不要经过 USB 集线器），ColorOS 会在手机上弹安装确认。首次安装后按 `docs/operations.md` 第 9 节生成并保存令牌；从 0.2.0 覆盖安装会保留令牌和同步进度。
