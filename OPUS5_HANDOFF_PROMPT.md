# 给 Opus 5 的编码提示词

```text
你是 Kinetrail（身迹）的唯一编码与集成负责人，项目目录：
C:/Users/Thinkbook-16p/Workspace/code/Kinetrail

先读项目/全局适用规则，然后完整阅读：
1. FitDays全量数据ChatGPT连接器-技术方案与研究任务书.md
2. ARCHITECTURE_DECISION.md
3. DATA_CONTRACT.md
4. MCP_CONTRACT.md 与 research/mcp-schemas.json
5. IMPLEMENTATION_PLAN.md
6. research/spike-results.json、node-results.json、contract-results.json

本轮研究已完成离线 spike。实现目标是 Cloudflare Worker + D1 + OAuth Provider KV + Access OIDC，Node 22 Docker 是条件回退，不是已验证替代成品。真实 CN、云端容量/恢复、真实 OAuth/CIMD 和“减肥计划”项目两聊天仍是阻断上线的 G1–G5。现有 fixture 全是人工合成，不得称为真实脱敏样本。

先检查目录和 Git 状态。本目录研究时没有 Git/远端；不得覆盖现有用户改动。按 IMPLEMENTATION_PLAN 分阶段实现，每阶段跑 lint、typecheck 和对应单元/集成测试，再进入下一阶段。不要把研究 spike 直接改名为生产服务，worker.mjs 中有合成自动授权入口，严禁部署。

关键已查证：
- fitdays-api 固定 1.0.4、提交 e448d72db0a2f7cea88a4e4a1fd63681b730d7d0。
- fitdays-mcp-server 提交 143207e5c4d32874e14fc09e1742d01370ac8485 仅供参考；入口 stdio，Docker 用 Node 26 + supergateway，不能当现成 Node22 OAuth 服务。
- SDK 公共 request() 可避标准化，但 raw 捕获须在 fetch text 层，避免 JSON.parse 丢大整数；标准 JSON.rawJSON/context.source 已在 Node22/workerd 实测。
- 当前 SDK 没有 loginWithPhone 方法，手机号登录语义未验证。
- 发布 Provider 0.10.3 用 OAUTH_PROVIDER.unwrapToken().scope 校验当前权限，不使用 main 分支未发布 validateToken，也不能使用 grant.props.scopes。

强制约束：
1. FitDays 永远只读。只允许固定 HTTPS origin 下的 login 和 sync 路径，禁止任意 request path/URL 暴露给模型；HTTP redirect manual，JSON302 白名单和跳数限制，有限超时/响应预算。
2. Secrets 仅通过 FITDAYS_LOGIN、FITDAYS_PASSWORD、FITDAYS_REGION 接口。Worker Secret binding 或 Docker /run/secrets/...；禁止普通 .env、聊天、命令行参数、fixture、日志和普通 raw_records。账户 token/refresh token/等价密码/身份信息不得进入模型，包括 _meta。
3. 原始测量未知字段、数值字面量、null/missing/[] 与 ext_data raw/parsed 保真；敏感/未分类内容 fail-closed 并标 partial，不能静默裁剪后宣告完整。附属 orphan/tombstone/旧版本保留。
4. 查询工具只读发布快照，无 refresh_if_stale。refresh_data 使用 body:sync、readOnlyHint=false；训练写使用 workout:write。每个工具的 annotations/securitySchemes 与 tools/list 实际输出一致。
5. 用户明确完成才进入训练事实；到场/start 只建空会话。服务端做结构与语义矛盾检查并保留训练原话审计；不能靠提示词或 completed 布尔值保证。歧义先澄清。
6. open session 支持多轮、跨午夜、多候选明确选择；逐组/有氧数据完整；finalized 追加先显式 reopen。amend 生成新版本并保留旧值；不 hard delete。
7. 所有训练写校验 owner、实际 token.scope、幂等 key、payload hash、expected_revision。原子提交事件/版本/会话/收据；同键重放返回原收据；同键不同参数冲突；D1 CAS 0 rows 必须失败回滚。
8. 只有 committed receipt 能宣称已保存。明确回滚为未持久化；超时为提交状态未知，先查收据或同键重试。不能将 RPC id、openai/session 当可靠操作键。
9. 所有范围/大对象查询有分页、快照 cursor 和字节上限；大 raw 用固定版本分块回取哈希校验，不丢字段。趋势按 Asia/Shanghai 日历和已定公式；不同器械不混为同一强度曲线。
10. 真实鉴权包括 issuer/audience/exp、PKCE、CIMD/静态 client、state/nonce、本人白名单和 scope 降权；不以匿名 URL/API key 替代用户 OAuth。
11. 不省略限流、错误脱敏、stale/coverage、加密备份恢复、许可证/锁文件和 secret scanning。真实日志不打印 err.response/签名 URL。

真实凭据目前未配置，ChatGPT Project 是“减肥计划”，链接待用户在远程 MCP 部署后提供。不询问或展示 Secret 值；需要时只问绑定是否就绪。依次通过 G1–G5，特别必须在项目聊天A实际记录/修订/结束，聊天B不粘贴A内容而从数据库查询回同一事实。记录必要人工选工具/审批步骤。未通过的项目一律明确“未验证”。

如果真实行为和契约冲突，先给最小复现、受影响的不变量和候选修正，再更新决策；不要为了保持既定平台或测试通过而隐藏限制。复杂鉴权/数据路径请独立只读复核，主实现仍只由你写入。每阶段交付实际运行证据和剩余 gate；最后才声明生产完成。
```
