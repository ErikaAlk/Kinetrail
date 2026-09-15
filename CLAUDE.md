# CLAUDE.md — Kinetrail

个人体测（FitDays 只读）与训练事实的远程 MCP 服务器。Cloudflare Worker + D1 + OAuth Provider(KV) + Access OIDC。契约以 `ARCHITECTURE_DECISION.md`、`DATA_CONTRACT.md`、`MCP_CONTRACT.md` 为准；运维见 `docs/operations.md`。

## 命令

- `npm run check`：lint + typecheck + 测试（workerd）+ 秘密扫描。提交前必须全绿。
- `npm run types`：改 `wrangler.jsonc` 后重新生成 `worker-configuration.d.ts`。
- 契约 schema 改动：先改 `research/build-contract.py` 并运行，再同步 `src/schemas.ts`；`tests/contract.test.ts` 断言两者完全一致。

## 不变量（改动前先确认不会破坏）

- 对 FitDays 只读：`src/fitdays.ts` 只允许固定 origin 的 login/syncFromServer；新增路由或域名必须先有真实证据并补测试。
- 秘密不进 D1 普通记录、日志、MCP 输出：采集走 `sanitize.ts`，读输出与写输入都过 `findSecretPath`。日志只能经 `util.ts` 的 `logEvent` 白名单字段，不打印错误对象、URL、body。
- 未分类的自由字符串 fail-closed（整条不发布、批次 partial），不能为了“同步成功”放宽。
- 查询只读已发布快照（`queries.ts` 的 `VISIBLE`），读工具不触发同步；`refresh_data` 与训练写工具 `readOnlyHint=false`。
- 训练写入：先查收据，再校验，再单个 D1 batch 提交（guard 表 CAS）；约束失败为 not_committed，其他批量错误且查不到收据为 unknown。V1 没有 hard delete，事实表由触发器兜底。
- 只存本人：`PROFILE_ALLOWLIST` 限定入库的 FitDays 成员（当前 Erika），其他成员和无 suid 的记录在消毒前丢弃。不要为“数据更全”清空它；换人时写 profile_ref，不写原始 suid。事实表唯一的物理删除是用户授权的 `scripts/purge-non-owner-profiles.sql`，已于 2026-09-15 执行。
- 每次同步尝试一个 batch_id；只有持有 lease 的尝试能发布或写错误状态。
- 趋势按请求时区（默认 Asia/Shanghai）自然日：先日中位数，再对有数据日等权平均；派生值逐次先算；bfr≤0 不参与体脂类指标。

## 环境坑

- vitest 用 `@cloudflare/vitest-plugin`（`@cloudflare/vitest-pool-workers` 已改名）；每个测试文件独立存储，同文件内共享 D1，测试用随机 owner 隔离。
- 不要把 MCP SDK 的 Server 引回来：它静态引入 Ajv（`new Function`），会让生产 bundle 违反“无 eval 依赖”。协议层在 `src/mcp.ts` 自己实现并由 Inspector 互通检查覆盖。
- D1 限制 compound SELECT 项数，`UNION ALL` 多了会报 “too many terms”，用标量子查询。
- `wrangler d1 execute --persist-to` 指向含 8.3 短名（`~1`）的路径会报 internal error，用仓库内相对路径。
- 账户没有 workers.dev 子域时 cron 注册失败（10063），Worker 与自定义域名却已上线，容易误以为部署成功；本账户子域为 `erikaalk`。
- 本账户 cron 触发器注册成功但从不投递，定时同步靠 `SyncScheduler` 的 DO alarm。判断调度是否在跑看 Observability 的 `origin=alarm` 与 `event:"scheduler"`；Cloudflare 的 scheduled 分析和“过往 Cron 事件”对它不适用。
- MCP Inspector 在 Windows 的 Node 24 下退出时会崩溃，互通检查固定用 Node 22.23.2。
- Write 工具会把字符串里的 `\u0000` 写成真实 NUL 字节，源码里需要分隔符时用可见字符或确认文件内容。
