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

## 1. 组成与数据边界

| 组件 | 内容 | 注意 |
| --- | --- | --- |
| Worker `kinetrail` | `/mcp`、OAuth 端点、`/authorize` `/callback` `/consent`、`/healthz`、cron | `observability.logs.invocation_logs=false`，不记录请求 URL |
| D1 `kinetrail` | 测量 raw 版本与索引、同步批次、训练事件/版本/收据、一次性授权状态、限流计数 | 事实表有禁止删除/改写触发器 |
| KV `OAUTH_KV` | 仅 OAuth Provider 的 client/grant/token | 不存 FitDays 凭据、不存训练事实 |
| Secrets | `FITDAYS_LOGIN` `FITDAYS_PASSWORD` `FITDAYS_REGION` `ACCESS_CLIENT_SECRET` `CURSOR_SIGNING_KEY` | 只用 `wrangler secret put`，不写 `.env`/`.dev.vars`、不放命令参数 |
| Vars（wrangler.jsonc） | `PUBLIC_ORIGIN` `OWNER_ID` `FITDAYS_HISTORY_START` `ACCESS_OIDC_*` `ACCESS_CLIENT_ID` `OWNER_OIDC_SUB` | 非秘密，但 `OWNER_OIDC_SUB` 是身份标识，仓库若公开请改用 secret |

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

## 7. 故障排查

| 现象 / 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `FITDAYS_LOGIN_FAILED` | 凭据缺失、区域非法或上游拒绝登录 | 检查 secrets 是否存在（`wrangler secret list`，不显示值）；在官方 App 确认账户可登录；不要高频重试 |
| `UPSTREAM_ROUTE_DENIED` | 上游返回 HTTP 3xx 或指向非白名单域名的 JSON 302 | 这是安全阻断。确认新域名属于 FitDays 官方后，才在 `src/fitdays.ts` 的 `REGION_ORIGINS` 调整并补测试 |
| `UPSTREAM_TIMEOUT` | 单请求 15 秒 / 整个任务 120 秒超时，已有限重试 | 稍后重试；持续出现时查看是否需要缩小 `SYNC_POLICY.windowSeconds` |
| `INCOMPLETE_SYNC` | 响应非 JSON、超过 32 MiB、业务码非 0、任务被截断 | `wrangler tail` 查看 `event:"sync"` 的 `category`（只含非敏感类别，如 `upstream_code_500`） |
| 批次 `partial` | 有记录被阻断或出现未知数据集 | 按第 3 节查询 `blocked_items`；partial 不推进增量检查点 |
| 读工具 `stale:true` | 15 分钟未成功同步或最近一次同步失败 | 调 `refresh_data`；cron 每 10 分钟处理队列、每 6 小时增量、每 7 天全量 |
| `SYNC_IN_PROGRESS` | 已有任务或处于冷却（增量 60 秒、全量 24 小时） | 按 `retry_after_seconds` 等待 |
| `RATE_LIMITED` / HTTP 429 | `/mcp` 每 owner 120 次 HTTP 请求/分（含 tools/list 等）；工具读 60/分、写 20/分；`/authorize` 10/分/IP、token 20/分 | 等待；异常增长时检查是否有脚本循环调用 |
| `REVISION_CONFLICT` | 会话已被其他写入推进 | 先 `get_open_workout_sessions` 读回 revision，确认内容后用**新**幂等键重写 |
| `COMMIT_STATUS_UNKNOWN` | 提交结果无法确认 | 用同一个 `idempotency_key` 调 `get_write_receipt`，或原样重试；不要换键 |
| `NEEDS_CLARIFICATION` | 原话含计划/建议/假设/否定/他人等表达 | 先向用户确认已完成，再用确认后的原话记录 |
| `SENSITIVE_PAYLOAD_BLOCKED` | 输入或输出里出现邮箱、URL、JWT 等形态 | 训练原话里去掉链接/联系方式；读工具出现说明入库前的阻断有漏洞，需要排查 |
| cron 不运行 | Dashboard → Worker → Triggers 查看 | `wrangler.jsonc` 的 `triggers.crons` 需随部署生效 |

日志只包含 `event/request_id/tool/duration_ms/count/status/code/category`。不要为排查临时打印请求体、上游响应或错误对象。

## 8. 彻底删除

执行前单独确认，不可撤销：

1. Access 应用中删除 Kinetrail 应用；ChatGPT 中移除连接。
2. `npx wrangler delete`（删除 Worker 与其 secrets）。
3. `npx wrangler d1 delete kinetrail`、`npx wrangler kv namespace delete --binding OAUTH_KV`。
4. 删除所有加密备份与私钥。
5. D1 Time Travel 与平台内部保留期内可能仍有副本，删除后等待保留期结束，不能声称单条 SQL 已清除所有副本。

## 验证记录

| 日期 | 范围 | 结论 |
| --- | --- | --- |
| 2026-09-14 | 本地 workerd/Miniflare、合成数据：测量链、训练事务、趋势、合成 OIDC、Inspector 互通、加密备份恢复演练 | 通过 |
| 2026-09-14 | 真实 Access 登录 → 授权确认页 → 点“授权”报“来源校验失败”：页面 `Referrer-Policy: no-referrer` 使浏览器对表单 POST 发 `Origin: null`（线上表单对照实验复现）；确认页改为 `same-origin` 并补回归断言 | 已修复部署，待真实授权复测 |
| 2026-09-14 | 云端首次部署冒烟：`/healthz` 200；匿名 `POST /mcp` 401 且带 `resource_metadata`；AS 元数据只列 `S256`；Access OIDC 发现文档端点与 vars 一致；workers.dev 入口 404；cron `*/10` 已注册 | 通过（未经过真实登录） |
| — | G1 真实 CN | 未验证 |
| — | G2 云端容量/D1 事务/云端恢复 | 未验证 |
| — | G3 真实 Access/CIMD/ChatGPT 回调 | 未验证 |
| — | G4/G5 “减肥计划”双聊天 | 未验证 |
