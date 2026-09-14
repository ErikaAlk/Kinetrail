# Kinetrail（身迹）

私有的体测与训练事实数据库，以远程 MCP 服务器的形式接入 ChatGPT 项目。两条数据链：

- **FitDays 体测**：只读同步到 Kinetrail 镜像，无损保留原始测量字段（含未知字段与数字原文），账户秘密不落库。
- **训练事实**：只记录用户明确报告已完成的训练，逐组/有氧数据、原话、版本化纠错、幂等收据，不物理删除。

## 当前状态（2026-09-14）

| 范围 | 状态 |
| --- | --- |
| 阶段 0–3：Worker 骨架、测量链、训练事务与趋势、Access OIDC + consent | 已实现；本地 workerd 测试 79 项通过 |
| 生产 bundle 与官方 MCP Inspector 互通 | 已验证（合成数据，见 `research/production-inspector-results.json`） |
| 加密 + 签名备份 → 验签解密 → 隔离库恢复 → 校验 | 本地演练通过（含篡改拒绝） |
| 独立审查（Claude 子代理，四轮） | 各轮发现均已修复并有回归测试；第四轮修复后未再送审 |
| 云端部署 `https://kinetrail.erikaalk.click`（D1 迁移、Access OIDC 应用、cron） | 已部署，匿名冒烟通过；本人身份已绑定，FitDays secrets 已设置 |
| G1 真实 FitDays CN、G2 云端容量与恢复、G3 真实 Access/CIMD/ChatGPT、G4/G5 “减肥计划”双聊天 | **未验证** |

未通过 G1–G5 前不是生产可用版本。

## 开发

需要 Node ≥ 22.12。依赖版本全部固定，提交 lockfile。

```bash
npm ci
npm run check
```

`npm run check` 依次运行 Biome lint、TypeScript 类型检查、Vitest（在 workerd 中，D1/KV 为本地模拟）和仓库秘密扫描。单独运行：`npm run lint`、`npm run typecheck`、`npm test`、`npm run scan`。修改 `wrangler.jsonc` 后运行 `npm run types`。

生产 bundle 互通检查（需要网络下载 Node 22.23.2）：

```bash
cd research/spike
npm ci --ignore-scripts
npx --yes --package=node@22.23.2 node production-inspector-check.mjs
```

## 结构

```text
src/
  index.ts         Worker 入口：OAuth Provider、授权页路由、cron
  auth.ts          Access OIDC 本人绑定、consent、JWT 验签
  mcp.ts           无状态 Streamable HTTP（JSON-RPC）、工具注册、scope、限流、信封、输出检查
  schemas.ts       MCP 契约 schema（与 research/mcp-schemas.json 逐项一致）
  tools.ts         19 个工具的中文标题、描述与处理函数
  fitdays.ts       FitDays 只读适配：固定路由、manual redirect、预算、原文捕获
  sanitize.ts      秘密边界：采集阻断/脱敏与输出二次检查
  measurements.ts  测量解析、版本、分块、暂存与原子发布
  sync.ts          同步任务队列、lease/fencing、冷却、cron 补偿
  queries.ts       体测查询、快照游标、分块读取、同步状态
  workouts.ts      训练写入事务与历史查询
  trends.ts        体测趋势 trend_v1、训练趋势 training_v1、同期概览
  cursor.ts        HMAC 签名游标
  ratelimit.ts     D1 原子限流
  util.ts          错误码、摘要、无损 JSON、时区日历、脱敏日志
migrations/        D1 schema（事实表带禁止删除/改写触发器）
tests/             Vitest（workerd）测试
scripts/           秘密扫描、加密备份/恢复、许可证清单
docs/operations.md 部署、验收关卡、升级、备份恢复、凭据轮换、故障排查、彻底删除
research/          Astra 离线研究、契约生成器与互通检查（不是生产代码）
assets/            图标（icon.svg 源文件、icon-512.png 供 ChatGPT 连接器上传）
```

## 文档

- [架构决策](ARCHITECTURE_DECISION.md)、[数据契约](DATA_CONTRACT.md)、[MCP 契约](MCP_CONTRACT.md)、[实施计划](IMPLEMENTATION_PLAN.md)
- [运维手册](docs/operations.md)
- [第三方许可证](THIRD_PARTY_NOTICES.md)

`sanitized-fixtures/` 全部是人工合成数据。`research/spike/worker.mjs` 含合成测试授权入口，禁止部署。
