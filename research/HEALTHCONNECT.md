# 用 Health Connect 替代 FitDays+ 云端拉取：评估与设计（2026-09-15）

状态：**核实关卡 G-HC1–G-HC4 已完成（G-HC4 于当晚更正写入条件）；推送端点已部署（PR #10，版本 `bdbcd4f8`），手机 App 0.2.0 真机首次推送成功**。结论依据分三类标注：「静态分析」来自 FitDays+ 1.14.1 反编译代码；「官方文档」附链接；「未验证」必须在手机上核实后才能进入实现。

## 结论

1. **值得做，但先过手机端核实关卡（下文 G-HC1–G-HC4，约半小时，不需要写代码）。** Health Connect（下称 HC）路线不登录 FitDays+，彻底绕开顶号问题，而且 FitDays+ 写入 HC 的体成分字段比它云端保存的更多。关卡任一项失败，就退回 FitDays+ 适配器。
2. FitDays+ 只在**测量页出现动画的称重**（用户实测）、只为**账户主用户**写 HC；秤端缓存、补传的称重不写，这些称重不会进入 Kinetrail。每次写入时体重必写，体脂率、水分质量、骨量、基础代谢、去脂体重、心率在值大于 0 时写入。它不回填历史，也不会把 App 里的修改或删除同步到 HC（静态分析，见第 1 节）。
3. HC 功能只在渠道为 `FitdaysPro_Google` 的安装包里启用。**G-HC1 已通过（2026-09-15）**：手机上的 FitDays+ 从 Play 商店安装，渠道就是 `FitdaysPro_Google`，4 个 dex 与本文分析的完全一致，16 项 HC 读写权限都已授予；系统为 Android 16、SDK 扩展 17，带 HC 模块。
4. 设备端推荐自写一个极小的 Android App：**第一版只做“打开即同步”**，不做后台常驻。称重本来就要在手机上打开 FitDays+，事后多点一下，就不用和 ColorOS 的后台限制纠缠（OPPO 在 dontkillmyapp 上评 4/5，开发者侧无解）。后台定时同步作为第二步，另行实测。现成的开源 App 里 life-dashboard-companion-app 最接近需求，可作参考或备选，但不推荐直接装。
5. Worker 侧新增只写的 `POST /ingest/health-connect`，用独立的设备令牌鉴权，不走 OAuth/MCP；复用现有的暂存/发布/lease 链路。已存测量值不可变；在系统 HC 界面删除的记录会以 tombstone 新版本同步（FitDays+ 里的删除不会进 HC，见 G-HC4）。`refresh_data` 已下线。
6. 本次顺带发现 `wip/fitdaysplus-adapter` 的一个缺陷：FitDays+ 的 uid 算出的 `profile_ref`（`p_7bc8…`）与现有 157 条历史的 `p_914e…` 不同，发布后 `profiles` 表里会有两个成员，省略 `profile_ref` 的体测工具会全部返回 `PROFILE_REQUIRED`，趋势也会断成两段。无论选哪条路线，新来源都要映射到现有的本人 `profile_ref`。

## 1. FitDays+ 实际写入 HC 的内容（静态分析）

来源：上一轮从已 root 平板导出的 `cn.icomon.fitdayspro` 1.14.1（dex 与 jadx 1.5.6 输出，未入库）。关键位置：`cn.icomon.ui.utils.j0`（HC 封装）、`p0.i.r(ICAFWeight)`（调用点）。调用关系另用 `dexdump -d` 在字节码层核对，`j0.s(ICAFWeight)` 全包只有 `p0.i.r` 一个调用者。

### 触发条件

`p0.i` 处理 `ICAFNetworkWeightSaveRequest`（保存称重）时，对每条记录：

```java
if (iCAFWeight.getUid() == account.getMuid()) { r(iCAFWeight); ... }
```

`r()` 先写入其他渠道，再检查账户设置 `HealthConnect` 的 `cls_content == "1"`，满足才调用 `j0.s()`。`j0` 另有两道门：

- `Build.VERSION.SDK_INT >= 28` 且 `UMENG_CHANNEL_VALUE == "FitdaysPro_Google"`（`cn.icomon.ui.utils.d.a()`）。平板这份包的 manifest 字符串池里渠道值是 `FitdaysPro_Google`。
- `HealthConnectClient.getSdkStatus(ctx, "com.google.android.apps.healthdata")` 可用，并且权限检查通过（代码对 16 项读写权限做 `containsAll`，但该协程方法反编译不完整，是否必须全部授予不能确定）。

由此推出：

- **只写主用户（muid）**。FitDays+ 测试账号下有 2 个成员；其他成员的称重不会进 HC。用户已在手机上确认这一点（第 5 节 G-HC3）。
- **只写测量页发起保存的称重**（用户实测：必须出现测量动画），不回填云端历史；秤端缓存后由首页补传的称重走另一条不写 HC 的路径（`ICAFNetworkWeightNotSyncSaveRequest`）。手动录入体重也经测量类页面的保存请求，推断会写，未实测。
- **没有 `deleteRecords` / `updateRecords` 调用**。App 里改或删一条记录，HC 不会跟着变。

### 每次称重写入的记录

一次 `insertRecords` 调用，所有记录共用同一个 `Instant.ofEpochSecond(measure_time)` 和系统默认时区偏移，`metadata` 用默认值（没有 `clientRecordId`、`device`，记录 ID 由 HC 分配）：

| HC 类型 | 值 | 写入条件 | Kinetrail 现有索引 |
| --- | --- | --- | --- |
| `WeightRecord` | `weight_kg`（kg） | 总是 | `weight_kg` |
| `BodyFatRecord` | `pbf`（%） | pbf > 0 | `body_fat_pct` |
| `BodyWaterMassRecord` | 水分（kg） | > 0 | 现有 `body_water_pct` 是百分比，需要新指标或按体重换算 |
| `BoneMassRecord` | 骨量（kg） | > 0 | `bone_mass_kg` |
| `BasalMetabolicRateRecord` | BMR（kcal/day） | > 0 | `bmr_kcal` |
| `LeanBodyMassRecord` | 去脂体重（kg） | pbf > 0 且值 > 0 | 现有派生 `fat_free_mass_kg`，另存原值作核对 |
| `HeartRateRecord` | 单个样本，start=end | 1 ≤ hr ≤ 300 | `heart_rate_bpm` |

另有 `NutritionRecord`（厨房秤食物），与体测无关，设备端过滤掉。

**两个来源都拿不到的**：肌肉率、骨骼肌率、蛋白质、皮下脂肪、内脏脂肪、身体年龄、BMI（BMI 现由服务端按身高推算，见 3.4）。旧 FitDays 的 157 条历史里有这些字段，今后的新数据不会再有。HC 只多出水分、骨量、BMR、去脂体重、心率；FitDays+ 云端只有 `weight_kg / bmi / pbf`，外加原始 `imps`。

### 这对 Kinetrail 意味着什么

- 同一次称重的各类记录时间戳完全相同，按 `(来源包名, time)` 精确分组有代码依据，不属于“凭时间相近合并”。
- HC 记录 ID 由 HC 分配，FitDays+ 不带 `clientRecordId`。如果 FitDays+ 对同一次称重重复触发保存，HC 里会出现同一时刻的第二组记录。代码里没看到防重，是否真的会发生未验证，设计里按“同一时刻同类型多条”处理。
- 称重在 App 里删掉，HC 里还在（静态分析；G-HC4 的删除实测无效，待补测）。要从 Kinetrail 去掉误测，只能在系统 HC 界面删除，由推送带上删除（见 3.4）。

## 2. 设备端：从 HC 送到 Worker

第三方只能通过手机本地的 HC API 读取，官方同步文档给出的增量方式是 changes token 轮询，没有“数据变更”广播。数据只能由手机上的某个组件读出再发出去。平板上的 FitDays+ 登录会顶掉手机，所以平板不能充当桥，只能用测试账号做实验。

### 2.1 已核实的平台约束

| 约束 | 内容 | 来源 |
| --- | --- | --- |
| 系统形态 | Android 14 起 HC 是系统框架模块，不能卸载；13 及以下要装 HC App | [get-started](https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started)（2026-09-08） |
| 历史范围 | 读其他 App 写入的数据，默认只能读到首次授权前 30 天；更早要 `PERMISSION_READ_HEALTH_DATA_HISTORY` | [read-data](https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data)（2026-09-08） |
| 增量同步 | `getChanges` 返回 `UpsertionChange`（完整记录）与 `DeletionChange`（只有 id）；token 30 天未使用即过期 | [sync-data](https://developer.android.com/health-and-fitness/guides/health-connect/develop/sync-data)（2026-09-08） |
| 后台读取 | `READ_HEALTH_DATA_IN_BACKGROUND` 自 connect-client 1.1.0-alpha09 起提供；Android 14 需 U 扩展 ≥ 13，Android 15 出厂满足（按 AOSP extensions_db 推断）。运行时必须用 `getFeatureStatus` 判断 | [release notes](https://developer.android.com/jetpack/androidx/releases/health-connect)、androidx `HealthConnectFeatures.kt` |
| 配额 | 官方只说后台比前台严；AOSP 默认前台读 2000 次/15 分钟，后台 1000 次/15 分钟，可被服务端 flag 覆盖。本场景每次同步几次读取，远低于上限 | [rate-limiting](https://developer.android.com/health-and-fitness/guides/health-connect/plan/rate-limiting)、AOSP `RateLimiter.java` |
| Manifest | 需要声明权限说明 Activity（13 及以下 `ACTION_SHOW_PERMISSIONS_RATIONALE`；14 起 activity-alias + `VIEW_PERMISSION_USAGE`） | get-started |
| 侧载 | 没有官方原文；开源 App life-dashboard-companion-app 只以 GitHub APK 分发且申请后台/历史权限，推断侧载可以获得权限 | 根据现有证据推断 |
| ColorOS 后台 | dontkillmyapp 评 4/5、开发者侧无解；只能由用户开自启动、“允许完全后台行为”、最近任务里锁定。WorkManager 周期最短 15 分钟且时间不保证 | [dontkillmyapp/oppo](https://dontkillmyapp.com/oppo)（2026-06-09） |
| 国行 ColorOS 是否带 HC | 网上没有找到可靠来源；无 GMS 的 /e/OS 上出现过 HC 模块过旧、没有后台选项的情况。**用户手机已实测带 HC**（见第 5 节 G-HC1） | [home-assistant/android#5948](https://github.com/home-assistant/android/issues/5948) |

FitDays+ 的 Play 商店描述只提 Google Fit，不提 HC；这里以第 1 节的代码为准，但代码不代表手机上的包一定走到这条分支（G-HC1、G-HC2）。

### 2.2 方案比较

| 方案 | 结论 |
| --- | --- |
| 自写最小 App（Kotlin + `androidx.health.connect:connect-client`） | **推荐**。只读 7 个类型、只读 FitDays+ 来源，请求格式按第 3.3 节定制；代码量小，审计范围就是自己的几百行 |
| [life-dashboard-companion-app](https://github.com/owen282000/life-dashboard-companion-app)（MIT，1.14.0 发布于 2026-09-14） | 可作参考实现或备选。支持体成分类型，每条记录带 HC `uuid` 与来源包名，HMAC-SHA256 签整个请求体（无时间戳，重放在本设计里无害）。缺点：不带时区偏移、不分组；版本变动很快，格式会随升级变化；它能申请的健康数据远多于需要，要审整个 App。若采用，应从固定提交自行构建，不装他人编译的 APK |
| [HC Webhook](https://github.com/mcnaveen/health-connect-webhook)（AGPL-3.0） | 不采用：JSON 里体重只有值和时间，记录 id 只在 Protobuf 输出里，只回看 48 小时 |
| Home Assistant Companion 的 HC 传感器 | 不采用：只报每个类型的最新值，数据进 HA，不能保留逐次测量 |
| Tasker / Automate | 是否能读 HC 未核实；即使能，也难以保证分组和幂等 |
| adb 从电脑读取 | 手机未 root，HC 数据库在 `system_ce` 下读不到；不可行 |

### 2.3 自写 App 的读取流程

V1 只有前台同步：打开 App 或点“同步”时执行，不注册后台任务。

1. 首次启动：检查 `getSdkStatus`，申请 7 个读权限（Weight、BodyFat、BodyWaterMass、BoneMass、BasalMetabolicRate、LeanBodyMass、HeartRate）；**先**用 `dataOriginFilters = {cn.icomon.fitdayspro}` 取 changes token，再读最近 30 天，按时间分组后分块推送。全部 2xx 才保存 token。
2. 之后每次同步：用 token 拉 `getChanges` 直到没有更多；收集 `UpsertionChange` 里出现的时刻，对每个时刻按 `[t-1ms, t+1ms)` 读取 7 个类型并精确筛选到 `t`（心率是 start=end 的区间记录，严格区间可能漏读），拼成完整的组再推送，这样组不会被分页拆开。`DeletionChange` 的 id 一并推送。全部 200 才推进 token；服务端报 `HC_GROUP_CONFLICT` 时也不推进，并提示轮换令牌。
3. token 过期：重新取 token，重读最近 30 天；服务端靠内容哈希去重。过期期间在 HC 里做的删除拿不到，App 会明确提示去 Kinetrail 核对。
4. 令牌存 Android Keystore 支持的加密存储；只允许 HTTPS；除 HC 权限说明 Activity 外不导出组件；日志不打印令牌和数值。

V2 再加后台：`getFeatureStatus` 支持后台读时申请该权限，WorkManager 每小时一次，并由用户在 ColorOS 里放开自启动和后台。先连续跑一周，看服务端“最近推送时间”判断是否可靠，再决定是否保留。

## 3. Kinetrail 架构变更（已实现并部署，2026-09-15，PR #10）

实现：`src/ingest.ts`（端点、校验、合并、删除）、`tests/ingest.test.ts`；独立审查（Claude 子代理，Sol 连接不可用）报 4 MEDIUM / 4 LOW，均已修复并补反例测试，每条确认撤掉修复后测试失败；`refresh_data` 已从契约与 tools/list 移除（18 个工具）。下面是定稿后的规则；与最初设计不同之处在各小节注明。

### 3.1 边界

- 体测仍然只有一个写入路径：暂存 → 原子发布，持 `sync_lease`。推送入口只是这条链路的一个新来源。
- 推送入口只写 `source_record_id` 以 `hc:` 开头、`profile_ref = HC_PROFILE_REF` 的 `weight` 记录；不能改训练事实，不能碰 FitDays 来源的记录，不返回任何已存数据。
- 主来源切换：`refresh_data` 已下线，服务端不再主动登录 FitDays+。FitDays 拉取代码仍保留（`PERIODIC_SYNC=off`、没有工具入口），`FITDAYS_*` secrets 按用户决定保留；两个来源不同时导入同一段时间的数据，避免跨来源去重。
- 调度回收中断的推送批次时只标失败，**不会**像 FitDays 批次那样重排成拉取任务（那会登录 FitDays+ 并顶掉手机）；由设备重发。

### 3.2 端点与鉴权

`POST /ingest/health-connect`，走 OAuth Provider 的 `defaultHandler`，不在 `/mcp` 之下。

| 方案 | 结论 |
| --- | --- |
| 设备令牌：32 字节随机数，Worker 只存 SHA-256（secret `HC_INGEST_TOKEN_SHA256`），常量时间比较 | **采用**。手机是数据来源而不是用户代理；轮换就是重新写入 secret、在 App 里保存新令牌 |
| 复用 OAuth（新 scope） | 不采用。refresh token 30 天过期，无人值守推送会定期断；Android 端还要做 PKCE + Access 登录 |
| 路径前加 Cloudflare Access service token | 暂不做，需要双因素时再加，Worker 仍须自己验 JWT |

处理顺序与响应：

| 顺序 | 条件 | 响应 |
| --- | --- | --- |
| 1 | 非 POST，或未配置 `HC_INGEST_TOKEN_SHA256` | 404（与不存在的路径一致） |
| 2 | 同一 IP 每分钟超过 30 次（鉴权失败也计数） | 429 + `retry-after` |
| 3′ | 鉴权通过后全局每分钟超过 60 次（令牌泄漏时换 IP 也不能无限写入） | 429 |
| 3 | 令牌不符 | 401 `unauthorized`，日志只记 `status:"unauthorized"` |
| 4 | `Content-Type` 不是 JSON | 415 |
| 5 | 请求体超过 64 KiB（解析前有界读取） | 413 |
| 6 | 非 UTF-8、非 JSON、不符合 schema，或 `findSecretPath` 命中 | 400 `invalid_json` / `invalid_payload` |
| 7 | 未配置 `HC_ACCEPT_AFTER` 或 `HC_PROFILE_REF`；或库里已有成员而 `HC_PROFILE_REF` 不在其中（写错会新建成员，让体测工具全部 `PROFILE_REQUIRED`） | 503 `not_configured` |
| 8 | lease 被占用 | 503 `busy` + `retry-after: 10` |
| 9 | 存储失败 | 500 `storage_failed`，批次标失败 |
| — | 其余 | 200 `{accepted, unchanged, rejected:[{time_ms, code}], deletions_matched, deletions_unmatched}` |

200 里有逐组拒绝时，设备照样推进 changes token（被拒的组按规则重发也会被拒），唯独 `HC_GROUP_CONFLICT` 不推进。

### 3.3 请求格式

同一来源、同一时刻的 HC 记录为一组；设备对每个变更时刻重读整组，组不会被拆到两次请求里。

```json
{
  "schema_version": "1",
  "groups": [
    {
      "origin": "cn.icomon.fitdayspro",
      "time_ms": 1789453352000,
      "zone_offset_seconds": 28800,
      "records": [
        { "hc_id": "f1610abf-8061-4fd5-8d7c-0f7a0cffe707", "type": "weight", "value": 63.099998474121094, "last_modified_ms": 1789453353143 },
        { "hc_id": "4cbcbd0c-225f-4e4f-bdb5-dd4ad815960d", "type": "body_fat", "value": 19, "last_modified_ms": 1789453353144 }
      ]
    }
  ],
  "deleted_hc_ids": []
}
```

Schema（全部 `additionalProperties:false`，没有自由字符串）：`schema_version` 固定 `"1"`；最多 200 组、每组 1–14 条记录、最多 500 个删除 id；`origin` 固定 `cn.icomon.fitdayspro`；`hc_id` 为小写 UUID；`type` 为 `weight`（kg）、`body_fat`（%）、`body_water_mass`（kg）、`bone_mass`（kg）、`basal_metabolic_rate`（kcal/day）、`lean_body_mass`（kg）、`heart_rate`（bpm）之一，单位由设备端用 HC 单位 API 换算。每组记录上限留到 14 而不是 7，是为了让“同类型重复”走逐组拒绝，不让整个请求 400、设备卡住。

逐组拒绝码（不入库，计入 `rejected`）：

| 代码 | 条件 |
| --- | --- |
| `HC_BEFORE_CUTOVER` | `time_ms` ≤ `HC_ACCEPT_AFTER` |
| `HC_FUTURE_TIME` | 晚于服务端时间 5 分钟以上 |
| `HC_VALUE_OUT_OF_RANGE` | 体重不在 (2, 400] |
| `HC_DUPLICATE_TYPE` | 同组同类型多条 |
| `HC_DUPLICATE_GROUP` | 同一请求里同一时刻出现两组 |
| `HC_GROUP_WITHOUT_WEIGHT` | 库里没有这一组且新组不含体重 |
| `HC_GROUP_CONFLICT` | 与已存组冲突，见 3.4 |

其他类型的范围为体脂 (0, 100]、各质量 (0, 400]、BMR (300, 5000]、心率 (25, 250]；越界只让该指标不进索引（置 null、标 `<type>_out_of_range`），raw 照存，不连累同次称重（FitDays+ 写心率的范围是 1–300）。

与最初设计的差异：去掉了“各质量不超过同组体重”的交叉校验；`deletions_seen` 计数改为真正的 `deleted_hc_ids`（见 3.4 删除）；附属指标越界从整组拒绝改为只丢该指标（独立审查 M3）。

### 3.4 映射到现有存储与合并规则

不改表结构，不新增 migration。

| 字段 | 取值 |
| --- | --- |
| `sync_batches` | 每次推送一个批次：`mode='incremental'`、`source_region='health_connect'`、`counts_json` 记 `weight`/`rejected`/`deletions_matched`/`deletions_unmatched`；没有有效组也没有删除时不建批次 |
| `raw_records.dataset` | `weight`，现有查询和趋势不用改 |
| `profile_ref` | 变量 `HC_PROFILE_REF` = 现有本人 `p_914ea14c79915f2f`。依据是 FitDays+ 只为主用户写 HC（静态分析 + G-HC3），且用户改用主用户称重；主用户资料必须是本人的 |
| `source_record_id` | `hc:cn.icomon.fitdayspro:<time_ms>`，`identity_kind='source_id'`；`source_data_id` 存体重记录的 `hc_id` |
| `raw_json` | 规范化整组 `{source, origin, time_ms, zone_offset_seconds, records, deleted_records}`：记录按 `(type, hc_id)` 码点排序，保留 HC 返回的 double 原值。内容相同 → `raw_hash` 相同 → 只更新 `last_seen`，重发天然幂等，不需要收据表 |
| `measured_at` / `local_date` | `floor(time_ms / 1000)`；本地日期按 Asia/Shanghai |
| `metrics_json` | `weight_kg`、`body_fat_pct`、`bone_mass_kg`、`bmr_kcal`、`heart_rate_bpm`；恰好是 float32 的值取最短十进制（63.099998474121094 → 63.1）；`body_water_pct` = 水分质量 ÷ 体重 × 100 保留 2 位小数，标 `body_water_pct_derived_from_mass`；`bmi` = 体重 ÷ (`HC_HEIGHT_CM`/100)² 保留 1 位小数（用户提供身高 164 cm，2026-09-15），标 `bmi_derived_from_height`。去脂体重与水分质量只在 raw 里，不新增索引指标；`formula_version` 仍为 `body_v1` |
| `quality_flags` | 恒含 `source_health_connect` |
| `is_deleted` | 组内没有有效体重记录时为 1（整次测量作废，默认查询排除，`include_deleted` 可见 tombstone） |

**合并**（在拿到 lease 之后读取已存组）：

- 已存 `hc_id` 的类型、值、`last_modified_ms`、组的时区偏移都不可变；不同则整组 `HC_GROUP_CONFLICT`。
- 新 `hc_id` 不能与组内现有**或已删除**记录同类型；否则 `HC_GROUP_CONFLICT`。已删类型若可补回，泄漏令牌就能先删后补、复活作废的称重（独立审查 M1）。
- 出现在已删记录里的 `hc_id` 忽略，不会复活。
- 通过则产生新版本（旧版本保留）。FitDays+ 从不更新 HC 记录，正常数据只会出现“补齐新类型”。

**删除**（用户同意接受，2026-09-15）：G-HC4 证实 FitDays+ 里的删除不会同步到 HC，唯一的修正途径是在系统 HC 界面删除，这会产生只带 id 的 `DeletionChange`。

- 设备把删除 id 放进 `deleted_hc_ids`。服务端在本次合并结果与已存组里查找含该 id（在 `records` 或 `deleted_records` 中）的组；找不到计 `deletions_unmatched`，不做任何事。
- 命中时把整条记录（含类型与值）移入组的 `deleted_records`，写成新版本；删的是体重记录时 `is_deleted=1`。已经删过的 id 只计 `deletions_matched`，不产生新版本。
- 不做物理删除，旧版本可追溯。

### 3.5 与已有记录去重

- 旧 FitDays 历史（线上 92 条 weight 记录，最后一条 2026-09-15 09:17:00 +08:00）与 HC 数据不做跨来源匹配。`HC_ACCEPT_AFTER = 2026-09-15T09:17:00+08:00`，不晚于它的 HC 组计 `HC_BEFORE_CUTOVER`，不入库。
- HC 默认只能读取授权前 30 天的数据，加上 FitDays+ 不回填历史，截断点之后的空档只可能是“09:17 之后、改用主用户之前、在旧成员下称的记录”，需要时一次性手工核对补齐。
- 16:54:45 那组是经测量页的正常称重（与 17:01 数值相同，17:01 未写入 HC），已随首次同步入库，保留。

### 3.6 契约变更

- `DATA_CONTRACT.md` 第 2 节新增来源 `health_connect`，第 7 节新增推送规则（本节内容的规范版本）。
- `MCP_CONTRACT.md`：工具表去掉 `refresh_data`；`get_sync_status` 的 `last_success_at` 含推送；`stale` 改为最近一次成功发布超过 36 小时；“减肥计划”项目 instructions 去掉刷新体测一段。输出 schema 没有新增字段（`counts` 本来就是开放对象）。
- `body:sync` scope 保留在 AS 元数据里，没有工具再使用它；避免已授权的 ChatGPT 连接因 scope 变化失效。

### 3.7 新增攻击面

| 威胁 | 缓解 | 残余风险 |
| --- | --- | --- |
| 令牌泄漏（手机被攻破、备份、日志） | 端点只写不读；只能动 HC 来源的组；已存值不可变、已删类型不能补回；删除只写新版本；鉴权后全局每分钟 60 次 | 攻击者能注入假测量；能用已知 `hc_id` 把真实测量标成删除（`hc_id` 会出现在 `get_latest_measurement_full`、`get_measurements` full 的 `raw_json` 里，拿到 ChatGPT 对话内容的人可以看到）；能抢先为未来几分钟的每一秒注入假组，让真实称重到达时 `HC_GROUP_CONFLICT`，此时 App 不推进同步进度并提示轮换令牌，真实数据仍在 HC 里可重推。发现后轮换令牌，按 `batch_id` 定位，从版本历史恢复；清理注入数据需用户另行授权 |
| 暴力猜令牌 | 256 位随机；按 IP 限流，失败也计数；全局计数在鉴权之后，未授权请求挤不掉设备额度 | 无实际风险 |
| 大包、深嵌套、数值异常 | 解析前 64 KiB 有界读取、严格 schema、组数与记录数上限、取值范围 | — |
| 重放 | 内容相同即 `unchanged`；已删 id 不复活 | — |
| 与另一次推送或遗留 FitDays 任务并发 | 共用 `sync_lease` 与 generation fencing；读取—合并—发布都在持有 lease 期间 | 被拒时设备重试 |
| 秘密进入存储或输出 | 请求 schema 里只有 UUID、枚举、固定来源和数字，没有自由文本；另过 `findSecretPath` | — |
| 请求级错误让设备卡住 | 每组记录上限 14（同类型重复走逐组拒绝）；App 按字节分块（≤ 48 KiB） | 单组超过 14 条会整请求 400、token 不前进；FitDays+ 每组最多 7 条，只在异常数据下出现 |
| 同一时刻已存组的 `last_modified_ms` 被 HC 改写（备份恢复等） | 无 | 推测风险：之后该时刻每次重发都 `HC_GROUP_CONFLICT`，App 停住并提示，需要人工处理 |
| 其他成员或其他 App 的数据混入 | 设备端按 `dataOriginFilter` 读取；服务端 schema 固定 origin；主用户假设由 G-HC3 核实 | FitDays+ 若日后改成写所有成员，服务端无法分辨；升级 FitDays+ 后需重跑 G-HC3 |
| 端点被探测 | 不在任何 metadata 中出现；非 POST 或未配置时 404 | — |

## 4. 与 FitDays+ 适配器对比

| 维度 | FitDays+ 适配器（`wip/fitdaysplus-adapter`） | HC 推送 |
| --- | --- | --- |
| 顶号 | 每次刷新顶掉手机一次，无法绕过 | 不登录，无 |
| 新数据字段 | weight_kg、bmi、pbf、原始 imps | weight、体脂率、水分、骨量、BMR、去脂体重、心率（BMI 由服务端按身高推算） |
| 历史回填 | 能拉云端全量（含迁移过来的历史） | 不能；只有开关打开后的新称重 |
| 修改/删除 | 有 `*_delete_list`（语义未核实） | 不跟随 |
| 其他成员 | 需要 `PROFILE_ALLOWLIST` 过滤 | FitDays+ 只写主用户 |
| 新鲜度 | 用户在 ChatGPT 里说“刷新” | 手机上点一次；第二步可做后台 |
| 新增组件 | 无 | 手机 App、推送端点、设备令牌 |
| 外部依赖 | 未公开接口，签名规则可能随 App 版本变化 | HC 公开 API；依赖 FitDays+ Google 渠道包和 App 内开关 |
| 剩余工作 | 测试全红待修；`profile_ref` 映射缺陷；真实数据验证 | 设备端 App；端点与测试；契约改写 |
| 失败时的表现 | 登录/签名失败会报错，可见 | HC 写入静默失败（权限被撤、开关被关）时 Kinetrail 只能看到“很久没推送” |

判断：用户的核心诉求是不被顶号，而体重、体脂两个主要指标两边都有，HC 还多出几项，所以 HC 路线更合适。适配器唯一的独有价值是历史回填，但 157 条历史已在库、迁移刚发生，这部分价值很小。**建议 `wip/fitdaysplus-adapter` 保留不合并**；如果 G-HC 关卡失败再回到它，并先修 `profile_ref` 映射。

## 5. 核实关卡

| 关卡 | 做法 | 通过条件 |
| --- | --- | --- |
| G-HC1 渠道与平台 | 手机连 adb：`adb shell getprop ro.build.version.release`；`adb shell dumpsys package cn.icomon.fitdayspro` 看 `versionName` 与请求的 `android.permission.health.*`；在 App 设置里找 Health Connect 入口；系统设置里找 Health Connect | 手机系统带 HC；手机上的包声明了 HC 权限，App 内能打开 Health Connect 开关。同时记下 Android 版本，决定 V2 能否后台读 |
| G-HC2 实际写入 | 开关打开后称一次，到 系统设置 → Health Connect → 数据和访问 → 体重/体脂…… 查看条目与来源 | 条目来自 FitDays+，类型与第 1 节表格一致，时间与 App 内记录一致 |
| G-HC3 主用户 | 让另一位成员（或切换成员）称一次，再看 HC | 只有本人的称重出现在 HC |
| G-HC4 重复与修改 | 在 App 里编辑、删除刚才那条；再断网称重、恢复网络后看是否重复写入 | 记录现象，按结果确认 3.4 的重复规则与“不跟随删除”说明 |

### G-HC1 结果（2026-09-15，通过）

手机经 adb 只读检查（此前一直连不上，原因是走了 VID 2109 的 USB 集线器，读序列号报 Windows 错误 31；直连电脑后正常）：

| 项 | 结果 |
| --- | --- |
| 机型 / 系统 | 一加 13（`PJZ110`），ColorOS `PJZ110_16.0.10.501(CN01)`，Android 16 / SDK 36，安全补丁 2026-08-01 |
| SDK 扩展 | `build.version.extensions.u/v/b` 均为 17（后台读取需要 ≥ 13，运行时仍以 `getFeatureStatus` 为准） |
| HC 模块 | `com.android.healthfitness`（360499999）、`com.android.healthconnect.controller`、`com.google.android.apps.healthdata`（274060）；有 GMS 与 Play 商店；系统服务 `healthconnect` 在 |
| FitDays+ | 1.14.1（versionCode 66，targetSdk 35），安装来源 `com.android.vending`，安装于 2026-09-15 10:49 |
| 渠道 | 手机 base.apk 的 manifest 字符串池含 `UMENG_CHANNEL_VALUE` / `FitdaysPro_Google` |
| 与分析样本是否同一构建 | 手机 base.apk 大小 77,277,702 字节，与平板样本中央目录记录的总长一致；`classes.dex`–`classes4.dex` 的 SHA-256 与本文分析用的 dex 逐个相同 |
| HC 权限 | 8 个类型的 READ/WRITE 共 16 项全部 `granted=true`、`USER_SET` |

### G-HC2 / G-HC3 结果（2026-09-15，用户在手机上观察）

- 称重后 HC 里出现了数据（G-HC2 通过）。各类型明细、`hc_id` 与精确时间戳未逐项核对，留给读取工具。
- **只有用 FitDays+ 主用户称重才写入 HC**，与代码中 `uid == muid` 的判断一致（G-HC3 通过）。用户原来记录 79 条的那个成员不是主用户，今后改用主用户称重；用户认为可以接受。
- 由此带来的约束：FitDays+ 用主用户的身高、年龄、性别计算体脂等体成分。主用户资料必须是本人的，否则写入 HC 的体脂率、BMR、水分等都是按别人的参数算的，体重不受影响。进入实现前要确认主用户资料。
- 旧成员在 FitDays+ 里的 79 条不会进入 HC。Kinetrail 已有旧 FitDays 的 157 条；需要核对这 79 条里有没有晚于 D1 最后一条的记录，有的话按第 3.5 节一次性补齐。

### G-HC2 明细（2026-09-15，读取工具 0.1.0 实读）

读取工具（`android/`，只读、按 `cn.icomon.fitdayspro` 来源过滤）读最近 30 天，只有 14:22:32（+08:00）那一次称重，共 6 条记录：

| 字段 | 实际值 | 对设计的影响 |
| --- | --- | --- |
| 类型 | Weight、BodyFat、BodyWaterMass、BoneMass、BasalMetabolicRate、LeanBodyMass；这次没有 HeartRate | 与第 1 节代码一致；心率为 0 时不写 |
| `time` | 6 条完全相同，精确到秒 | 按 `(origin, time)` 分组成立 |
| `last_modified` | 相差 1 毫秒（.143 / .144） | 不能用 `last_modified` 分组 |
| `zone_offset` | 28800（+08:00） | 可直接存 |
| `client_record_id` / `client_record_version` | null / 0 | 与代码一致；只能用 HC 分配的 `id` |
| `recording_method` / `device` | 0（未知）/ null | 没有设备信息，`device_ref` 为空 |
| 30 天内其他记录 | 无 | 印证不回填历史 |

数值有 float32 痕迹：体重 `63.099998474121094`、骨量 `3.4000000953674316` 恰好是 float32 值，最短十进制为 63.1、3.4；水分 `37.481400056457495` = 63.1 × 59.4%，说明 App 按 1 位小数的水分百分比换算；去脂体重 51.1 已按 1 位小数取整；体脂率 `19`、BMR `1473` 是整数。设计相应调整：

- raw 保留 HC 返回的 double 原值，不改写。
- 索引值：恰好是 float32 的取 float32 最短十进制（63.1），其他按原值；`body_water_pct` 由水分质量 ÷ 体重（均已归一）× 100 后保留 2 位小数，这次得 59.40。
- 体脂率不是整数：G-HC4 那次称重读到 `18.4`，所以上面的 `19` 就是 19.0，精度 1 位小数。体重是 2 位小数值的 float32（`63.04999923706055` → 63.05）。

### G-HC4 结果（2026-09-15，读取工具变更记录 + 用户操作）

变更基线建立于 15:14。用户在 16:54 与 17:01 各称一次（数值相同，63.05 kg / 18.4%），其间开关飞行模式，读变更，再在 FitDays+ 里做删除操作后读变更。

**更正（2026-09-15 晚）**：最初把 16:54 当成飞行模式下的称重，据此写了“称重当下写入，不依赖联网”，这个推断没有核实，是错的。HC“近期数据访问情况”显示 FitDays+ 当天只在 16:54 写入；17:01 那条在 FitDays+ 历史里有，HC 与 D1 首次同步都没有。用户随后又试两次，得出写入条件：

> **只有在 FitDays+ 里打开对应体脂秤的测量页、站上秤触发手机上的测量动画时才会写入 HC；有动画就一定写入，没有动画就不写，与是否飞行模式无关。**（用户实测，共 4 次称重）

这与静态分析一致：写 HC 的 `ICAFNetworkWeightSaveRequest` 由测量页（`ICAFScaleBaseMeasuringActivity`，另有婴儿模式、手动录入体重、成员信息页）发起；秤端缓存或未同步的称重由首页从本地库查出后走 `ICAFNetworkWeightNotSyncSaveRequest` 补传，这条路径不调用 HC。手动录入体重会不会写 HC 未实测。

| 问题 | 结果 | 依据 |
| --- | --- | --- |
| 什么时候写入 HC | 测量页出现动画的称重，当下写入（16:54 组 `last_modified` 比测量时间晚不到 1 秒）；不经测量页的称重（如 17:01）不写，之后联网补传也不写 | 用户实测、HC 访问记录、变更文件、D1 首次同步 |
| 会不会重复写 | 未见重复：4 次读变更只有 16:54 一组 upsert；30 天读取每个时刻恰好一组 | 变更文件、30 天读取 |
| App 内删除会不会同步 | 实测**无效**：删除后 FitDays+ 历史仍有三条，无法确认删的是哪一条、是否删成功。结论只由静态分析支撑（HC 封装里没有 `deleteRecords`/`updateRecords` 调用） | 静态分析；待补测 |
| 分组内 `last_modified` | 16:54 组 6 条相同；14:22 组相差 1 毫秒 | 仍不能用它分组 |

对设计的影响：

1. **重复规则可以保持简单**。补传路径根本不写 HC，也没有见到重复，3.4 里“同一时刻同类型多条”的处理保留为防御。
2. **不经测量页的称重会静默缺失**：它们进 FitDays+ 云端，但不进 HC，Kinetrail 无从得知。日常用法必须是“打开 FitDays+ 对应秤的测量页再站上去，看到动画”。要补这类缺口只能靠 FitDays+ 云端对账（会顶号），暂不做。
3. **FitDays+ 里删掉的误测记录会一直留在 HC 里**，推送上去就会进入 Kinetrail。唯一的修正途径是用户在系统 HC 界面删除该记录，这会产生明确的 `DeletionChange`。原设计 V1 不接受删除，现在需要改为：只接受已入库 `hc_id` 的删除，写成 `is_deleted=1` 的新版本（旧版本保留、可恢复），不做物理删除。代价是令牌泄漏时攻击者能隐藏记录，但能从版本历史恢复。**用户已确认（2026-09-15），规则见 3.4。**
4. ~~16:54:45 那组是测试记录，上线前要删~~：更正，它是经测量页的正常称重，保留。

没能在命令行里看到 HC 里已有的记录：`dumpsys healthconnect` 无输出，`cmd healthconnect` 没有实现。App 内开关（账户设置 `HealthConnect`）的值需要 root 才能读，没有核实；权限全部授予说明开关流程至少走过一次。

G-HC2 到 G-HC4 要看记录 ID 和精确时间戳时，用第 2 节的最小读取 App（调试版，侧载）在手机上读一遍，或在平板上用测试账号复现后以 root 读 HC 数据库。平板复现不代表手机渠道包的行为，G-HC1 必须在手机上做。
