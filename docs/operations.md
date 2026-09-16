# Kinetrail 运维手册

适用版本：0.1.0（Cloudflare Worker + D1 + OAuth Provider KV + Access OIDC）。本文命令均在仓库根目录执行，PowerShell / Bash 通用。

> 2026-09-14 已完成首次部署第 1–7 步（含本人绑定与全部 secrets）；G1–G5 以末尾“验证记录”为准。每完成一项请在本文末尾“验证记录”补上日期与结论。

## 0. 当前线上部署

| 项 | 值 |
| --- | --- |
| 账户 | `b721713d229cdf4266ab015cbb4c00da`（唯一账户） |
| 入口 | `https://kinetrail.erikaalk.click`（Workers 自定义域名；`workers_dev`/`preview_urls` 关闭） |
| D1 | `kinetrail` / `a5b20e9b-2531-4753-8c00-6774dfe93206`，已应用 `0001_init.sql` |
| KV | `kinetrail-OAUTH_KV` / `30800a8f19c0417aac3121f080ba8850` |
| Access for SaaS | 应用 `Kinetrail`（`d97f5f5e-172c-4443-b65f-0b0e863449d6`），IdP 邮箱验证码，策略“邮箱白名单”（与 dsh 相同的两个邮箱），PKCE + client secret |
| 已设 secrets | `ACCESS_CLIENT_SECRET`、`CURSOR_SIGNING_KEY`、`FITDAYS_LOGIN`、`FITDAYS_PASSWORD`、`FITDAYS_REGION` |
| 本人绑定 | `OWNER_OIDC_SUB` 已写入 vars（邮箱验证码登录得到的 sub；换登录邮箱会得到不同 sub，需重新绑定） |
| 成员范围 | `PROFILE_ALLOWLIST` = `p_914ea14c79915f2f`（FitDays 成员 Erika）；同一账户下其他 5 个成员与无 suid 的记录不落库，历史数据已于 2026-09-15 物理删除 |
| 定时调度 | Durable Object `SyncScheduler`（SQLite 存储，实例名 `scheduler`）的 alarm 每 10 分钟执行一次；本账户 cron 触发器注册成功但从不投递，`*/10` 仍保留 |
| 同步方式 | `PERIODIC_SYNC=off`：只在 `refresh_data` 排队后由调度执行，不再每 6 小时自动登录。FitDays/FitDays+ 同一账号只保留最后一次登录，每次同步都会把手机 App 顶下线（`research/FITDAYSPLUS.md`）。**分支 `feat/hc-reader` 部署后改为手机经 Health Connect 推送、`refresh_data` 下线，见第 9 节** |
| 迁移前书签 | D1 Time Travel `00000070-00000000-000050e7-47b4260ff4c6485eb503dca7bbd6e030`（2026-09-15T04:09Z，FitDays→FitDays+ 迁移前） |

## 1. 组成与数据边界

| 组件 | 内容 | 注意 |
| --- | --- | --- |
| Worker `kinetrail` | `/mcp`、OAuth 端点、`/authorize` `/callback` `/consent`、`/healthz`、`/ingest/health-connect`（设备令牌，见第 9 节）、定时调度（DO alarm，cron 备用） | `observability.logs.invocation_logs=false`，不记录请求 URL |
| D1 `kinetrail` | 测量 raw 版本与索引、同步批次、训练事件/版本/收据、一次性授权状态、限流计数 | 事实表有禁止删除/改写触发器 |
| KV `OAUTH_KV` | 仅 OAuth Provider 的 client/grant/token | 不存 FitDays 凭据、不存训练事实 |
| Secrets | `FITDAYS_LOGIN` `FITDAYS_PASSWORD` `FITDAYS_REGION` `ACCESS_CLIENT_SECRET` `CURSOR_SIGNING_KEY` `HC_INGEST_TOKEN_SHA256` | 只用 `wrangler secret put`，不写 `.env`/`.dev.vars`、不放命令参数 |
| Vars（wrangler.jsonc） | `PUBLIC_ORIGIN` `OWNER_ID` `FITDAYS_HISTORY_START` `ACCESS_OIDC_*` `ACCESS_CLIENT_ID` `OWNER_OIDC_SUB` `PROFILE_ALLOWLIST` `PERIODIC_SYNC` `HC_ACCEPT_AFTER` `HC_PROFILE_REF` | 非秘密，但 `OWNER_OIDC_SUB` 是身份标识，仓库若公开请改用 secret |

对 FitDays 只调用 `/api/users/login` 与 `/api/sync/syncFromServer`，没有任何写入或删除路径。

## 2. 首次部署

以下步骤会创建云资源并对外暴露 HTTPS 端点，执行前确认账户与域名。

1. 登录并创建资源：

   ```bash
   npx wrangler login
   npx wrangler d1 create kinetrail
   npx wrangler kv namespace create OAUTH_KV
   ```

   把输出的 `database_id` 与 KV `id` 替换进 `wrangler.jsonc` 的占位值，然后 `npm run types`。

   账户必须已有 workers.dev 子域（本账户为 `erikaalk`），否则部署时 cron 触发器报 10063、只部分生效；即使本 Worker 关闭了 `workers_dev` 也一样。

2. 设置 vars：`PUBLIC_ORIGIN` 改为实际 HTTPS 源（例如 `https://kinetrail.<子域>.workers.dev`，不带尾斜杠）；`OWNER_ID` 保持稳定（改了会让已有数据“换主人”）；`FITDAYS_HISTORY_START` 设为账户最早测量之前的日期。

3. Cloudflare Access for SaaS（OIDC）：Zero Trust → Access controls → Applications → Create new application → SaaS application → 自定义名称 → OIDC。
   - Redirect URL：`<PUBLIC_ORIGIN>/callback`
   - 开启 PKCE（Kinetrail 始终发送 S256 challenge）
   - Access policy 只允许你本人
   - 复制 Client ID、Client secret、Issuer、Authorization endpoint、Token endpoint、Key endpoint(JWKS) 到对应 vars / secret
   参考：[Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)、[Generic OIDC SaaS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/)

4. 写入 secrets（交互输入，值不会出现在命令行）：

   ```bash
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler secret put CURSOR_SIGNING_KEY
   npx wrangler secret put FITDAYS_LOGIN
   npx wrangler secret put FITDAYS_PASSWORD
   npx wrangler secret put FITDAYS_REGION
   ```

   `CURSOR_SIGNING_KEY` 至少 32 字符的随机串；`FITDAYS_REGION` 为 `cn`。

5. 迁移与发布：

   ```bash
   npm run check
   npx wrangler d1 migrations apply kinetrail --remote
   npx wrangler deploy
   ```

6. 绑定本人身份：`OWNER_OIDC_SUB` 先留空部署一次，浏览器打开 ChatGPT 连接流程（或直接访问 `/authorize` 的完整请求），用 Access 登录后页面会显示**你自己的** `sub`，此时不会签发任何授权。确认后写入 `OWNER_OIDC_SUB` 并重新 `wrangler deploy`。

7. 冒烟：`/healthz` 返回 `{"status":"alive"}`；匿名 `POST /mcp` 返回 401 且带 `resource_metadata`；`/.well-known/oauth-authorization-server` 只列 `S256`。

## 3. 上线验收关卡（未通过前不得称为生产可用）

| 关卡 | 做法 | 通过标准 |
| --- | --- | --- |
| G3 真实 OAuth | ChatGPT 设置 → Security and login → Developer mode → Plugins 添加 `<PUBLIC_ORIGIN>/mcp`；复制界面给出的回调地址核对 CIMD；分别测试拒绝授权、scope 不足时的重新授权、撤销 | 只有本人能授权；token 过期/撤销后 401；只读 token 调写工具得到 `INSUFFICIENT_SCOPE` 与重新授权提示；日志无 token/code |
| G1 真实 CN | 授权 `body:sync` 后调用 `refresh_data`，再 `get_sync_status` | 见下方 SQL；state 为 published 或 partial 且原因明确；无秘密落库 |
| G2 容量与恢复 | 首次全量耗时、CPU、D1 行数/大小；按第 5 节完成一次加密备份与隔离恢复 | 未触发 Worker/D1 限额；恢复校验全部为 0 |
| G4/G5 “减肥计划”项目 | 按 MCP_CONTRACT 第 6 节写入项目 instructions；聊天 A 记录/纠错/结束，聊天 B 查询 | B 不粘贴 A 内容也能读回同一 session/event/revision；计划类表达未写入 |

G1 检查只看结构，不看值（manifest 只含键名、类型、计数）：

```bash
npx wrangler d1 execute kinetrail --remote --command "SELECT id, mode, state, coverage, error_code, counts_json, manifest_json FROM sync_batches ORDER BY created_at DESC LIMIT 1"
npx wrangler d1 execute kinetrail --remote --command "SELECT dataset, path, value_type, code, COUNT(*) AS n FROM blocked_items GROUP BY 1,2,3,4"
```

- `counts_json.excluded`：不在 `PROFILE_ALLOWLIST` 内而被丢弃的记录数。要改成员范围时，先在测试环境算出目标成员的 `profile_ref`（`p_` + SHA-256("profile" + NUL + suid) 前 16 位，与 `src/measurements.ts` 的 `refOf` 一致），只把 profile_ref 写进 vars；扩大范围后需要一次全量同步补齐历史，缩小范围后已入库数据不会自动删除。
- manifest 每个窗口的 `unknownDatasets`：上游出现未登记的数据集时整份不落库，这里只记形态、条数、键名和类型；空数组或 null 不标 partial，有内容才标。据此判断是否为测量数据；确认后在 `src/measurements.ts` 登记（或列入 `NON_MEASUREMENT_KEYS`），补测试，再同步。
- `blocked_items` 有记录：说明真实响应里有未分类的自由字符串，整条记录未发布、批次为 partial。逐个判断字段是否是测量值；确认安全后在 `src/sanitize.ts` 的已知字符串字段表登记，补测试，再同步。
- `JOIN_RULES_VERIFIED`（`src/measurements.ts`）在确认 `imp_data_id/balance_data_id/gravity_data_id` 与各列表 `data_id` 一一对应前保持 `false`，关联状态只报 `unverified`。
- `coverage` 目前只会是 `unknown` 或 `partial`：分窗/截断/端点包含关系核实前不写 `verified_window`。

真实 fixture 需要按 DATA_CONTRACT 第 6 节流程另行生成，禁止直接导出线上表。

## 4. 升级与回滚

1. 本地：`npm ci` → 修改 → `npm run check`（lint、typecheck、测试、秘密扫描）→ 需要时 `node scripts/licenses.mjs` 更新 THIRD_PARTY_NOTICES。
2. 新增迁移放在 `migrations/000N_*.sql`，只做加法（新表、新列、新索引）。不得在迁移里删除或改写事实表数据；需要重建投影时新建表、校验后切换。
3. 发布：先 `npx wrangler d1 migrations apply kinetrail --remote`，再 `npx wrangler deploy`。
4. 回滚代码：`npx wrangler versions list` → `npx wrangler rollback <version-id>`。迁移不可自动回滚，所以新代码必须兼容旧 schema，旧代码必须能忽略新增列。
5. 依赖版本全部固定（`.npmrc save-exact`），升级后必须重跑 `npm audit` 与全部测试；OAuth Provider 升级前核对 `unwrapToken` 语义与发现文档。

## 5. 备份与恢复

D1 Time Travel 只能回到近期时间点（免费 7 天、付费 30 天），不是独立备份。独立备份用加密导出：

```bash
# 生成一次加密密钥对（解密私钥离线保存，不要放进仓库、Worker 或备份机）
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out backup-private.pem
openssl pkey -in backup-private.pem -pubout -out backup-public.pem
# 生成一次签名密钥对（签名私钥只放在执行备份的机器；公钥随恢复流程保存）
openssl genpkey -algorithm ed25519 -out backup-signing.pem
openssl pkey -in backup-signing.pem -pubout -out backup-signing-public.pem

# 每日备份：导出 → AES-256-GCM 加密 → RSA-OAEP 包裹密钥 → Ed25519 签名；--prune 保留最近 30 份与每月最后一份（12 个月）
node scripts/backup.mjs --public-key backup-public.pem --signing-key backup-signing.pem --out <加密备份目录> --prune
```

- 只加密不签名时，拿到公钥的人可以伪造一份能解密的备份；恢复前必须用签名公钥验签，`restore.mjs` 验签失败直接退出。
- 备份脚本临时写出明文 SQL 后覆写删除，并在每次启动时清扫上次中断留下的 `kinetrail-backup-*` 临时目录；覆写不保证在 SSD/快照上物理擦除，请在加密卷上运行。签名私钥有口令时用 `KINETRAIL_SIGNING_PASSPHRASE`。
- 备份目录位置由你决定（本机加密卷 + 离站副本）。计划任务（Windows 任务计划程序 / cron）**尚未配置**。

恢复（永远先恢复到隔离数据库）：

```bash
npx wrangler d1 create kinetrail-restore
node scripts/restore.mjs --backup <file.kbak> --verify-key backup-signing-public.pem --private-key backup-private.pem --out restore.sql
npx wrangler d1 execute kinetrail-restore --remote --file restore.sql
npx wrangler d1 execute kinetrail-restore --remote --file scripts/verify-restore.sql
```

`verify-restore.sql` 输出的计数与线上对照，完整性检查全部应为 0。确认后才把 `wrangler.jsonc` 的 `database_id` 切到恢复库并部署；切换会改变线上数据，执行前单独确认。私钥有口令时用环境变量 `KINETRAIL_BACKUP_PASSPHRASE` 传入。

本地演练（2026-09-14，合成数据）：`wrangler d1 migrations apply kinetrail --local` → 写入合成训练事实 → `backup.mjs --local` → `restore.mjs` → 导入 `--persist-to .wrangler/restore-drill` → `verify-restore.sql` 计数一致、完整性 0、禁止删除触发器仍生效。加入签名后又演练一次：真实备份验签通过；改动密文 1 字节后验签失败且不输出 SQL；预置的中断残留临时目录被清扫。注意 `--persist-to` 指向 8.3 短路径（含 `~1`）的目录时 wrangler 会报 internal error，使用仓库内相对路径。

## 6. 凭据轮换

| 凭据 | 步骤 | 影响 |
| --- | --- | --- |
| FitDays 密码 | 先在官方 App 改密码，再 `wrangler secret put FITDAYS_PASSWORD` | 无需改代码或数据库；下一次同步使用新凭据 |
| `ACCESS_CLIENT_SECRET` | Access 应用里轮换 → `wrangler secret put ACCESS_CLIENT_SECRET` | 只影响新的登录；已签发的 MCP token 不变 |
| `CURSOR_SIGNING_KEY` | `wrangler secret put CURSOR_SIGNING_KEY` | 已发出的分页游标全部变为 `CURSOR_INVALID`，从第一页重查即可 |
| MCP OAuth token | 需要全部失效时，撤销该用户的 grant（Provider helper `revokeGrant`），或清空 `OAUTH_KV` 中 `grant:`/`token:` 前缀 | ChatGPT 需要重新连接 |
| 备份密钥 | 生成新密钥对，之后的备份用新公钥；旧私钥保留到最后一份旧备份过期 | 旧备份只能用旧私钥解密 |
| Health Connect 推送令牌 | 按第 9 节重新生成：写入新哈希 → 手机上保存新令牌 | 旧令牌立即失效；手机保存新令牌前的同步返回 401，token 不前进，不丢数据 |

## 7. 故障排查

| 现象 / 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `FITDAYS_LOGIN_FAILED` | 凭据缺失、区域非法或上游拒绝登录 | 检查 secrets 是否存在（`wrangler secret list`，不显示值）；在官方 App 确认账户可登录；不要高频重试 |
| `UPSTREAM_ROUTE_DENIED` | 上游返回 HTTP 3xx 或指向非白名单域名的 JSON 302 | 这是安全阻断。确认新域名属于 FitDays 官方后，才在 `src/fitdays.ts` 的 `REGION_ORIGINS` 调整并补测试 |
| `UPSTREAM_TIMEOUT` | 单请求 15 秒 / 整个任务 120 秒超时，已有限重试 | 稍后重试；持续出现时查看是否需要缩小 `SYNC_POLICY.windowSeconds` |
| `INCOMPLETE_SYNC` | 响应非 JSON、超过 32 MiB、业务码非 0、任务被截断 | `wrangler tail` 查看 `event:"sync"` 的 `category`（只含非敏感类别，如 `upstream_code_500`） |
| 批次 `partial` | 有记录被阻断或出现未知数据集 | 按第 3 节查询 `blocked_items`；partial 不推进增量检查点 |
| 读工具 `stale:true` | 36 小时没有成功发布，或最近一次尝试失败 | 在手机上打开“身迹同步”推送；查 Observability 的 `event:"ingest"`。`refresh_data` 已下线，不要为此恢复 FitDays 拉取（会顶掉手机 App 的登录） |
| 推送 HTTP 401 | 手机上的令牌与 `HC_INGEST_TOKEN_SHA256` 不符 | 按第 9 节重新生成并保存令牌 |
| 推送 HTTP 503 `not_configured` / `busy` | 缺 `HC_ACCEPT_AFTER`/`HC_PROFILE_REF` 变量，或 `HC_PROFILE_REF` 不在库里已有成员中（日志 `status:"profile_mismatch"`）；`busy` 为 lease 被占用 | 核对变量后部署；`busy` 稍后再同步即可 |
| 推送 200 但 `rejected` 非空 | 逐组拒绝：`HC_BEFORE_CUTOVER`、`HC_FUTURE_TIME`、`HC_VALUE_OUT_OF_RANGE`、`HC_DUPLICATE_TYPE`、`HC_DUPLICATE_GROUP`、`HC_GROUP_WITHOUT_WEIGHT`、`HC_GROUP_CONFLICT` | 截断点之前的历史被拒是预期；`HC_VALUE_OUT_OF_RANGE` 只针对体重（其他指标越界只是索引为 null）。`HC_GROUP_CONFLICT` 表示同一时刻的已存值与手机不一致，正常数据不会出现：App 会停止推进同步进度。轮换令牌只能阻止继续写入，冲突本身来自库里已有的组，按第 9 节“冲突处理”清理后才能恢复 |
| `SYNC_IN_PROGRESS` | 已有任务或处于冷却（增量 60 秒、全量 24 小时） | 按 `retry_after_seconds` 等待 |
| `RATE_LIMITED` / HTTP 429 | `/mcp` 每 owner 120 次 HTTP 请求/分（含 tools/list 等）；工具读 60/分、写 20/分；`/authorize` 10/分/IP、token 20/分 | 等待；异常增长时检查是否有脚本循环调用 |
| `REVISION_CONFLICT` | 会话已被其他写入推进 | 先 `get_open_workout_sessions` 读回 revision，确认内容后用**新**幂等键重写 |
| `COMMIT_STATUS_UNKNOWN` | 提交结果无法确认 | 用同一个 `idempotency_key` 调 `get_write_receipt`，或原样重试；不要换键 |
| `NEEDS_CLARIFICATION` | 原话含计划/建议/假设/否定/他人等表达 | 先向用户确认已完成，再用确认后的原话记录 |
| `SENSITIVE_PAYLOAD_BLOCKED` | 输入或输出里出现邮箱、URL、JWT 等形态 | 训练原话里去掉链接/联系方式；读工具出现说明入库前的阻断有漏洞，需要排查 |
| 定时同步不运行 | 调度由 `SyncScheduler` alarm 负责；Workers Observability 里应每 10 分钟有一条 `origin=alarm`、`{"event":"scheduler","status":"ok"}` | 没有时先访问一次 `/healthz`（每个 isolate 会补上缺失的 alarm，日志 `status:"ensured"`）；`status:"error"` 看 `code`。本账户 cron 注册后从不投递（无 `origin=scheduled` 调用，已重注册无效，社区有同类未解决报告），不要依赖它 |

日志只包含 `event/request_id/tool/duration_ms/count/status/code/category`。不要为排查临时打印请求体、上游响应或错误对象。

## 8. 彻底删除

执行前单独确认，不可撤销：

1. Access 应用中删除 Kinetrail 应用；ChatGPT 中移除连接。
2. `npx wrangler delete`（删除 Worker 与其 secrets）。
3. `npx wrangler d1 delete kinetrail`、`npx wrangler kv namespace delete --binding OAUTH_KV`。
4. 删除所有加密备份与私钥。
5. D1 Time Travel 与平台内部保留期内可能仍有副本，删除后等待保留期结束，不能声称单条 SQL 已清除所有副本。

## 9. Health Connect 推送

体测由手机上的“身迹同步”（`android/`）读取 FitDays+ 写入 Health Connect 的记录，推送到 `POST /ingest/health-connect`。规则见 DATA_CONTRACT 第 8 节与 `research/HEALTHCONNECT.md` 第 3 节。

| 配置 | 位置 | 当前值 |
| --- | --- | --- |
| `HC_ACCEPT_AFTER` | vars | `2026-09-15T09:17:00+08:00`（旧 FitDays 最后一条测量；不晚于它的 HC 组不入库） |
| `HC_PROFILE_REF` | vars | `p_914ea14c79915f2f`（本人现有 profile，趋势不断档） |
| `HC_HEIGHT_CM` | vars | `164`（推算 BMI；FitDays+ 不写 BMI。改身高后只有新产生的版本用新值） |
| `HC_INGEST_TOKEN_SHA256` | secret | 令牌的 SHA-256 小写十六进制；未设置时端点返回 404 |

**生成并保存令牌**（在自己的 PowerShell 7 里运行，令牌只在变量里，不落盘、不进命令历史；先部署带推送端点的代码）：

```powershell
$ingestToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$ingestHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ingestToken))).ToLower()
$ingestHash | npx wrangler secret put HC_INGEST_TOKEN_SHA256
# 手机直连电脑，打开“身迹同步” → 设置 → 推送令牌，点一下输入框，再运行：
adb shell input text $ingestToken
Remove-Variable ingestToken, ingestHash
```

然后在手机上点“保存”，App 会立刻同步一次。`adb shell input text` 运行期间令牌会短暂出现在手机 shell 的进程参数里。

**日常**：先在 FitDays+ 里打开对应体脂秤的测量页，再站上秤，看到手机上的测量动画——只有这样称的才会写入 Health Connect；不经测量页的称重（秤端缓存后补传）不会进 Kinetrail，与是否联网无关。称完打开“身迹同步”即自动推送（V1 没有后台任务）。在 FitDays+ 里删除称重不会同步；要从 Kinetrail 去掉误测，到系统 Health Connect 的数据页删除那次的体重记录，再打开 App 同步。

**体测报告**（可选，补齐肌肉、蛋白质、内脏脂肪、分段与阻抗）：在 FitDays+ 的人体成分分析报告页点分享，选“身迹同步”（或在 App 里“识别报告图片”选相册里的报告图）。手机本机识别，核对页的交叉校验全部通过才能上传；上传前 App 会先同步一次，报告只能挂到 Kinetrail 里已有的那次称重（同一分钟、体重相同）。一次称重的报告写入后不可改：识别错了又已上传，需要按冲突处理的思路单独清理。服务端要先部署支持 `reports[]` 的版本，旧版本会返回 400。

**检查**（只看结构与计数）：

```bash
npx wrangler d1 execute kinetrail --remote --command "SELECT id, state, counts_json, error_code, created_at FROM sync_batches WHERE source_region = 'health_connect' ORDER BY created_at DESC LIMIT 5"
```

**冲突处理**（App 提示 `HC_GROUP_CONFLICT`）：正常数据不会出现冲突，出现时按令牌泄漏处理。

1. 按第 6 节轮换令牌，阻止继续写入。
2. 找出可疑批次与被占用的时刻（只看结构）：`SELECT id, created_at, counts_json FROM sync_batches WHERE source_region = 'health_connect' ORDER BY created_at DESC LIMIT 20`，再用批次 id 查 `raw_record_versions` 的 `source_record_id` 与 `measured_at`，和手机 HC 里的真实称重对照。
3. 端点无法删除 HC 里不存在的记录，注入的组需要一次性脚本经暂存/发布写 tombstone 版本（或按 `scripts/purge-non-owner-profiles.sql` 的方式物理删除）。两种都会改变线上事实数据，**执行前必须单独征得用户授权**；目前没有现成脚本。
4. 清理后打开 App 重新同步；手机 token 一直未推进，真实数据会补齐。若停住超过 30 天，HC 变更记录过期，App 退回首次同步，期间在 HC 里做的删除需要人工核对。

**FitDays 凭据**：用户决定保留 `FITDAYS_LOGIN`、`FITDAYS_PASSWORD`、`FITDAYS_REGION`（2026-09-15），以便需要时恢复 FitDays+ 拉取。当前没有任何入口会登录 FitDays+：`refresh_data` 已下线、`PERIODIC_SYNC=off`、推送批次不会被重排成拉取任务；只有手工向 `sync_batches` 插入 queued 任务才会触发登录（会顶掉手机）。不再需要时用 `wrangler secret delete` 删除。

## 10. 手机日历

手机上的“训练日历”从 `GET /app/calendar` 读数据，鉴权用的是第 9 节那个推送令牌，不需要额外配置。规则见 DATA_CONTRACT 第 9 节。

- 日期下的小字是当天各训练会话 `calories_kcal` 之和。这个值由模型在 `finalize_workout_session` 时写入（用户把手表截图给模型，模型填 `calories_kcal`），手表数据不经过 Health Connect；没填就没有小字。
- 上线顺序：先 `npx wrangler d1 migrations apply kinetrail --remote`（`0002_session_calories.sql` 加 `workout_sessions.calories_kcal`），再 `npx wrangler deploy`，最后装 0.4.0 的 APK。旧 Worker 会让日历页报 404，旧 APK 不受新字段影响。
- 令牌泄漏的处置不变，但影响范围更大了：这个令牌现在既能写 HC 体重，也能读出全部体测与训练事实。按第 6 节轮换后，手机上要重新保存令牌。
- 排查：Observability 里筛 `event:"calendar"`，只有 `status`、`count`、`duration_ms`、错误码，不记日期、数值和令牌。

## 验证记录

| 日期 | 范围 | 结论 |
| --- | --- | --- |
| 2026-09-14 | 本地 workerd/Miniflare、合成数据：测量链、训练事务、趋势、合成 OIDC、Inspector 互通、加密备份恢复演练 | 通过 |
| 2026-09-14 | 真实 Access 登录 → 授权确认页 → 点“授权”报“来源校验失败”：页面 `Referrer-Policy: no-referrer` 使浏览器对表单 POST 发 `Origin: null`（线上表单对照实验复现）；确认页改为 `same-origin` 并补回归断言 | 已修复部署，真实授权复测通过 |
| 2026-09-14 | 云端首次部署冒烟：`/healthz` 200；匿名 `POST /mcp` 401 且带 `resource_metadata`；AS 元数据只列 `S256`；Access OIDC 发现文档端点与 vars 一致；workers.dev 入口 404；cron `*/10` 已注册 | 通过（未经过真实登录） |
| 2026-09-14 | 真实 Access 邮箱验证码登录 → 授权确认 → ChatGPT 插件连接（含删除重建后重新授权） | 成功；拒绝授权、scope 不足重授权、撤销与过期后 401 未测 |
| 2026-09-14 | cron `*/10` 在 14:50–15:20 各窗口均未投递（过期 `auth_pending` 未被清理、无 scheduled 调用，重注册无效）；改为 DO alarm 调度，15:48–次日 00:59 共 55 次 `scheduler ok`、无错误，间隔 10 分钟（1 次 20 分钟） | alarm 调度通过；cron 仍不投递 |
| 2026-09-14 | G1 首次真实 CN 全量（alarm 触发）：18 个窗口，发布 weight 171 / impedance 90 / height 2，共 263 个版本，耗时 10.7 秒；`blocked_items` 0；6 小时后重跑 7 秒、新版本 0。批次 partial，原因是每个窗口都有未登记数据集 `report_list`（当时 manifest 只记名字，2026-09-15 起记结构） | 部分通过：待分类 `report_list`；关联规则、分窗覆盖未核实 |
| 2026-09-15 | 手动入队全量（与 `refresh_data` 同规则）取回本人 09:17 新称重：新增 2 个版本（weight + impedance，均属 Erika）；manifest 显示 `report_list` 在 18 个窗口均为空数组 | 通过 |
| 2026-09-15 | 只存本人：部署 `PROFILE_ALLOWLIST` 后执行 `scripts/purge-non-owner-profiles.sql`。删除前其他成员记录/版本 108（含 p_unknown 6）、昵称 5，本人 157；删除后其他成员 0、本人 157、profiles 仅 1 行；三个保护触发器存在，试删 raw_records 被触发器拒绝 | 通过；D1 Time Travel 保留期内仍有删除前副本 |
| 2026-09-15 | G3 权限不足重授权：旧 token 只有 body:read/workout:read，`record_workout_event` 得 `INSUFFICIENT_SCOPE`；ChatGPT 引导重新授权，consent 授予 3 个 scope 后同一写入成功 | 通过；拒绝授权、撤销、过期 401 仍未测 |
| 2026-09-15 | G4/G5（部分）：“减肥计划”聊天 A 补记 9/14 的真实训练，`record_workout_event`（6 个动作）+ `finalize_workout_session`，revision 0→1→2，2 张收据与事件的幂等键和 payload hash 一一对应；未说单位的 ROW 负重保留原值、标 `unknown_load_unit`，未擅自换算。新聊天 B 未粘贴 A 内容，经 `get_workout_history` 读回同一会话的全部组、原话备注与汇总。发现：B 的前 3 次调用传了超过 20 的 limit 被 `INVALID_INPUT` 拒绝（上限只在契约里、工具描述没写，已补描述与测试）；手表整场汇总被记成 `other` 动作（不计入统计，项目指令已补规则） | 部分通过；计划类表达不写入、到场建空会话、amend 纠错、结束后追加被拒/reopen、超时同键重试均未测 |
| 2026-09-15 | 顶号排查：FitDays 主账号连续登录 4 次（含 os_type=0/1），每次新登录让旧 token `10000 token无效`；FitDays+ 测试账号同样如此；FitDays+ 账号登不上任何 FitDays 服务器。静态分析 FitDays+ 1.14.1 还原登录/签名/读取请求，测试账号在 plus-cn 登录与读取成功（`research/FITDAYSPLUS.md`） | 顶号为上游单会话策略，无法绕过；已关闭周期同步 |
| 2026-09-15 | Health Connect 核实关卡（手机一加 PJZ110，ColorOS 16.0.10 / Android 16）：G-HC1 FitDays+ 为 Play 安装的 Google 渠道包、dex 与分析样本一致、HC 权限已授予；G-HC2 称重后 HC 出现同一时刻 6 条记录；G-HC3 只有主用户写入；G-HC4 未见重复写入（`research/HEALTHCONNECT.md` 第 5 节） | 通过；晚间更正：只有测量页出现动画的称重才写入 HC，App 内删除的实测无效（见下一行） |
| 2026-09-15 | G-HC4 更正：HC 访问记录显示 FitDays+ 只在 16:54 写入，17:01 的称重（数值相同）HC 与 D1 均无。用户再测两次确认：必须打开 FitDays+ 测量页、站秤出现动画才写入，有动画必写、无动画不写，与飞行模式无关；与静态分析（写 HC 只在测量页的保存请求里，补传路径不调用 HC）一致。App 内删除的实测无法确认删的是哪条，结论改为仅静态分析支撑 | 写入条件已确认；删除行为待补测 |
| 2026-09-15 | 部署 PR #10（main `5a15f52`，版本 `bdbcd4f8`）。冒烟：`/healthz` 200；未设令牌时推送端点 POST/GET 均 404；匿名 `/mcp` 401 带 `resource_metadata`；AS 元数据只列 S256、四个 scope 不变；vars 含 `HC_ACCEPT_AFTER`/`HC_PROFILE_REF`/`HC_HEIGHT_CM=164`；D1 无 queued/staging 批次。tools/list 18 个未在线上核对（需 OAuth） | 通过 |
| 2026-09-15 | 真机首次推送（用户经 PowerShell 生成令牌并保存）：1 个 `health_connect` 批次 published，新增 2 次测量、拒绝 0；14:22 组 weight 63.1 / body_fat 19 / bone 3.4 / bmr 1473 / body_water_pct 59.4 / bmi 23.5，16:54 组 63.05 / 18.4 / bmi 23.4；均在 `p_914ea14c79915f2f`，profiles 仍 1 行，`last_error_code` 为空 | 通过 |
| 2026-09-15 | 推送端点本地验证：`npm run check` 96 个测试通过；合并不可变、已删不复活、令牌校验、HC 批次不重排四条规则分别临时撤掉后对应测试失败；dry-run bundle 411 KiB、无 `eval`/`new Function`；手机端 0.2.0 构建通过 | 通过；未部署，真机推送未测 |
| 2026-09-15 | 第二次真机推送：新增 20:42:50、20:43:44 两次经测量页的称重（均 63.9 kg / 19.3% / BMI 23.8），批次 published、拒绝 0；14:22、16:54 两组未产生新版本（增量只推变更时刻） | 通过 |
| 2026-09-15 | HC 删除线上实测：用户在系统 Health Connect 删除当天全部 4 组测试称重（非真实数据）后同步，批次 published、`deletions_matched` 24、`deletions_unmatched` 0；4 组各生成 `is_deleted=1` 的新版本（有效记录 0、已删记录 6），旧版本保留。当天 09:17 由旧 FitDays 拉取的称重经用户确认为真实数据，保持不变 | 通过 |
| — | G2 云端容量/D1 事务/云端恢复 | 未验证 |
