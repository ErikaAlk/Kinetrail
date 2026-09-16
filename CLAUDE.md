# CLAUDE.md — Kinetrail

个人体测（手机经 Health Connect 推送；早期为 FitDays 只读拉取）与训练事实的远程 MCP 服务器。Cloudflare Worker + D1 + OAuth Provider(KV) + Access OIDC。契约以 `ARCHITECTURE_DECISION.md`、`DATA_CONTRACT.md`、`MCP_CONTRACT.md` 为准；Health Connect 方案与实测见 `research/HEALTHCONNECT.md`；手机端在 `android/`；运维见 `docs/operations.md`。

## 命令

- `npm run check`：lint + typecheck + 测试（workerd）+ 秘密扫描。提交前必须全绿。
- `npm run types`：改 `wrangler.jsonc` 后重新生成 `worker-configuration.d.ts`。
- 契约 schema 改动：先改 `research/build-contract.py` 并运行，再同步 `src/schemas.ts`；`tests/contract.test.ts` 断言两者完全一致。

## 不变量（改动前先确认不会破坏）

- 对 FitDays 只读：`src/fitdays.ts` 只允许固定 origin 的 login/syncFromServer；新增路由或域名必须先有真实证据并补测试。
- 秘密不进 D1 普通记录、日志、MCP 输出：采集走 `sanitize.ts`，读输出与写输入都过 `findSecretPath`。日志只能经 `util.ts` 的 `logEvent` 白名单字段，不打印错误对象、URL、body。
- 未分类的自由字符串 fail-closed（整条不发布、批次 partial），不能为了“同步成功”放宽。
- 查询只读已发布快照（`queries.ts` 的 `VISIBLE`），读工具不触发同步；训练写工具 `readOnlyHint=false`。`refresh_data` 已下线（体测改由手机推送），不要为“数据新鲜”加回服务端拉取。
- Health Connect 推送（`src/ingest.ts`）：令牌只存 SHA-256；只写 `hc:` 前缀、`HC_PROFILE_REF` 的 weight 记录，碰不到 FitDays 来源；已存 `hc_id` 的值不可变，删除只写 tombstone 新版本；读取、合并、发布都在 `sync_lease` 内。推送批次被调度回收时不得重排成 FitDays 拉取任务（会登录 FitDays+ 顶掉手机）。FitDays+ 只把主用户写进 HC，FitDays+ 升级后重跑 G-HC3。
- 识图报告（`reports[]`）：手机本机 OCR，请求里只有数字；只挂到同一分钟、体重相同、恰好一组的已入库 HC 称重上，挂上后不可变；只补 HC 没有的指标，不覆盖 HC 值。不要为了“能挂上”放宽匹配（按时间就近、忽略体重），也不要把图片传到服务端识别。解析与交叉校验在 `android/.../report/ReportParser.kt`，请求 JSON 与服务端测试共用 `tests/fixtures/android-report.json`。
- 训练写入：先查收据，再校验，再单个 D1 batch 提交（guard 表 CAS）；约束失败为 not_committed，其他批量错误且查不到收据为 unknown。V1 没有 hard delete，事实表由触发器兜底。
- 手机日历（`src/calendar.ts`）：只读，复用推送令牌（用户 2026-09-16 批准的扩权），只读 `VISIBLE` 快照与当前生效的动作版本，不触发同步；输出不含 `raw_text`，发出前过 `findSecretPath`。响应形状由 `tests/fixtures/calendar-response.json` 钉住，服务端与 Android 单测共用，改字段要同时改两边。手表消耗热量走 `finalize_workout_session` 的 `calories_kcal`，不走 Health Connect。
- 只存本人：`PROFILE_ALLOWLIST` 限定入库的 FitDays 成员（当前 Erika），其他成员和无 suid 的记录在消毒前丢弃。不要为“数据更全”清空它；换人时写 profile_ref，不写原始 suid。事实表唯一的物理删除是用户授权的 `scripts/purge-non-owner-profiles.sql`，已于 2026-09-15 执行。
- 每次同步尝试一个 batch_id；只有持有 lease 的尝试能发布或写错误状态。
- 趋势按请求时区（默认 Asia/Shanghai）自然日：先日中位数，再对有数据日等权平均；派生值逐次先算；bfr≤0 不参与体脂类指标。

## 环境坑

- vitest 用 `@cloudflare/vitest-plugin`（`@cloudflare/vitest-pool-workers` 已改名）；每个测试文件独立存储，同文件内共享 D1，测试用随机 owner 隔离。
- 不要把 MCP SDK 的 Server 引回来：它静态引入 Ajv（`new Function`），会让生产 bundle 违反“无 eval 依赖”。协议层在 `src/mcp.ts` 自己实现并由 Inspector 互通检查覆盖。
- D1 限制 compound SELECT 项数，`UNION ALL` 多了会报 “too many terms”，用标量子查询。
- `wrangler d1 execute --persist-to` 指向含 8.3 短名（`~1`）的路径会报 internal error，用仓库内相对路径。
- 账户没有 workers.dev 子域时 cron 注册失败（10063），Worker 与自定义域名却已上线，容易误以为部署成功；本账户子域为 `erikaalk`。
- FitDays 与 FitDays+ 同一账号只保留最后一次登录的 token，Kinetrail 每次同步都会把用户手机 App 顶下线。`PERIODIC_SYNC` 保持 `off`，不要为了“数据新鲜”打开，也不要自己排队同步；换 client_id 或 os_type 都绕不过（`research/FITDAYSPLUS.md`）。
- 本账户 cron 触发器注册成功但从不投递，定时同步靠 `SyncScheduler` 的 DO alarm。判断调度是否在跑看 Observability 的 `origin=alarm` 与 `event:"scheduler"`；Cloudflare 的 scheduled 分析和“过往 Cron 事件”对它不适用。
- MCP Inspector 在 Windows 的 Node 24 下退出时会崩溃，互通检查固定用 Node 22.23.2。
- Write 工具会把字符串里的 `\u0000` 写成真实 NUL 字节，源码里需要分隔符时用可见字符或确认文件内容。Bash heredoc 会把 `'\n'` 这类转义吃掉，写含反斜杠的代码或文档用 Write/Edit 工具。
- `android/` 的 Gradle 在 Claude Code 进程树里直接跑会报 loopback 连接失败，按 `android/README.md` 用 WMI 拉出进程树并隐藏窗口。
- ML Kit 在报告的衬线字体上会读错形近字（体→休、控→挖、肉→內、龄→齡、抗→坑）、多认一个字（「肌肉均衡」→「肌肉內均衝」）、读错符号（`|`、`%`→`96`、`/1`→`1`、`0`→`o`），还会丢小数点（「157.7%」→「1577%」）。标签比较容忍编辑距离 1，数字按报告固定小数位还原（`ICERUnitConfig.o()` 保证质量/比例/阻抗一位小数、表里体重两位）。改解析前先看两份真实读法：`mlkit-replica-ocr.json`（模拟器 + 近似图）与 `mlkit-real-report-ocr.json`（真机 + FitDays+ 原图）。
- 用 `adb shell am start -a android.intent.action.SEND --eu android.intent.extra.STREAM content://media/...` 模拟分享会因 shell 没有媒体授权报 SecurityException，验证识图改走 App 里的相册选图。Git Bash 里的 adb 路径参数要加 `MSYS_NO_PATHCONV=1`，否则 `/sdcard/...` 会被改写成 Windows 路径。
- Kotlin KDoc 里写 `values*/` 这类含 `*/` 的路径会提前结束注释，编译报一串 “Expecting a top level declaration”。
- 手机插在 VID 2109 的 USB 集线器上时，Windows 能枚举 ADB 接口，但 adb 读序列号报错 31、`adb devices` 为空；直插笔记本 USB 口。ColorOS 上 `adb install` 要在手机上点确认，命令超时不代表失败。
