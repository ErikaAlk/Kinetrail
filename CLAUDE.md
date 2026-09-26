# CLAUDE.md — Kinetrail

个人体测（2026-09-22 起由 T6 上的体脂秤网关经 BLE 推送，之前是手机经 Health Connect 推送、更早是 FitDays 只读拉取）与训练事实的远程 MCP 服务器。Cloudflare Worker + D1 + OAuth Provider(KV) + Access OIDC。契约以 `ARCHITECTURE_DECISION.md`、`DATA_CONTRACT.md`、`MCP_CONTRACT.md` 为准；Health Connect 方案与实测见 `research/HEALTHCONNECT.md`；手机端在 `android/`；体脂秤网关在 `gateway/`（部署步骤在它的 README）；运维见 `docs/operations.md`；适配小米体脂秤 S800 的步骤见 `docs/xiaomi-s800.md`。

## 命令

- `npm run check`：lint + typecheck + 测试（workerd）+ 秘密扫描。提交前必须全绿。
- `npm run types`：改 `wrangler.jsonc` 后重新生成 `worker-configuration.d.ts`。
- 仓库里的 `wrangler.jsonc` 是占位符（仓库公开）。本人实例的真实账户、域名、资源 ID、`OWNER_OIDC_SUB` 在本机 `wrangler.local.jsonc`（git 忽略），部署、迁移、`d1 execute`、`secret put` 一律加 `-c wrangler.local.jsonc`；其余标识（D1 书签等）在本机 `ops.local.md`。手机 App 的服务端地址在 `android/local.properties` 的 `kinetrail.origin`。
- 仓库是公开的：提交里不放真实体测读数、名字、部署标识。测试和样本用合成数值（识图样本保留真实版式和读错方式，数字已替换）。
- 契约 schema 改动：先改 `research/build-contract.py` 并运行，再同步 `src/schemas.ts`；`tests/contract.test.ts` 断言两者完全一致。

## 不变量（改动前先确认不会破坏）

- 对 FitDays 只读：`src/fitdays.ts` 只允许固定 origin 的 login/syncFromServer；新增路由或域名必须先有真实证据并补测试。
- 秘密不进 D1 普通记录、日志、MCP 输出：采集走 `sanitize.ts`，读输出与写输入都过 `findSecretPath`。日志只能经 `util.ts` 的 `logEvent` 白名单字段，不打印错误对象、URL、body。
- 未分类的自由字符串 fail-closed（整条不发布、批次 partial），不能为了“同步成功”放宽。
- 查询只读已发布快照（`queries.ts` 的 `VISIBLE`），读工具不触发同步；训练写工具 `readOnlyHint=false`。`refresh_data` 已下线（体测改由手机推送），不要为“数据新鲜”加回服务端拉取。
- Health Connect 推送（`src/ingest.ts`）：令牌只存 SHA-256；只写 `hc:` 前缀、`HC_PROFILE_REF` 的 weight 记录，碰不到 FitDays 来源；已存 `hc_id` 的值不可变，删除只写 tombstone 新版本；读取、合并、发布都在 `sync_lease` 内。推送批次被调度回收时不得重排成 FitDays 拉取任务（会登录 FitDays+ 顶掉手机）。FitDays+ 只把主用户写进 HC，FitDays+ 升级后重跑 G-HC3。
- 识图报告（`reports[]`）：手机本机 OCR，请求里只有数字；只挂到同一分钟、体重相同、恰好一组的已入库 HC 称重上，挂上后不可变；只补 HC 没有的指标，不覆盖 HC 值。不要为了“能挂上”放宽匹配（按时间就近、忽略体重），也不要把图片传到服务端识别。手机端必需的只有检测时间和体重，其余指标没认出就整项不发（schema 里都是可选，服务端只补 `typeof value === 'number'` 的），不要退回“缺一项整张作废”；交叉校验不过是数字读错，仍然拦下。解析与交叉校验在 `android/.../report/ReportParser.kt`，请求 JSON 与服务端测试共用 `tests/fixtures/android-report.json`。
- 训练写入：先查收据，再校验，再单个 D1 batch 提交（guard 表 CAS）；约束失败为 not_committed，其他批量错误且查不到收据为 unknown。V1 没有 hard delete，事实表由触发器兜底。
- 体脂秤网关（`src/scale.ts`、`gateway/`）：独立令牌只能写；体重与阻抗由服务端从 `a7_hex` 自己解，体成分是网关按 WLA37 算的，服务端只查一致性与范围，不要改成相信网关另报的体重。身份是帧内容哈希（秤会重发缓存的旧结果），已入库的帧不再改。`SCALE_ACCEPT_AFTER` 同时是 HC 来源的终点，别让两个来源重叠。请求形状由 `tests/fixtures/gateway-measurement.json` 钉住，网关 `--check` 与服务端测试共用；改字段两边一起改。网关日志不写体重和阻抗。
- 物理删除称重（`src/purge.ts`，用户 2026-09-22 要求）：只删本人 `hc:`/`ble:` 来源的称重，旧 FitDays 记录不开放（关联规则未验证）；在 lease 内单个 D1 batch 删全部版本与分块，写不含读数的墓碑。两个禁止删除触发器只放行 `purge_authorizations` 里的记录，别为了方便删掉触发器或在别处写授权行。推送入口都要先查墓碑（`deletedSources`），否则手机重读 HC 会把删掉的称重写回来。暂存的每个 batch 先验 lease（`stageBatch` 的 fence），别拿掉。
- 手机日历（`src/calendar.ts`）：只读，复用推送令牌（用户 2026-09-16 批准的扩权），只读 `VISIBLE` 快照与当前生效的动作版本，不触发同步；输出不含 `raw_text`，发出前过 `findSecretPath`。响应形状由 `tests/fixtures/calendar-response.json` 钉住，服务端与 Android 单测共用，改字段要同时改两边。手表消耗热量走 `finalize_workout_session` 的 `calories_kcal`，不走 Health Connect。
- 只存本人：`PROFILE_ALLOWLIST` 限定入库的 FitDays 成员（当前只有本人），其他成员和无 suid 的记录在消毒前丢弃。不要为“数据更全”清空它；换人时写 profile_ref，不写原始 suid。事实表的物理删除只有两处：用户授权的一次性 `scripts/purge-non-owner-profiles.sql`（2026-09-15 已执行）和手机上按条删称重。网关来源分不出是谁，用户同意放宽为「与本人近 14 天体重中位数差超过 `SCALE_WEIGHT_WINDOW_KG` 的不收，漏进来的室友在手机上删」（DATA_CONTRACT 第 10 节）；别把窗口调得更宽，也别在没有参考体重时放行。
- 每次同步尝试一个 batch_id；只有持有 lease 的尝试能发布或写错误状态。
- 趋势按请求时区（默认 Asia/Shanghai）自然日：先日中位数，再对有数据日等权平均；派生值逐次先算；bfr≤0 不参与体脂类指标。

## 环境坑

- ChatGPT 不会自动拉新的 MCP 工具列表，而且用户在 Business 工作区：工具定义在连接时冻结，插件设置里点 Refresh、开新对话都不生效，模型仍按旧定义调用（不报错，只是不传新字段）。改了工具参数或说明并部署后，要在 ChatGPT 里删除 Kinetrail 再重新添加、授权，然后开新对话（`docs/operations.md` 发布步骤）。判断有没有生效只能看结果：线上 `tools/list` 本身没问题，查 D1 里新字段是否写进去。
- vitest 用 `@cloudflare/vitest-plugin`（`@cloudflare/vitest-pool-workers` 已改名）；每个测试文件独立存储，同文件内共享 D1，测试用随机 owner 隔离。
- 不要把 MCP SDK 的 Server 引回来：它静态引入 Ajv（`new Function`），会让生产 bundle 违反“无 eval 依赖”。协议层在 `src/mcp.ts` 自己实现并由 Inspector 互通检查覆盖。
- D1 限制 compound SELECT 项数，`UNION ALL` 多了会报 “too many terms”，用标量子查询。
- `wrangler d1 execute --persist-to` 指向含 8.3 短名（`~1`）的路径会报 internal error，用仓库内相对路径。
- 账户没有 workers.dev 子域时 cron 注册失败（10063），Worker 与自定义域名却已上线，容易误以为部署成功；本账户已设置过子域。
- FitDays 与 FitDays+ 同一账号只保留最后一次登录的 token，Kinetrail 每次同步都会把用户手机 App 顶下线。`PERIODIC_SYNC` 保持 `off`，不要为了“数据新鲜”打开，也不要自己排队同步；换 client_id 或 os_type 都绕不过（`research/FITDAYSPLUS.md`）。
- 本账户 cron 触发器注册成功但从不投递，定时同步靠 `SyncScheduler` 的 DO alarm。判断调度是否在跑看 Observability 的 `origin=alarm` 与 `event:"scheduler"`；Cloudflare 的 scheduled 分析和“过往 Cron 事件”对它不适用。
- MCP Inspector 在 Windows 的 Node 24 下退出时会崩溃，互通检查固定用 Node 22.23.2。
- Write 工具会把字符串里的 `\u0000` 写成真实 NUL 字节，源码里需要分隔符时用可见字符或确认文件内容。Bash heredoc 会把 `'\n'` 这类转义吃掉，写含反斜杠的代码或文档用 Write/Edit 工具。
- `android/` 的 Gradle 在 Claude Code 进程树里直接跑会报 loopback 连接失败，要设 `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\Windows\Temp`（`android/gw.bat` 已设）。
- 手机端界面只用设计库 `coloros-ui-kit`（全局 DESIGN.md），构建时 includeBuild，设计库要和 Kinetrail 并排放在 `code/` 下；工具链（AGP、Kotlin、Compose BOM、Gradle）跟设计库同一代，单独升某一个会让插件加载两次。
- ML Kit 在报告的衬线字体上会读错形近字（体→休、控→挖、肉→內、龄→齡、级→級、成→咸、率→奉/牽、抗→坑）、多认一个字（「肌肉均衡」→「肌肉內均衝」）、读错符号（`|`、`%`→`96`、`/1`→`1`、`0`→`o`），还会丢小数点（「157.7%」→「1577%」）或把小数点读成逗号（「45.9」→「45,9」，2026-09-18 真机实测）。同一份报告每天错的地方都不一样，两处叠加（「內脏脂肪等級」「身体休年齡」，2026-09-19 实测）就超出一处容错，所以形近字按组归一（`ReportParser.kt` 的 `CONFUSABLE`）再比编辑距离，别再逐次往表里补一个误读。容错阈值只能是 1：「分段脂肪分析」与「肌肉脂肪分析」只差两个字。数字之间的逗号在 `normalize` 换回小数点（否则只截到前半段，再按丢小数点还原会差十倍），数字按报告固定小数位还原（`ICERUnitConfig.o()` 保证质量/比例/阻抗一位小数、表里体重两位）。改解析前先看两份真实读法：`mlkit-replica-ocr.json`（模拟器 + 近似图）与 `mlkit-real-report-ocr.json`（真机 + FitDays+ 原图）。
- 用 `adb shell am start -a android.intent.action.SEND --eu android.intent.extra.STREAM content://media/...` 模拟分享会因 shell 没有媒体授权报 SecurityException，验证识图改走 App 里的相册选图。Git Bash 里的 adb 路径参数要加 `MSYS_NO_PATHCONV=1`，否则 `/sdcard/...` 会被改写成 Windows 路径。
- Kotlin KDoc 里写 `values*/` 这类含 `*/` 的路径会提前结束注释，编译报一串 “Expecting a top level declaration”。
- T6 的 USB 蓝牙适配器是 RTL8761BU，`armbian-firmware` 里没有它的固件，而 Debian 的 `firmware-realtek` 与 `armbian-firmware` 互相冲突，直接 `apt install` 会卸掉整包 Armbian 固件。只从 Debian 包里取两个 `rtl8761bu_*.bin`（`gateway/README.md` 第 1 步）。用户住宿舍，身边只有 T6；香橙派在家里，连不到是正常的。
- 宿舍网络给 T6 发了 IPv6 默认路由，但 IPv6 实际不通（`curl -6` 超时、`curl -4` 秒回）。curl 会自动退回 IPv4，Python urllib 不会：它按解析顺序逐个地址等满超时，网关推送因此晚过一分钟，现在网关自己先连 IPv4（`connect_ipv4_first`）。
- T6 上的 systemd 服务别用 `DynamicUser`：Armbian 的 nsswitch 没有 `systemd` 模块，动态 uid 解析不了，连系统 D-Bus 会在握手时断开（dbus_fast `EOFError`）。网关用 `useradd` 建的 `kinetrail-gw`。
- 从 PowerShell 给 ssh 写远端命令时，远端要用的单引号别写成 `''x''`：三层引号拆开后 `tr -d ''\r''` 变成了 `tr -d r`，把配置里的字母 r 全删了。远端命令用 PowerShell 单引号字符串包住、里面用双引号；写完核对哈希或内容。
- 手机插在 VID 2109 的 USB 集线器上时，Windows 能枚举 ADB 接口，但 adb 读序列号报错 31、`adb devices` 为空；直插笔记本 USB 口。ColorOS 上 `adb install` 要在手机上点确认，命令超时不代表失败。
