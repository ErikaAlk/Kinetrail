# Kinetrail（身迹）

私有的体测与训练事实数据库，以远程 MCP 服务器的形式接入 ChatGPT 项目。两条数据链：

- **体测**：手机上的“身迹”读取 FitDays+ 写入 Health Connect 的称重推送上来，可以再用报告图片补齐指标；无损保留原始记录，账户秘密不落库。早期从 FitDays 只读拉取的历史数据仍在库里。
- **训练事实**：只记录用户明确报告已完成的训练，逐组/有氧数据、原话、版本化纠错、幂等收据，不物理删除。

手机端 `android/`（“身迹”）把体测从 Health Connect 推上来，并提供一个日历界面：日期下用图标标出训练和称重，点开看当天的消耗、逐组训练和体脂秤读数。

从零部署一套、连上 ChatGPT 和手机：[`docs/operations.md`](docs/operations.md) 第 2 节。

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
  index.ts         Worker 入口：OAuth Provider、授权页路由、SyncScheduler（DO alarm）与 cron
  auth.ts          Access OIDC 本人绑定、consent、JWT 验签
  mcp.ts           无状态 Streamable HTTP（JSON-RPC）、工具注册、scope、限流、信封、输出检查
  schemas.ts       MCP 契约 schema（与 research/mcp-schemas.json 逐项一致）
  tools.ts         18 个工具的中文标题、描述与处理函数
  ingest.ts        Health Connect 推送入口：设备令牌、严格校验、合并与识图报告
  calendar.ts      手机日历的只读入口（GET /app/calendar），与推送共用设备令牌
  fitdays.ts       FitDays 只读适配：固定路由、manual redirect、预算、原文捕获
  sanitize.ts      秘密边界：采集阻断/脱敏与输出二次检查
  measurements.ts  测量解析、版本、分块、暂存与原子发布
  sync.ts          同步任务队列、lease/fencing、冷却、定时补偿
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
assets/            图标（icon.svg 源文件、icon-256.png 供 ChatGPT 连接器上传，限 PNG ≤10 KB）
```

## 文档

- [架构决策](ARCHITECTURE_DECISION.md)、[数据契约](DATA_CONTRACT.md)、[MCP 契约](MCP_CONTRACT.md)、[实施计划](IMPLEMENTATION_PLAN.md)
- [运维手册](docs/operations.md)
- [第三方许可证](THIRD_PARTY_NOTICES.md)、[Android App 第三方声明](android/THIRD_PARTY_NOTICES.md)

`sanitized-fixtures/` 全部是人工合成数据。`research/spike/worker.mjs` 含合成测试授权入口，禁止部署。测试与样本里的体测读数都是合成值。

## 协议

[PolyForm Noncommercial License 1.0.0](LICENSE.md)。非商业目的可以使用、修改和分发，包括个人学习研究、兴趣项目，以及慈善组织、教育和公共研究机构、政府机构使用；任何商业用途都不在授权范围内。它不是 OSI 定义的开源协议。第三方组件保留各自的协议，见上面两份第三方声明。
