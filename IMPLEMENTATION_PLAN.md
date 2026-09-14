# Kinetrail 实施与验收计划

2026-09-14。Astra 本轮交付离线研究，Opus 5 负责后续实现。真实 Secret 未配置；“减肥计划”项目链接待提供。本计划不构成已部署或已验收声明。

## 交接基线

- 目录：`C:/Users/Thinkbook-16p/Workspace/code/Kinetrail`；当前没有 Git 初始化、分支和远端。原始任务书未改。
- 独立参考：`C:/Users/Thinkbook-16p/Workspace/vendor/fitdays-api` 和 `fitdays-mcp-server`，提交见 ARCHITECTURE_DECISION；参考 checkout 未修改。
- 单一写入负责人：编码阶段由 Opus 5 接手；Astra 审查默认只读。未实际调用 Opus，本轮不推送、不建 PR、不部署。
- 平台：Worker 为实现目标，有条件保留 Node 22 Docker 回退；不得用“真实未验证”误写成 Worker 已通过全量生产验收。
- 依赖锁：`research/spike/package-lock.json` 是测试锁，不等于生产 lock；选择生产依赖时从实际导出 API 验证，不照搬 upstream main 未发布方法。

## 实施进度（2026-09-14，Opus 5）

| 阶段 | 状态 | 验证证据 |
| --- | --- | --- |
| 0 结构与契约闭合 | 完成 | `tests/contract.test.ts`：TS schema 与 `research/mcp-schemas.json` 完全一致；实际 tools/list 的 annotations/securitySchemes；bundle 无 eval |
| 1 fixture 驱动测量链 | 完成（合成数据） | `tests/fitdays.test.ts`、`sanitize.test.ts`、`measurements.test.ts`、`body-tools.test.ts` |
| 2 训练事务与查询 | 完成（workerd D1） | `tests/workouts.test.ts`、`trends.test.ts`；云端 D1 事务未测 |
| 3 真实身份与远程 MCP | 代码完成；合成 IdP 验证 | `tests/auth.test.ts`、`research/production-inspector-results.json`；真实 Access/CIMD/ChatGPT（G3）未验证 |
| 4 真实 CN 与平台容量（G1/G2） | 未开始 | 需要部署与 FitDays Secrets；操作步骤见 `docs/operations.md` 第 3 节 |
| 5 “减肥计划”两聊天（G4/G5） | 未开始 | 需要部署后的 endpoint 与项目链接 |
| 6 部署交付 | 文档与工具完成；未部署 | `docs/operations.md`、`scripts/backup.mjs`/`restore.mjs`/`verify-restore.sql`（本地演练通过）、`THIRD_PARTY_NOTICES.md` |

每个阶段结束都运行了 `npm run check`（lint、typecheck、测试、秘密扫描），并对关键守卫做了变异检查（临时撤掉守卫确认对应测试变红后恢复）。实现阶段的架构变更记录在 ARCHITECTURE_DECISION 文末，契约细化记录在 DATA_CONTRACT 第 7 节与 MCP_CONTRACT 第 7 节。

## 本轮可运行检查

在 `research/spike` 执行（不包含任何真实 Secret）：

```powershell
npm ci --ignore-scripts
npx --yes --package=node@22.23.2 node check.mjs
npx --yes --package=node@22.23.2 node node-http-check.mjs
python core-check.py
```

在项目根目录执行：

```powershell
python research/build-contract.py
```

随后在 spike 目录运行 `node contract-check.mjs`。npm 安装需要网络，测试请求仅使用合成数据与回环服务。运行时日志中的 synthetic OAuth 拒绝是负例；不应出现真实 token。检查将更新 `research/spike-results.json`、`node-results.json`、`contract-results.json`。这些 JSON 记录实际已执行的断言，不是生产验收状态。

`research/spike/worker.mjs` 有仅供合成测试的自动授权路径，主入口限制 localhost + SYNTHETIC_ONLY；**禁止部署、复制到生产或向它注入真实 Secret**。没有 wrangler 配置和线上资源，不能拿该文件当产品入口。训练 SQLite spike 也固定单测试 session，只验证事务语义，不实现所有生产状态选择/语言判别/业务限流。

## 阶段 0：生产结构与契约闭合

预计最小结构：

```text
src/
  index.ts                 Worker 路由与绑定
  auth.ts                  真实 token scope、owner、OIDC consent
  fitdays.ts               SecretReader、受限 fetch、raw 捕获
  measurements.ts          安全筛选、版本与索引、关联
  workouts.ts              原子写入与版本化状态机
  queries.ts               分页与可复现趋势
  tools.ts                 19 个工具注册、schema、中文描述
migrations/
tests/
docs/operations.md
```

按实际逻辑拆文件，不提前做 Repository/Factory/多租户接口层。SecretReader 只是平台边界，不做密码数据库。R2/DO/Queues 不预先引入；refresh 的可靠后台执行方式要在阶段 2 验收，无需排队组件时用持久化 job+scheduled 补偿，不依赖孤立 waitUntil 保证完成。

验收：生产 TS strict、固定依赖 lock、无 eval/unsafe-eval 依赖；MCP descriptors 必须通过实际 tools/list 验证 schema 与 annotations/securitySchemes。若 SDK v1 的注册器不输出顶层 securitySchemes，解决注册层兼容，而不是只修改文档。读工具不刷新。

## 阶段 1：fixture 驱动测量链

实现原始 response text 的有界捕获、测量白名单与敏感字段阻断、数值 lexeme 保真、ext_data 双轨、manifest presence、raw 版本/分块、索引和 orphan 查询。

验收：

1. 未知数值、对象、字符串内 ext_data、超安全整数、malformed ext_data、null/missing/[] 往返不混淆。
2. root/nested/JSON字符串里的合成 token/账号信息被阻断；unknown opaque/suspicious 字符串明确 partial，不伪装已完成采集。秘密只在内存 fixture 生成器中模拟，脱敏输出目录无敏感键值。
3. 新版本保留 first_seen 和旧 raw；tombstone 默认不可见但专家可查；没有返回不等于删除。
4. relation ambiguity/orphan 不误绑；跨 profile/owner 不可查。
5. 大单条、跨页、修订期间 cursor、超大响应拒绝/分块、取回后 SHA-256 一致。
6. SQLite/D1 真实 schema 的 publish 原子性：插入一半失败，查询只见旧批次；fencing 防旧任务覆盖新任务。

## 阶段 2：训练事务与查询

先实现 start/open 查询/record/amend/finalize/reopen/receipt，后实现趋势。用户 raw_text 与解析内容保留；使用可疑/矛盾表达检查和待澄清状态，不用“completed=true”代替判断。

验收矩阵至少包含：

| 场景 | 必须结果 |
| --- | --- |
| 到健身房/开始训练 | 空 open，会话不计完成事实 |
| 已完成三轮汇报 | 同 session，逐组不同重量和有氧完整保留 |
| 相同键相同请求重复/并发 | 一次 effect、同 receipt；无重复业务审计 |
| 同键不同参数 | IDEMPOTENCY_CONFLICT |
| 不同键相同内容 | 不静默吞掉，疑似重复可澄清 |
| 两个不同请求都用旧 revision | 仅一成功，另一冲突，不产生半条记录 |
| 事务中失败 / 提交后断流 | 前者回滚，后者同键查回 receipt |
| 明天计划、建议、引用、否定、混合表达 | 不进入 completed facts，必要时澄清 |
| finalized 追加 | 拒绝，明确 reopen 后才允许 |
| finalized 中纠错 | 新版本，保留旧值及原 finalized 状态 |
| 两个 open、跨午夜、过期未结束、补录昨天 | 按契约选择/澄清，不能自动串场 |
| 只读 token/另一 owner | 拒绝，无数据泄漏 |
| DB 重启后新连接读 | event、entry、receipt 与 revision 一致 |

D1 的最终事务必须在 workerd 和云端各测试一次。事务以约束失败回滚整个 batch，CAS 0 rows 不能当成功。语义唯一性/并发创建必须可复现，不以顺序调用代替并发测试。

趋势验证：固定时区跨午夜和空日、同日多称、fat mass 逐次计算、等日权重、7 日历日均线、上期为 0、器械不混合、空会话不计天数、修订后 current 统计变化且旧审计保留。用固定期望数字断言，不能让测试重写同一公式后自证。

## 阶段 3：真实身份与远程 MCP（G3）

选定域名/平台账户后配置 Access OIDC 与独立 MCP OAuth Provider，创建本人 `(issuer,sub)` 绑定。此阶段不需要把任何 FitDays token 交给模型。

验收：metadata、S256 正/错误 verifier、授权码重放、过期、错误 issuer/audience、撤销、refresh downscope、scope step-up、无效 client/redirect、CIMD SSRF 边界、CSRF/state/nonce、拒绝 consent、rate limit。代理/CDN/平台日志不能记录 token URL/query/body/headers。复制实际 ChatGPT callback 后检查成功与错误的 iss，一致才宣告 RFC 9207 支持。

public read endpoint 仍需 OAuth；静态 API key、client credentials 不作为用户授权替代。若不发 UI，不添加多余 CORS；实际 Browser Inspector 所需 allow/expose headers 最小化。匿名 `/mcp` 返回 401 JSON/challenge，不是 HTML 登录墙。

## 阶段 4：真实 CN 与平台容量（G1/G2）

用户通过平台 Secret 控制台或只读 secret 文件挂载提供：

```text
FITDAYS_LOGIN
FITDAYS_PASSWORD
FITDAYS_REGION
```

不创建普通 .env；不在命令参数、聊天或日志中填值。真实 Secret 读取 helper 只报告是否配置，不打印内容。手机号登录若失败，记录稳定错误码并确认接口，不能猜新 endpoint 暴力试探。

真实检查项：

1. cn 成功登录，统计是否发生 HTTP 或 JSON 302（只报类别，不报签名 URL），目标 origin 先白名单审核。
2. 每列表非空情况、字段路径/类型、稳定 ID 重复数、join 唯一性、unknown/sensitive 字段；脱敏真实 fixture 经自动检查+人工验收。
3. 同一区间拆分窗口与完整窗口集合/hash 比较；端点边界；密集日期截断、分页；同日多次记录。发现疑似截断时不写 verified_window。
4. 编辑/删除观察只等待用户在官方客户端的既有正常操作或获准手动实验；连接器绝不调用 FitDays 写接口。原始任务只读授权不包含替用户改 FitDays。
5. 一次全量和增量结果比较，包括旧记录迟到/修订，确认 overlap 和 reconciliation 周期。
6. token 失效/重登观察；未到失效时间就标未验证，不编造 TTL。
7. 真实 bytes、最大记录、CPU/墙钟/峰值内存、D1 存储量、每批写查询数；以 target plan 限额留裕量，失败则分窗/分块。不可避免超限则启用 Node 回退决策。
8. 失败保持旧已发布快照；synced_at/stale/coverage 不说谎。恢复独立加密备份后核对 hashes、计数、receipt 与权限。

只有 G1/G2/G3 通过，才能把 ARCHITECTURE_DECISION 的状态更新为实际平台通过验收。

## 阶段 5：“减肥计划”两聊天端到端（G4/G5）

等用户提供项目链接和真实 endpoint 后，先用独立 **合成验收数据库/安装**，避免测试训练污染真实历史。生产开启前再做用户授权的真实记录核验。

1. 项目 settings 中加入 MCP_CONTRACT 提供的 instructions；记录当前客户端/账号策略与 tools/list schema hash。
2. 聊天 A：是否必须从工具菜单选 Kinetrail；完成 OAuth；“明天准备深蹲5×5”应不写；“我到健身房了”只建空会话。
3. 在同一聊天用三条明确已完成表达记录力量/有氧；每条保留 receipt ID、revision、使用的 key 和实际工具选择。拒绝授权/工具未启用时不得说已保存。
4. 纠错一组重量，再结束训练，确认历史审计保留旧值。
5. 新建聊天 B：不粘贴聊天 A 内容，选择工具（如需要），查询时间范围历史，核对相同 session/event/revision 和完整组数；查询综合趋势。
6. 在 B 查询 open session/收据并处理模拟响应丢失，同键重试没有重复事件；不同 key 重复不被默默忽略。
7. finalized 后直接追加被拒，显式 reopen 成功。测试两个 open 候选不串场。
8. 分别测试“建议做三组”“其实没做”“朋友做了”“假如做完”“做了两组，第三组明天做”等负例/混合表达。记录模型实际调用，不只检查说明文字。

证据只留必要脱敏片段、选择来源/确认步骤、工具名、receipt/hash、UTC 时间、pass/fail；不保存认证 headers/token/全部聊天。项目记忆不能作为验收依据。无法在新聊天使用时明确记录产品限制，不修改事实数据库来伪装跨聊天成功。

## 阶段 6：部署交付

交付 lint/typecheck/单元/集成通过的固定版本；在最终部署运行 smoke、credential rotation、恢复演练；检查所有生成文件及 fixture 无秘密。保留上游 MIT NOTICE 和全量第三方许可证清单。部署和对外发布按用户明确授权执行，研究交付不自动发布。

最小迁移：先创建新 schema/索引 → 导入到 staged generation → 校验数量/哈希/派生结果 → 发布 generation → 验证查询 → 保留旧版本到恢复期结束；不在一次无回滚 SQL 中覆盖事实。每个阶段出现契约冲突，输出最小复现和证据，再修改契约；禁止静默弱化。

## 最终审核标准

静态说明、mock、SQLite、workerd、云端 D1、真实 FitDays、真实 OAuth、ChatGPT 项目分别记状态。只要 G1–G5 任一未通过，最终报告必须继续写“未验证”，不得写“完整生产交付完成”。
