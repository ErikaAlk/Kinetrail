# 适配小米体脂秤 S800

写给要给身迹加上小米体脂秤 S800 支持的人。

## 现状

- 设置页「体测报告」里已经有「小米体脂秤 S800」这一项，副标题「还没有适配」。选中后，识别报告图片照常跑 OCR，但结果只有一句「还没有适配小米体脂秤 S800 的报告。」，不给上传。同步页的组说明也会换成未适配的提示。
- 这个选项目前只决定识图交给哪个解析器。Health Connect 同步仍然只读 FitDays+ 写入的数据，服务端也只收 FitDays+ 这个来源。
- 仓库里没有任何针对 S800 的实测。下面凡是涉及 S800 或它的配套 App 的地方，都是要去核实的问题，不是结论。

## 开始前

1. **用你自己的 Kinetrail 部署和令牌。** Kinetrail 只存一个人的数据（`CLAUDE.md`「只存本人」），不要把你的称重推到别人的实例里。部署按 `docs/operations.md` 第 2 节，推送令牌按第 9 节。手机端连哪个服务端写在 `android/local.properties` 的 `kinetrail.origin`；服务端配置在你自己的 `wrangler.local.jsonc` 里填。
2. 读 `CLAUDE.md` 的不变量，尤其是 Health Connect 推送和识图报告两条。
3. 读 `research/HEALTHCONNECT.md` 第 1、3、5、6 节：FitDays+ 就是这样一步步核实、适配的，S800 照同样的路走。规范摘要在 `DATA_CONTRACT.md` 第 8 节。

适配分两件事，**顺序不能反**：先让 S800 的称重进 Kinetrail，再做报告识图。报告只能挂到已经入库的那次称重上，称重进不来，报告无处可挂。

## 一、称重进 Kinetrail（Health Connect）

### 先核实

照 `research/HEALTHCONNECT.md` 第 5 节的四道关卡，在装了 S800 配套 App 的手机上逐项确认，并把结果记下来：

| 问题 | 怎么查 | 为什么要知道 |
| --- | --- | --- |
| S800 的数据由哪个 App 记录，它会不会写 Health Connect，包名是什么 | `adb shell dumpsys package <包名>`，看有没有声明 `android.permission.health.WRITE_*`；App 设置里找 Health Connect 开关 | 不写 HC，这条路就走不通，后面的都不用做 |
| 称一次后写了哪些类型 | 系统设置 → Health Connect → 数据和访问，看条目和来源 | App 读 7 种类型（`HealthSync.kt` 的 `TYPES`），服务端只收这 7 种（`src/ingest.ts` 的 `RANGES`） |
| 同一次称重的几条记录是不是同一个时刻 | 用读取结果对比各条的 `time` | 服务端按「同一来源 + 同一 `time_ms`」认定是一次称重。时刻对不上就不能照搬，**不能改成按时间相近合并** |
| 只写账户主人，还是家里所有成员都写 | 让另一位成员称一次再看 HC | 手机端分不出是谁，多人都写进 HC 就不能直接推 |
| 在 App 里修改、删除记录，或秤端缓存补传时，HC 会不会跟着变 | 改一条、删一条、断网称一次再联网 | 决定删除和去重规则是否成立 |

### 再改代码

- **手机端**：`HealthSync.kt` 里的 `FITDAYS_PLUS` 和 `origin` 固定是 FitDays+ 的包名。让同步来源跟着设置里的选项走（或者另加一个选项），同一台手机不要同时读两个来源。
- **服务端**：`src/ingest.ts` 的 `HC_ORIGIN` 是常量，请求 schema 里 `origin` 用 `const` 限定为它，入库的 `source_record_id` 是 `hc:<来源包名>:<time_ms>`。改成 S800 配套 App 的包名，或者改成允许列表。同一个实例里两个来源不要同时导入同一时段（`DATA_CONTRACT.md` 第 8 节「截断与去重」）。
- 如果 S800 写的类型不在那 7 种里，手机端 `TYPES`、服务端 `RANGES` 和第 8 节的索引说明要一起改。
- 补 `tests/ingest.test.ts`，更新 `DATA_CONTRACT.md` 第 8 节和 `research/` 里的实测记录。

## 二、报告识图

### 现有流程

1. 入口：同步页「识别报告图片」（系统相册选择器），或者在别的 App 里把图片分享给身迹。两条路都进 `MainActivity.openReport`。
2. `report/ReportOcr.kt` 的 `recognizeReport`：ML Kit 中文文字识别（离线，模型在 APK 里），得到带坐标的文本行 `OcrLine`，再按 `ReportFormat` 交给解析器。S800 的分支现在直接返回未适配。
3. `ui/ReportScreen.kt` 是核对页；`MainActivity.uploadReport` 先同步一次 HC，再把 `toIngestJson` 的结果发给服务端。

### 步骤

1. **拿到真实报告图片。** 先确认 S800 的配套 App 有没有报告页、能不能分享或保存成图片。尽量用 App 分享出来的原图，截图的分辨率和状态栏会影响识别。
2. **导出识别结果。** 装调试版，设置里选「小米体脂秤 S800」，识别这张图。解析器还不存在，但 OCR 照常跑，调试版会把文本行写到应用私有目录：

   ```bash
   adb shell run-as click.erikaalk.kinetrail.hc cat files/last-ocr.json
   ```

   去掉姓名、手机号、账号 ID 这类身份信息，存到 `android/app/src/test/resources/` 当回归夹具。至少要有一份真机读法。
3. **写解析器。** 纯 Kotlin，不依赖 Android，输入文本行和图片宽度，方便单测直接喂夹具。参照 `ReportParser.kt` 的做法：
   - 按「分区标题 + 同一行右侧的数字」取值，不按绝对像素（分享出来的图可能被缩放）。
   - 标签比较先按 `CONFUSABLE` 把分不清的字归一，再容忍一处编辑距离。ML Kit 在中文报告上的常见读错记在 `CLAUDE.md`「环境坑」。
   - 读丢的小数点按报告的固定小数位还原。位数要从真实报告确认，不能猜。
4. **交叉校验。** 找报告内部成立的算术关系，比如质量 = 百分比 × 体重、BMI = 体重 ÷ 身高²，读错一位数字就会被拦下来。每条关系先在真实报告上验证确实成立（FitDays+ 的「肥胖度 ≈ 体重 ÷ 目标体重」就不成立）。校验不过说明数字读错了，不许上传——报告挂上后服务端不允许修改。
5. **数据结构和核对页。** `BodyReport` 里只有检测时间和体重是必填，别的指标没认出就是 null、整项不发，核对页显示「未识别」并写明缺项。S800 的字段不一样：可以给它单独建数据类和核对页显示，也可以复用这套可选字段。上传的 JSON 只放报告上真实存在的字段。
6. **接上。** 在 `recognizeReport` 的 `ReportFormat.XiaomiS800` 分支调用新解析器；去掉设置页那一行的「还没有适配」（`SettingsScreen.kt`），把同步页的组说明（`SyncScreen.kt`）改成 S800 的分享方式。
7. **单测。** 用第 2 步的夹具跑解析，逐个字段断言。上传 JSON 做成共享夹具，做法同 `tests/fixtures/android-report.json`：Android 单测和服务端测试逐字比对同一个文件，两边不会各自漂移。

### 服务端对报告的要求

- **Schema**：`src/ingest.ts` 的 `REPORT_SCHEMA`。必填只有 `measured_minute_ms`（报告时间所在分钟的起点，毫秒）和 `weight_kg.value`，其余字段可选，但不允许多出未声明的字段。S800 报告有新指标时，先在 schema 里加字段，再决定要不要在 `REPORT_METRICS` 里进索引，同时更新 `DATA_CONTRACT.md` 第 8 节。已有字段按原来的语义填（`visceral_fat_level` 是等级，`body_fat_pct` 是百分比）；含义不同的指标另起字段名，不要借用。
- **匹配**：服务端在 `[分钟, 分钟 + 60 秒)` 里找体重相差不超过 0.01 kg 的已入库称重，恰好一个才挂；这组称重有体脂记录时，体脂率相差不能超过 0.05（`attachReport`）。因此要核实：
  - 报告上的时间是截断到分钟还是四舍五入，用的是哪个时区。FitDays+ 的「截断」是反编译确认的。如果是四舍五入，就在手机端算出正确的分钟，不要改服务端的匹配规则。
  - 报告上的体重和 HC 里那条体重是不是同一个数，小数位是否一致。
  - 报告上的体脂率和 HC 的体脂记录是否一致。
- **不要为了能挂上而放宽匹配**（比如按时间就近、忽略体重），也不要把图片传到服务端识别。这两条是 `CLAUDE.md` 的不变量。

## 验收

- `npm run check` 全绿；Android 跑 `:app:testDebugUnitTest :app:assembleDebug`（在 Claude Code 里构建要按 `android/README.md`「构建」一节绕开 loopback 问题）。
- 真机走一遍：S800 称一次 → 打开身迹同步 → 报告图片分享给身迹 → 核对页全部通过 → 上传成功 → 在日历或 MCP 里看到这次称重多出的指标。
- 更新 `android/README.md`，把实测的机型、App 版本、结论按 `research/HEALTHCONNECT.md` 第 5、6 节的格式记进 `research/`。
