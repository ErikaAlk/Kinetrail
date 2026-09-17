# Kinetrail 运维手册

适用版本：0.1.0（Cloudflare Worker + D1 + OAuth Provider KV + Access OIDC）。本文命令均在仓库根目录执行，PowerShell / Bash 通用。

> 本人实例 2026-09-14 完成服务端部署、本人绑定并连上 ChatGPT，2026-09-15 起体测改为手机推送；G1–G5 以末尾“验证记录”为准。每完成一项请在本文末尾“验证记录”补上日期与结论。从零部署一套新的按第 2 节。

## 0. 当前线上部署

| 项 | 值 |
| --- | --- |
| 配置 | 账户、域名、资源 ID、Access 地址与本人身份标识不进仓库：真实值在本机 `wrangler.local.jsonc`（git 忽略），其余标识记在本机 `ops.local.md`。**本人实例的 wrangler 命令一律加 `-c wrangler.local.jsonc`**，不加就会读到仓库里的占位符 |
| 账户 | 唯一账户 |
| 入口 | Workers 自定义域名；`workers_dev`/`preview_urls` 关闭 |
| D1 | `kinetrail`，已应用 `0001_init.sql`、`0002_session_calories.sql` |
| KV | `kinetrail-OAUTH_KV` |
| Access for SaaS | 应用 `Kinetrail`，IdP 邮箱验证码，策略“邮箱白名单”，PKCE + client secret |
| 已设 secrets | `ACCESS_CLIENT_SECRET`、`CURSOR_SIGNING_KEY`、`HC_INGEST_TOKEN_SHA256`，以及留作备用的 `FITDAYS_LOGIN`、`FITDAYS_PASSWORD`、`FITDAYS_REGION`（第 9 节末尾） |
| 本人绑定 | `OWNER_OIDC_SUB` 已写入 `wrangler.local.jsonc` 的 vars（邮箱验证码登录得到的 sub；换登录邮箱会得到不同 sub，需重新绑定） |
| 成员范围 | `PROFILE_ALLOWLIST` 只含本人的 FitDays 成员；同一账户下其他 5 个成员与无 suid 的记录不落库，历史数据已于 2026-09-15 物理删除 |
| 定时调度 | Durable Object `SyncScheduler`（SQLite 存储，实例名 `scheduler`）的 alarm 每 10 分钟执行一次；本账户 cron 触发器注册成功但从不投递，`*/10` 仍保留 |
| 同步方式 | `PERIODIC_SYNC=off`：只在 `refresh_data` 排队后由调度执行，不再每 6 小时自动登录。FitDays/FitDays+ 同一账号只保留最后一次登录，每次同步都会把手机 App 顶下线（`research/FITDAYSPLUS.md`）。现在体测由手机经 Health Connect 推送，`refresh_data` 已下线，见第 9 节 |
| 迁移前书签 | D1 Time Travel 书签（2026-09-15T04:09Z，FitDays→FitDays+ 迁移前），记在 `ops.local.md` |

## 1. 组成与数据边界

| 组件 | 内容 | 注意 |
| --- | --- | --- |
| Worker `kinetrail` | `/mcp`、OAuth 端点、`/authorize` `/callback` `/consent`、`/healthz`、`/ingest/health-connect`（设备令牌，见第 9 节）、定时调度（DO alarm，cron 备用） | `observability.logs.invocation_logs=false`，不记录请求 URL |
| D1 `kinetrail` | 测量 raw 版本与索引、同步批次、训练事件/版本/收据、一次性授权状态、限流计数 | 事实表有禁止删除/改写触发器 |
| KV `OAUTH_KV` | 仅 OAuth Provider 的 client/grant/token | 不存 FitDays 凭据、不存训练事实 |
| Secrets | `FITDAYS_LOGIN` `FITDAYS_PASSWORD` `FITDAYS_REGION` `ACCESS_CLIENT_SECRET` `CURSOR_SIGNING_KEY` `HC_INGEST_TOKEN_SHA256` | 只用 `wrangler secret put -c wrangler.local.jsonc`，不写 `.env`/`.dev.vars`、不放命令参数 |
| Vars（wrangler.jsonc） | `PUBLIC_ORIGIN` `OWNER_ID` `FITDAYS_HISTORY_START` `ACCESS_OIDC_*` `ACCESS_CLIENT_ID` `OWNER_OIDC_SUB` `PROFILE_ALLOWLIST` `PERIODIC_SYNC` `HC_ACCEPT_AFTER` `HC_PROFILE_REF` | 非秘密，但 `OWNER_OIDC_SUB` 是身份标识，仓库若公开请改用 secret |

对 FitDays 只调用 `/api/users/login` 与 `/api/sync/syncFromServer`，没有任何写入或删除路径。

## 2. 从零部署

在自己的 Cloudflare 账户里部署一套全新的 Kinetrail，连上 ChatGPT 和手机。按 2.1 到 2.9 的顺序做。

- 一套部署只存一个人的数据。给别人用就让他另部署一套，不要把别人的称重推进你的实例。
- 仓库里的 `wrangler.jsonc` 全是占位符。先复制一份 `wrangler.local.jsonc`（git 忽略），真实值只填在这份里，之后所有 wrangler 命令都加 `-c wrangler.local.jsonc`。
- 这些步骤会创建云资源并对外暴露 HTTPS 端点，执行前确认账户和域名。

### 2.1 准备

| 需要 | 说明 |
| --- | --- |
| Cloudflare 账户 | 必须已经有 workers.dev 子域（在 Workers 页面设置一次即可）。没有的话部署时 cron 触发器报 10063，只部分生效；本 Worker 关闭了 workers.dev 也一样 |
| 域名 | Worker 只走自定义域名（`wrangler.jsonc` 的 `routes`，`custom_domain: true`），这个域名要托管在同一个 Cloudflare 账户里 |
| Cloudflare Zero Trust | 登录靠 Access for SaaS，需要先开通 Zero Trust 组织（团队域名形如 `<team>.cloudflareaccess.com`） |
| 电脑 | Node ≥ 22.12；构建手机 App 另需 Android Studio 自带的 JDK 和 Android SDK（`android/README.md`「构建」） |
| 手机 | Android，带 Health Connect，装有 FitDays+ 并在 FitDays+ 里打开写入 Health Connect。用小米体脂秤 S800 的先看 `docs/xiaomi-s800.md`，目前还不能直接用 |
| ChatGPT | 能打开 Developer mode 的账户（2.7） |

### 2.2 取代码，创建 D1 和 KV

```bash
npm ci
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler login
npx wrangler d1 create kinetrail
npx wrangler kv namespace create OAUTH_KV
```

把输出的 `database_id` 和 KV 的 `id` 填进 `wrangler.local.jsonc`。

### 2.3 改 `wrangler.local.jsonc`

`routes` 里的 `pattern` 改成你的域名，然后逐项改 `vars`：

| 变量 | 新部署填什么 |
| --- | --- |
| `PUBLIC_ORIGIN` | `https://<你的域名>`，不带尾斜杠，和 `routes` 一致 |
| `OWNER_ID` | 保持 `owner`。部署后不要再改，改了已有数据会“换主人” |
| `ACCESS_OIDC_ISSUER`、`ACCESS_OIDC_AUTHORIZATION_ENDPOINT`、`ACCESS_OIDC_TOKEN_ENDPOINT`、`ACCESS_OIDC_JWKS_URL`、`ACCESS_CLIENT_ID` | 2.4 建好 Access 应用后填 |
| `OWNER_OIDC_SUB` | 先保持空字符串 `""`，2.7 再填 |
| `HC_ACCEPT_AFTER` | 只接收晚于这个时刻的称重。新库没有旧数据时，填一个早于你想导入的第一次称重的时间，比如部署当天零点 `2026-09-17T00:00:00+08:00`。App 首次同步最多读回最近 30 天 |
| `HC_PROFILE_REF` | 体测记在哪个成员名下。新库还没有成员，可以自己取一个，建议 `p_` 加 16 位随机十六进制；第一次推送时会建这个成员。之后不要改：库里已有成员时写错，推送会返回 503 |
| `HC_HEIGHT_CM` | 你的身高（cm），用来推算 BMI |
| `PERIODIC_SYNC` | 保持 `off` |
| `PROFILE_ALLOWLIST` | 只影响 FitDays 拉取，目前没有入口会触发。不用 FitDays 就保持 `""` |
| `FITDAYS_HISTORY_START` | 只给 FitDays 拉取用，保持原值 |

改完不用重新生成类型：`worker-configuration.d.ts` 按仓库里的 `wrangler.jsonc` 生成，vars 只有名字和类型。

### 2.4 Cloudflare Access for SaaS（OIDC）

Zero Trust → Access controls → Applications → Create new application → SaaS application → 自定义名称 → OIDC。

- Redirect URL：`<PUBLIC_ORIGIN>/callback`
- 开启 PKCE（Kinetrail 始终发送 S256 challenge）
- 登录方式按自己的情况选，本人实例用邮箱验证码
- Access policy 只允许你本人的邮箱
- 把 Client ID、Issuer、Authorization endpoint、Token endpoint、Key endpoint (JWKS) 填进 2.3 对应的 vars；Client secret 在 2.5 写成 secret

参考：[Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)、[Generic OIDC SaaS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/)

### 2.5 写入 secrets

```bash
npx wrangler secret put ACCESS_CLIENT_SECRET -c wrangler.local.jsonc
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put CURSOR_SIGNING_KEY -c wrangler.local.jsonc
```

- `ACCESS_CLIENT_SECRET` 交互输入，值不会出现在命令行。`CURSOR_SIGNING_KEY` 至少 32 个字符，第二行直接生成随机值并经管道写入，不会显示出来。
- `HC_INGEST_TOKEN_SHA256` 要和手机一起设，放在 2.9。
- `FITDAYS_LOGIN`、`FITDAYS_PASSWORD`、`FITDAYS_REGION` 只有将来要恢复 FitDays 拉取才需要（第 9 节末尾），新部署不用设。

### 2.6 迁移、发布、冒烟

```bash
npm run check
npx wrangler d1 migrations apply kinetrail --remote -c wrangler.local.jsonc
npx wrangler deploy -c wrangler.local.jsonc
```

迁移命令会应用 `migrations/` 下所有还没应用的迁移（目前是 `0001_init.sql`、`0002_session_calories.sql`）。Durable Object `SyncScheduler` 随部署自动创建，不用手动操作。

冒烟：`<PUBLIC_ORIGIN>/healthz` 返回 `{"status":"alive"}`；匿名 `POST /mcp` 返回 401 且带 `resource_metadata`；`/.well-known/oauth-authorization-server` 只列 `S256`。

### 2.7 连接 ChatGPT，绑定本人身份

ChatGPT 的菜单名称按 OpenAI 文档 [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) 写（2026-09-17 核对），界面改版时以文档为准。

1. **打开 Developer mode**：ChatGPT → Settings → Security and login → 打开 Developer mode。普通个人账户自己就能打开。Business、Enterprise 工作区要看工作区策略，管理员没有放开时个人设置里没有这个开关，需要找管理员。
2. **添加插件**：打开 [chatgpt.com/plugins](https://chatgpt.com/plugins) → 加号 → 填名字（比如 Kinetrail）和描述 → Connection 选 Public endpoint，URL 填 `<PUBLIC_ORIGIN>/mcp` → 创建。要选认证方式时选 OAuth。Kinetrail 用 CIMD 识别客户端（`src/index.ts` 的 `clientIdMetadataDocumentEnabled`），不需要预先注册客户端。
3. **第一次登录，拿到 sub**：ChatGPT 会跳到 Cloudflare Access 登录。因为 `OWNER_OIDC_SUB` 还是空的，登录后页面显示「Kinetrail 尚未绑定本人身份」和当前登录身份的 sub，这时不会签发任何授权。确认是自己登录的，把这个 sub 填进 `wrangler.local.jsonc` 的 `OWNER_OIDC_SUB`，再 `npx wrangler deploy -c wrangler.local.jsonc`。以后要一直用同一个登录方式和邮箱，换邮箱登录得到的 sub 不同。
4. **正式授权**：回 ChatGPT 重新连接，再登录一次，出现「授权连接 Kinetrail」页面：
   - 核对「授权后将跳转到」是 ChatGPT 的地址。「客户端自报名称」谁都能填，只作参考。
   - 第一次只申请 `body:read`、`workout:read` 两个只读权限。
   - 点「授权」，回到 ChatGPT 后看一眼工具列表是否正常。
5. **写入权限**：只读授权下，模型第一次写训练会被拒（`INSUFFICIENT_SCOPE`），ChatGPT 会引导重新授权。授权页这次多出 `workout:write`，同意后同一次写入就能成功（2026-09-15 实测，见验证记录）。
6. **建项目**：在 ChatGPT 里新建一个项目（本人的叫「减肥计划」），把 `MCP_CONTRACT.md` 第 6 节的 instructions 粘到项目设置里。那段文字写的是本人的情况（身高、FitDays+ 的称重方式），要改成自己的。
7. **在对话里用**：新对话里点输入框的加号菜单，选 Developer mode，再勾上 Kinetrail。
8. **改了工具以后**：部署新版本后，按 OpenAI 文档在 chatgpt.com/plugins 打开这个连接点 Refresh，确认工具说明已经更新，再开新对话。本人在 Business 工作区里 Refresh 不生效，只能删除插件、重新添加、重新授权（第 4 节第 3 步）；普通个人账户上 Refresh 是否可靠未实测。两种情况都以结果为准：查 D1 里新字段有没有写进去。

授权页的报错：

| 页面提示 | 原因 | 处理 |
| --- | --- | --- |
| 身份提供方尚未配置（503） | `ACCESS_OIDC_*`、`ACCESS_CLIENT_ID` 或 `ACCESS_CLIENT_SECRET` 缺失，或端点不是 https | 补齐后重新部署 |
| Kinetrail 尚未绑定本人身份（403） | `OWNER_OIDC_SUB` 为空 | 按第 3 步绑定 |
| 当前登录的身份无权连接 Kinetrail（403） | 登录身份的 sub 和 `OWNER_OIDC_SUB` 不同，常见原因是换了邮箱 | 用绑定时的邮箱登录，或按第 3 步重新绑定 |
| 授权请求无效或已过期 / 授权会话无效或已过期（400） | 登录超过 10 分钟没完成、授权页停留超过 5 分钟，或浏览器丢了 cookie | 回 ChatGPT 重新连接 |
| 请求过于频繁（429） | `/authorize` 每个 IP 每分钟 10 次 | 等一分钟再试 |

### 2.8 手机 App

1. **填服务端地址**：在 `android/local.properties`（git 忽略，和 `sdk.dir` 同一个文件）加一行 `kinetrail.origin=<你的 PUBLIC_ORIGIN>`。构建时写进 `BuildConfig.KINETRAIL_ORIGIN`，推送和日历共用；没写这行构建直接失败。
2. **构建、安装**：按 `android/README.md`「构建」「安装」两节。手机直插电脑，不要经过 USB 集线器。
3. **授权读取**：打开身迹，底栏「同步」→「读取权限」，把 7 项都授权。

### 2.9 推送令牌，第一次同步

1. 按第 9 节「生成并保存令牌」：生成令牌，把哈希写成 `HC_INGEST_TOKEN_SHA256`，再在手机上身迹「设置」→「推送令牌」里保存。保存后 App 立刻同步一次。
2. 按第 9 节「日常」称一次：先打开 FitDays+ 的测量页再上秤，看到测量动画才会写进 Health Connect。然后打开身迹。
3. 检查：第 9 节「检查」的 SQL 能看到 `health_connect` 批次是 published；身迹的「记录」页能看到这次称重；ChatGPT 里问最近一次体重能答上来。

之后按第 3 节做上线验收。

## 3. 上线验收关卡（未通过前不得称为生产可用）

| 关卡 | 做法 | 通过标准 |
| --- | --- | --- |
| G3 真实 OAuth | 按 2.7 连接 ChatGPT；核对授权页显示的回调地址；分别测试拒绝授权、scope 不足时的重新授权、撤销 | 只有本人能授权；token 过期/撤销后 401；只读 token 调写工具得到 `INSUFFICIENT_SCOPE` 与重新授权提示；日志无 token/code |
| G1 真实 CN | 授权 `body:sync` 后调用 `refresh_data`，再 `get_sync_status` | 见下方 SQL；state 为 published 或 partial 且原因明确；无秘密落库 |
| G2 容量与恢复 | 首次全量耗时、CPU、D1 行数/大小；按第 5 节完成一次加密备份与隔离恢复 | 未触发 Worker/D1 限额；恢复校验全部为 0 |
| G4/G5 “减肥计划”项目 | 按 MCP_CONTRACT 第 6 节写入项目 instructions；聊天 A 记录/纠错/结束，聊天 B 查询 | B 不粘贴 A 内容也能读回同一 session/event/revision；计划类表达未写入 |

G1 检查只看结构，不看值（manifest 只含键名、类型、计数）：

```bash
npx wrangler d1 execute kinetrail --remote --command "SELECT id, mode, state, coverage, error_code, counts_json, manifest_json FROM sync_batches ORDER BY created_at DESC LIMIT 1" -c wrangler.local.jsonc
npx wrangler d1 execute kinetrail --remote --command "SELECT dataset, path, value_type, code, COUNT(*) AS n FROM blocked_items GROUP BY 1,2,3,4" -c wrangler.local.jsonc
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
3. 发布：先 `npx wrangler d1 migrations apply kinetrail --remote -c wrangler.local.jsonc`，再 `npx wrangler deploy -c wrangler.local.jsonc`。改了 MCP 工具的参数或说明时，部署后要让 ChatGPT 重新拿工具定义：本账户在 ChatGPT Business 工作区，工具定义在连接时冻结，插件设置里点 Refresh 再开新对话**不生效**，必须在 ChatGPT 里删除 Kinetrail、重新添加并走一遍 Access 授权，然后开新对话。2026-09-16 部署了 `calories_kcal` 后模型一直看不到它，先把手表消耗写进备注；2026-09-17 点 Refresh、开新对话后仍然不传，重新连接后才写进去。重新连接只动 ChatGPT 侧的连接，服务端数据不受影响。判断有没有生效只能看结果：查 D1 里新字段是否写进去。
4. 回滚代码：`npx wrangler versions list -c wrangler.local.jsonc` → `npx wrangler rollback <version-id> -c wrangler.local.jsonc`。迁移不可自动回滚，所以新代码必须兼容旧 schema，旧代码必须能忽略新增列。
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
npx wrangler d1 execute kinetrail-restore --remote --file restore.sql -c wrangler.local.jsonc
npx wrangler d1 execute kinetrail-restore --remote --file scripts/verify-restore.sql -c wrangler.local.jsonc
```

`verify-restore.sql` 输出的计数与线上对照，完整性检查全部应为 0。确认后才把 `wrangler.local.jsonc` 的 `database_id` 切到恢复库并部署；切换会改变线上数据，执行前单独确认。私钥有口令时用环境变量 `KINETRAIL_BACKUP_PASSPHRASE` 传入。

本地演练（2026-09-14，合成数据）：`wrangler d1 migrations apply kinetrail --local -c wrangler.local.jsonc` → 写入合成训练事实 → `backup.mjs --local` → `restore.mjs` → 导入 `--persist-to .wrangler/restore-drill` → `verify-restore.sql` 计数一致、完整性 0、禁止删除触发器仍生效。加入签名后又演练一次：真实备份验签通过；改动密文 1 字节后验签失败且不输出 SQL；预置的中断残留临时目录被清扫。注意 `--persist-to` 指向 8.3 短路径（含 `~1`）的目录时 wrangler 会报 internal error，使用仓库内相对路径。

## 6. 凭据轮换

| 凭据 | 步骤 | 影响 |
| --- | --- | --- |
| FitDays 密码 | 先在官方 App 改密码，再 `wrangler secret put FITDAYS_PASSWORD -c wrangler.local.jsonc` | 无需改代码或数据库；下一次同步使用新凭据 |
| `ACCESS_CLIENT_SECRET` | Access 应用里轮换 → `wrangler secret put ACCESS_CLIENT_SECRET -c wrangler.local.jsonc` | 只影响新的登录；已签发的 MCP token 不变 |
| `CURSOR_SIGNING_KEY` | `wrangler secret put CURSOR_SIGNING_KEY -c wrangler.local.jsonc` | 已发出的分页游标全部变为 `CURSOR_INVALID`，从第一页重查即可 |
| MCP OAuth token | 需要全部失效时，撤销该用户的 grant（Provider helper `revokeGrant`），或清空 `OAUTH_KV` 中 `grant:`/`token:` 前缀 | ChatGPT 需要重新连接 |
| 备份密钥 | 生成新密钥对，之后的备份用新公钥；旧私钥保留到最后一份旧备份过期 | 旧备份只能用旧私钥解密 |
| Health Connect 推送令牌 | 按第 9 节重新生成：写入新哈希 → 手机上保存新令牌 | 旧令牌立即失效；手机保存新令牌前的同步返回 401，token 不前进，不丢数据 |

## 7. 故障排查

| 现象 / 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `FITDAYS_LOGIN_FAILED` | 凭据缺失、区域非法或上游拒绝登录 | 检查 secrets 是否存在（`wrangler secret list -c wrangler.local.jsonc`，不显示值）；在官方 App 确认账户可登录；不要高频重试 |
| `UPSTREAM_ROUTE_DENIED` | 上游返回 HTTP 3xx 或指向非白名单域名的 JSON 302 | 这是安全阻断。确认新域名属于 FitDays 官方后，才在 `src/fitdays.ts` 的 `REGION_ORIGINS` 调整并补测试 |
| `UPSTREAM_TIMEOUT` | 单请求 15 秒 / 整个任务 120 秒超时，已有限重试 | 稍后重试；持续出现时查看是否需要缩小 `SYNC_POLICY.windowSeconds` |
| `INCOMPLETE_SYNC` | 响应非 JSON、超过 32 MiB、业务码非 0、任务被截断 | `wrangler tail -c wrangler.local.jsonc` 查看 `event:"sync"` 的 `category`（只含非敏感类别，如 `upstream_code_500`） |
| 批次 `partial` | 有记录被阻断或出现未知数据集 | 按第 3 节查询 `blocked_items`；partial 不推进增量检查点 |
| 读工具 `stale:true` | 36 小时没有成功发布，或最近一次尝试失败 | 在手机上打开“身迹”推送；查 Observability 的 `event:"ingest"`。`refresh_data` 已下线，不要为此恢复 FitDays 拉取（会顶掉手机 App 的登录） |
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
2. `npx wrangler delete -c wrangler.local.jsonc`（删除 Worker 与其 secrets）。
3. `npx wrangler d1 delete kinetrail -c wrangler.local.jsonc`、`npx wrangler kv namespace delete --binding OAUTH_KV -c wrangler.local.jsonc`。
4. 删除所有加密备份与私钥。
5. D1 Time Travel 与平台内部保留期内可能仍有副本，删除后等待保留期结束，不能声称单条 SQL 已清除所有副本。

## 9. Health Connect 推送

体测由手机上的“身迹”（`android/`）读取 FitDays+ 写入 Health Connect 的记录，推送到 `POST /ingest/health-connect`。规则见 DATA_CONTRACT 第 8 节与 `research/HEALTHCONNECT.md` 第 3 节。

| 配置 | 位置 | 本人实例 |
| --- | --- | --- |
| `HC_ACCEPT_AFTER` | vars | `2026-09-15T09:17:00+08:00`（旧 FitDays 最后一条测量；不晚于它的 HC 组不入库） |
| `HC_PROFILE_REF` | vars | 本人现有 profile（沿用旧 FitDays 数据的那个，趋势不断档） |
| `HC_HEIGHT_CM` | vars | 本人身高（推算 BMI；FitDays+ 不写 BMI。改身高后只有新产生的版本用新值） |
| `HC_INGEST_TOKEN_SHA256` | secret | 令牌的 SHA-256 小写十六进制；未设置时端点返回 404 |

**生成并保存令牌**（在自己的 PowerShell 7 里运行，令牌只在变量里，不落盘、不进命令历史；先部署带推送端点的代码）：

```powershell
$ingestToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$ingestHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ingestToken))).ToLower()
$ingestHash | npx wrangler secret put HC_INGEST_TOKEN_SHA256 -c wrangler.local.jsonc
# 手机直连电脑，打开“身迹” → 底栏“设置” → 推送令牌，点一下输入框，再运行：
adb shell input text $ingestToken
Remove-Variable ingestToken, ingestHash
```

然后在手机上点“保存”，App 会立刻同步一次。`adb shell input text` 运行期间令牌会短暂出现在手机 shell 的进程参数里。

**日常**：先在 FitDays+ 里打开对应体脂秤的测量页，再站上秤，看到手机上的测量动画——只有这样称的才会写入 Health Connect；不经测量页的称重（秤端缓存后补传）不会进 Kinetrail，与是否联网无关。称完打开“身迹”即自动推送（V1 没有后台任务）。在 FitDays+ 里删除称重不会同步；要从 Kinetrail 去掉误测，到系统 Health Connect 的数据页删除那次的体重记录，再打开 App 同步。

**体测报告**（可选，补齐肌肉、蛋白质、内脏脂肪、分段与阻抗）：在 FitDays+ 的人体成分分析报告页点分享，选“身迹”（或在 App 的同步页“识别报告图片”选相册里的报告图）。手机本机识别，核对页的交叉校验全部通过才能上传；上传前 App 会先同步一次，报告只能挂到 Kinetrail 里已有的那次称重（同一分钟、体重相同）。一次称重的报告写入后不可改：识别错了又已上传，需要按冲突处理的思路单独清理。服务端要先部署支持 `reports[]` 的版本，旧版本会返回 400。

**检查**（只看结构与计数）：

```bash
npx wrangler d1 execute kinetrail --remote --command "SELECT id, state, counts_json, error_code, created_at FROM sync_batches WHERE source_region = 'health_connect' ORDER BY created_at DESC LIMIT 5" -c wrangler.local.jsonc
```

**冲突处理**（App 提示 `HC_GROUP_CONFLICT`）：正常数据不会出现冲突，出现时按令牌泄漏处理。

1. 按第 6 节轮换令牌，阻止继续写入。
2. 找出可疑批次与被占用的时刻（只看结构）：`SELECT id, created_at, counts_json FROM sync_batches WHERE source_region = 'health_connect' ORDER BY created_at DESC LIMIT 20`，再用批次 id 查 `raw_record_versions` 的 `source_record_id` 与 `measured_at`，和手机 HC 里的真实称重对照。
3. 端点无法删除 HC 里不存在的记录，注入的组需要一次性脚本经暂存/发布写 tombstone 版本（或按 `scripts/purge-non-owner-profiles.sql` 的方式物理删除）。两种都会改变线上事实数据，**执行前必须单独征得用户授权**；目前没有现成脚本。
4. 清理后打开 App 重新同步；手机 token 一直未推进，真实数据会补齐。若停住超过 30 天，HC 变更记录过期，App 退回首次同步，期间在 HC 里做的删除需要人工核对。

**FitDays 凭据**：用户决定保留 `FITDAYS_LOGIN`、`FITDAYS_PASSWORD`、`FITDAYS_REGION`（2026-09-15），以便需要时恢复 FitDays+ 拉取。当前没有任何入口会登录 FitDays+：`refresh_data` 已下线、`PERIODIC_SYNC=off`、推送批次不会被重排成拉取任务；只有手工向 `sync_batches` 插入 queued 任务才会触发登录（会顶掉手机）。不再需要时用 `wrangler secret delete -c wrangler.local.jsonc` 删除。

## 10. 手机日历

手机上的“训练日历”从 `GET /app/calendar` 读数据，鉴权用的是第 9 节那个推送令牌，不需要额外配置。规则见 DATA_CONTRACT 第 9 节。

- 点开日期后标题下的「已记录消耗 N 千卡」是当天各训练会话 `calories_kcal` 之和。这个值由模型在 `finalize_workout_session` 时写入（用户把手表截图给模型，模型填 `calories_kcal`），手表数据不经过 Health Connect；没填时写「消耗未记录」。
- 上线顺序：先 `npx wrangler d1 migrations apply kinetrail --remote -c wrangler.local.jsonc`（`0002_session_calories.sql` 加 `workout_sessions.calories_kcal`），再 `npx wrangler deploy -c wrangler.local.jsonc`，最后装 0.4.0 的 APK。旧 Worker 会让日历页报 404，旧 APK 不受新字段影响。
- 令牌泄漏的处置不变，但影响范围更大了：这个令牌现在既能写 HC 体重，也能读出全部体测与训练事实。按第 6 节轮换后，手机上要重新保存令牌。手机还会把看过的月份原样存在 App 的缓存目录里，丢手机时这部分只靠手机锁屏和应用沙箱保护，卸载 App 或清除数据即删除。
- 排查：Observability 里筛 `event:"calendar"`，只有 `status`、`count`、`duration_ms`、错误码，不记日期、数值和令牌。

## 验证记录

| 日期 | 范围 | 结论 |
| --- | --- | --- |
| 2026-09-14 | 本地 workerd/Miniflare、合成数据：测量链、训练事务、趋势、合成 OIDC、Inspector 互通、加密备份恢复演练 | 通过 |
| 2026-09-14 | 真实 Access 登录 → 授权确认页 → 点“授权”报“来源校验失败”：页面 `Referrer-Policy: no-referrer` 使浏览器对表单 POST 发 `Origin: null`（线上表单对照实验复现）；确认页改为 `same-origin` 并补回归断言 | 已修复部署，真实授权复测通过 |
| 2026-09-14 | 云端首次部署冒烟：`/healthz` 200；匿名 `POST /mcp` 401 且带 `resource_metadata`；AS 元数据只列 `S256`；Access OIDC 发现文档端点与 vars 一致；workers.dev 入口 404；cron `*/10` 已注册 | 通过；真实登录见下一行 |
| 2026-09-14 | 真实 Access 邮箱验证码登录 → 授权确认 → ChatGPT 插件连接（含删除重建后重新授权） | 通过；拒绝授权、scope 不足重授权、撤销与过期后 401 由用户 2026-09-17 确认已验证 |
| 2026-09-14 | cron `*/10` 在 14:50–15:20 各窗口均未投递（过期 `auth_pending` 未被清理、无 scheduled 调用，重注册无效）；改为 DO alarm 调度，15:48–次日 00:59 共 55 次 `scheduler ok`、无错误，间隔 10 分钟（1 次 20 分钟） | alarm 调度通过；cron 仍不投递 |
| 2026-09-14 | G1 首次真实 CN 全量（alarm 触发）：18 个窗口，发布 weight 171 / impedance 90 / height 2，共 263 个版本，耗时 10.7 秒；`blocked_items` 0；6 小时后重跑 7 秒、新版本 0。批次 partial，原因是每个窗口都有未登记数据集 `report_list`（当时 manifest 只记名字，2026-09-15 起记结构） | 通过；`report_list` 已确认为空（见 2026-09-15 下一行），关联规则、分窗覆盖由用户 2026-09-17 确认已验证 |
| 2026-09-15 | 手动入队全量（与 `refresh_data` 同规则）取回本人 09:17 新称重：新增 2 个版本（weight + impedance，均属本人）；manifest 显示 `report_list` 在 18 个窗口均为空数组 | 通过 |
| 2026-09-15 | 只存本人：部署 `PROFILE_ALLOWLIST` 后执行 `scripts/purge-non-owner-profiles.sql`。删除前其他成员记录/版本 108（含 p_unknown 6）、昵称 5，本人 157；删除后其他成员 0、本人 157、profiles 仅 1 行；三个保护触发器存在，试删 raw_records 被触发器拒绝 | 通过；D1 Time Travel 保留期内仍有删除前副本 |
| 2026-09-15 | G3 权限不足重授权：旧 token 只有 body:read/workout:read，`record_workout_event` 得 `INSUFFICIENT_SCOPE`；ChatGPT 引导重新授权，consent 授予 3 个 scope 后同一写入成功 | 通过；拒绝授权、撤销、过期 401 由用户 2026-09-17 确认已验证 |
| 2026-09-15 | G4/G5：“减肥计划”聊天 A 补记 9/14 的真实训练，`record_workout_event`（6 个动作）+ `finalize_workout_session`，revision 0→1→2，2 张收据与事件的幂等键和 payload hash 一一对应；未说单位的 ROW 负重保留原值、标 `unknown_load_unit`，未擅自换算。新聊天 B 未粘贴 A 内容，经 `get_workout_history` 读回同一会话的全部组、原话备注与汇总。发现：B 的前 3 次调用传了超过 20 的 limit 被 `INVALID_INPUT` 拒绝（上限只在契约里、工具描述没写，已补描述与测试）；手表整场汇总被记成 `other` 动作（不计入统计，项目指令已补规则） | 通过；计划类表达不写入、到场建空会话、amend 纠错、结束后追加被拒/reopen、超时同键重试由用户 2026-09-17 确认已验证 |
| 2026-09-15 | 顶号排查：FitDays 主账号连续登录 4 次（含 os_type=0/1），每次新登录让旧 token `10000 token无效`；FitDays+ 测试账号同样如此；FitDays+ 账号登不上任何 FitDays 服务器。静态分析 FitDays+ 1.14.1 还原登录/签名/读取请求，测试账号在 plus-cn 登录与读取成功（`research/FITDAYSPLUS.md`） | 顶号为上游单会话策略，无法绕过；已关闭周期同步 |
| 2026-09-15 | Health Connect 核实关卡（手机一加 PJZ110，ColorOS 16.0.10 / Android 16）：G-HC1 FitDays+ 为 Play 安装的 Google 渠道包、dex 与分析样本一致、HC 权限已授予；G-HC2 称重后 HC 出现同一时刻 6 条记录；G-HC3 只有主用户写入；G-HC4 未见重复写入（`research/HEALTHCONNECT.md` 第 5 节） | 通过；晚间更正：只有测量页出现动画的称重才写入 HC，App 内删除的实测无效（见下一行） |
| 2026-09-15 | G-HC4 更正：HC 访问记录显示 FitDays+ 只在 16:54 写入，17:01 的称重（数值相同）HC 与 D1 均无。用户再测两次确认：必须打开 FitDays+ 测量页、站秤出现动画才写入，有动画必写、无动画不写，与飞行模式无关；与静态分析（写 HC 只在测量页的保存请求里，补传路径不调用 HC）一致。App 内删除的实测无法确认删的是哪条，结论改为仅静态分析支撑 | 通过；删除行为见下方「HC 删除线上实测」 |
| 2026-09-15 | 部署 PR #10（main `5a15f52`，版本 `bdbcd4f8`）。冒烟：`/healthz` 200；未设令牌时推送端点 POST/GET 均 404；匿名 `/mcp` 401 带 `resource_metadata`；AS 元数据只列 S256、四个 scope 不变；vars 含 `HC_ACCEPT_AFTER`/`HC_PROFILE_REF`/`HC_HEIGHT_CM`；D1 无 queued/staging 批次。tools/list 18 个未在线上核对（需 OAuth） | 通过 |
| 2026-09-15 | 真机首次推送（用户经 PowerShell 生成令牌并保存）：1 个 `health_connect` 批次 published，新增 2 次测量、拒绝 0；14:22、16:54 两组的体重、体脂、骨量、基础代谢、水分率与手机上的读数一致，BMI 按身高推算；均在本人 profile，profiles 仍 1 行，`last_error_code` 为空 | 通过 |
| 2026-09-15 | 推送端点本地验证：`npm run check` 96 个测试通过；合并不可变、已删不复活、令牌校验、HC 批次不重排四条规则分别临时撤掉后对应测试失败；dry-run bundle 411 KiB、无 `eval`/`new Function`；手机端 0.2.0 构建通过 | 通过；部署与真机推送见下方两行 |
| 2026-09-15 | 第二次真机推送：新增 20:42:50、20:43:44 两次经测量页的称重（两次读数完全相同），批次 published、拒绝 0；14:22、16:54 两组未产生新版本（增量只推变更时刻） | 通过 |
| 2026-09-15 | HC 删除线上实测：用户在系统 Health Connect 删除当天全部 4 组测试称重（非真实数据）后同步，批次 published、`deletions_matched` 24、`deletions_unmatched` 0；4 组各生成 `is_deleted=1` 的新版本（有效记录 0、已删记录 6），旧版本保留。当天 09:17 由旧 FitDays 拉取的称重经用户确认为真实数据，保持不变 | 通过 |
| 2026-09-17 | G2 云端容量/D1 事务/云端恢复 | 通过（用户确认已验证） |
