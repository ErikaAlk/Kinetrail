# Kinetrail MCP 契约 v1

2026-09-14，离线定案。机器可读 input/output schemas 在 [research/mcp-schemas.json](research/mcp-schemas.json)，由 `research/build-contract.py` 生成；文件是契约容器，不是可直接注册的 tools/list 响应。实现前把 `$defs` 内联/解析到每个 descriptor，补中文 title/description。不能把包含未解析外部引用的契约直接交给宿主。

## 1. Transport、发现与权限

目标为 HTTPS `/mcp`，Streamable HTTP，初始化协商双方支持的版本，不盲目把 authorization 文档日期当成协商成功的协议版本。V1 无会话推送需求，采用 stateless transport、JSON 响应；GET 可返回 405，不能返回空 SSE 长连接却无人管理。MCP session ID 不是训练 session_id。生产每个 HTTP 请求都要鉴权。

未认证：401 + `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="body:read"`。过期/无效 token 同样 401，不泄漏细节。有效 token scope 不足：403 + `error="insufficient_scope"` 和当前工具所需 scope；工具级重连还提供 `_meta["mcp/www_authenticate"]`，`isError:true`。业务错误通过工具结果返回，协议 malformed request 才使用 JSON-RPC error。

服务端验证：固定 issuer、resource audience、有效期、当前 token.scope、owner。opaque token 用 Provider 验证，不用 JWT decode 冒充验签；上游 OIDC 用标准验证器。所有工具不可指定 owner；profile/session/entry/chunk/cursor 均再次按授权 owner 查询。资源枚举错误统一 NOT_FOUND，避免跨 owner 信息泄漏。

首连仅申请 `body:read`、`workout:read`；刷新需 `body:sync`，训练写需 `workout:write`。AS 支持四个 scopes，基础 resource metadata/challenge 仅列最小只读需要，写入时 step-up。实际 ChatGPT step-up UX 未验证。Annotations 是提示，不是权限控制。[OpenAI Authentication](https://developers.openai.com/plugins/build/auth)、[MCP 授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### 工具表

R/D/I/O = readOnlyHint/destructiveHint/idempotentHint/openWorldHint。每个 descriptor 都给 `securitySchemes:[{type:"oauth2",scopes:[...]}]`，兼容 `_meta.securitySchemes` 同步，不提供 noauth 分支。SDK 注册器若丢弃顶层 securitySchemes，必须在输出序列化层验证并补齐，不能只测内存配置。

| 工具 | scope | R/D/I/O | 语义 |
| --- | --- | --- | --- |
| get_latest_measurement_full | body:read | T/F/T/F | 最新有效完整记录；无数据 empty；不刷新 |
| get_measurements | body:read | T/F/T/F | summary 默认，full 分页 |
| get_raw_dataset | body:read | T/F/T/F | 八个测量数据集白名单 |
| get_raw_record_chunk | body:read | T/F/T/F | 大 raw 按 immutable version 分块读取 |
| get_trend | body:read | T/F/T/F | 按本地日中位数再聚合 |
| get_sync_status | body:read | T/F/T/F | 同步/覆盖/陈旧状态 |
| list_profiles / list_devices | body:read | T/F/T/F | 分页最小投影 |
| refresh_data | body:sync | F/T/F/F | 启动/推进同步，写本地镜像，不写 FitDays |
| get_open_workout_sessions | workout:read | T/F/T/F | 找到跨聊天可选 open sessions |
| get_workout_history | workout:read | T/F/T/F | 已完成事实及可选旧版本审计 |
| get_training_trend | workout:read | T/F/T/F | 器械隔离的训练指标 |
| get_progress_overview | body:read + workout:read | T/F/T/F | 同窗对照，不声称因果 |
| get_write_receipt | workout:read | T/F/T/F | 查提交结果，解决响应丢失 |
| start_workout_session | workout:write | F/F/T/F | 建空 open 会话，不记训练完成 |
| record_workout_event | workout:write | F/F/T/F | 原子新增完成事实，必要时建会话 |
| finalize_workout_session | workout:write | F/T/T/F | 结束当前会话 |
| reopen_workout_session | workout:write | F/T/T/F | 显式重开 |
| amend_workout_entry | workout:write | F/T/T/F | 新 revision，保留旧值，可撤回事实但不 hard delete |

`destructiveHint:true` 对 refresh/finalize/reopen/amend 是保守设计选择：它们改变当前有效状态，即便保留历史。新增 record/start 属 additive。不能凭“没有 DELETE”就将所有修改标非破坏。`openWorldHint:false` 是因为只访问固定私有账户/库，并不因为云托管而变 true；不接受工具参数指定任意 URL。[OpenAI 工具设计](https://developers.openai.com/plugins/plan/tools)、[ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)

明确移除任务书的 `get_latest_measurement_full.refresh_if_stale`。查询只读 mirror；模型需要新数据时先调用 refresh_data，再查询。普通访问日志不改变业务事实；不为了 read 添加 last_access 写库。

## 2. 输入、输出和默认值

JSON Schema 的缺失字段为“未提供”，不默认写成 null/0；所有 command 输入 `additionalProperties:false`。未知测量字段只存在 raw_json 内，不借训练 input 宽类型引入任意内容。关联、范围、语义互斥及权限校验仍在服务端，不能仅靠 JSON Schema。

共同约定：

- `start/end` RFC3339 带 offset，半开 `[start,end)`，必须 start<end；日期口语先按 timezone 转换，服务器不猜宿主时区。
- `timezone` 默认 Asia/Shanghai，验证真实 IANA 时区；`profile_ref` 未提供且存在多个人时返回 PROFILE_REQUIRED。
- summary 默认 limit=50，最多 200；full 默认 10，最多 25（即便通用 schema 上限为 200，按 detail 再校验）；raw 默认 25，最多 100。Workout 一页至多 20 sessions/100 entries，子集合未完用条目级游标继续，不隐性裁掉剩余组。
- MCP 序列化总响应上限 256 KiB，请求上限 64 KiB；范围查询默认允许最大 366 天，较长区间分窗；trend 最多 366 日/104 周/60 月。limit 与字节上限先到者生效。
- raw/聚合单条超过上限：返回 version/chunk_ref、`complete:false`，不声称已经返回完整记录。get_raw_record_chunk 单块至多 24 KiB 原字节，base64 ≤32768 字符，含完整及分块 SHA-256；不返回签名下载 URL，不把 token 放 URI。
- `refresh_data.mode` 默认 incremental；返回 job_id 和 queued/running/completed。queued 只表示已接受任务，不是“FitDays 数据已更新”；get_sync_status 查批次结论。开始前检查冷却/lease，拒绝无界重复全量。
- 同步 stale 判定候选 15 分钟或最近失败；是产品阈值，不是上游有效期。body reads 返回 synced_at；训练事务读应立即读取主库，不缓存陈旧结果。
- record 每次最多 20 entries、每 entry 100 sets，raw_text 最多 4096 字；超出分批用不同键，明确每批结果。未填重量/时长不阻塞已明确完成事实。
- `load_value` 有值须有 load_unit；distance/speed 同理。必须至少一个实际已完成动作/组/segment 依据，空对象 set 不得作为事实；负次数/NaN/Infinity/未来完成时间冲突拒绝。日期可补录但不能未来冒充过去。

所有输出是 `structuredContent` + 简短中文 `content`；outputSchema 与 structuredContent 一致。不把敏感值藏在 `_meta`：那里同样不能放 FitDays 秘密。[OpenAI 工具元数据](https://developers.openai.com/plugins/reference)

统一结构（详细 data 类型见 JSON Schema）：

```json
{
  "schema_version":"1",
  "request_id":"server-request-id",
  "status":"ok",
  "data":{},
  "error":null,
  "stale":false,
  "synced_at":null,
  "next_cursor":null,
  "persistence":"not_applicable"
}
```

成功 write 的 persistence 必须为 committed，data 为 receipt（refresh 的 data 为 job 状态）；若业务未提交返回 error/isError，data=null。status=empty 的只读结果 data=null。空列表也可 ok+[]，实现保持一致。Schema 接受的组合还须规则检查：ok 时 error=null；error 时 error 非空；训练 committed 时必须有 event/session/revision/committed_at 收据，不能出现 committed+error。

### 记录示例

```json
{
  "session_id":"session-from-query",
  "expected_revision":2,
  "idempotency_key":"5d5126d1-f274-4b10-b8e4-6ac6003b579d",
  "occurred_at":"2026-09-14T18:20:00+08:00",
  "timezone":"Asia/Shanghai",
  "raw_text":"我已完成高位下拉45kg，12、12、10次",
  "completion":"completed",
  "entries":[{
    "exercise_name_raw":"高位下拉",
    "category":"strength",
    "equipment_label":"器械A",
    "sets":[
      {"load_value":45,"load_unit":"kg","reps":12},
      {"load_value":45,"load_unit":"kg","reps":12},
      {"load_value":45,"load_unit":"kg","reps":10}
    ]
  }]
}
```

成功 data 包含 `session_id,event_id,entry_ids,revision=3,committed_at,idempotency_key`。发生修正时 amend 输入完整 replacement 和 expected_revision=3；服务端产生 revision=4，不能就地修改原事件。

## 3. 分页与一致性

keyset cursor 由服务端签名，绑定 owner、tool、查询参数 hash、排序 `(measured_at,record_ref,version_ref)`、已发布 generation、过期时间。禁止裸 OFFSET 和只按 measured_time 排序。数据修订期间继续旧 cursor 读同一个快照，不重不漏；cursor 过期返回 CURSOR_EXPIRED，明确从头重查。raw 大对象分块固定 version hash，不能下载一半换到新版本。

full measurement 关联项数量过多时给关系续页引用；workout entry 过多时按 entry 排序返回同一 session continuation，不能重复汇总计数。最终 outputSchema 要显式实现 continuation 类型；不能只因为 page.size 没超限就忽略嵌套体积。D1 初版不启用 read replicas，避免新聊天立刻读到旧版本；若启用，须 primary-first/书签语义验证。

## 4. 幂等、并发与结果确认

宿主公开的 openai/subject、openai/session、organization 不等于业务操作 ID；JSON-RPC id 也不担保跨重试唯一性。不要从工具调用 id 构造永恒唯一键。[OpenAI client metadata](https://developers.openai.com/plugins/reference#_meta-fields-the-client-provides)、[MCP 请求](https://modelcontextprotocol.io/specification/2026-07-28/basic)

调用方首次生成 UUID 型 idempotency_key，重试必须复用。主键域是 owner+key，额外保存 tool+canonical payload hash。所有训练写工具都按相同策略。鉴权先行，避免撤权后还能从幂等缓存读回敏感数据。

数据库原子提交完整 write receipt。revision 不匹配返回 REVISION_CONFLICT，并提供授权范围内 current_revision；模型先读回确认，不自动将旧写请求的 revision 改掉重发。同键原始请求的成功重放不再检查旧 revision。write receipts 与事件同寿命，不任意 TTL 过期导致旧重试复活。

失败语义：

| 情况 | 返回 | 对用户确认 |
| --- | --- | --- |
| 校验失败、scope 不足、事务回滚 | not_committed | 本次未持久化 |
| 收到完整 committed receipt | committed | 已保存，附简短内容/session ID |
| 超时、连接中断、提交后收据丢失 | unknown | 未能确认持久化，先查收据；不能声称已保存或肯定没保存 |
| 相同 key 成功重放 | committed 原收据 | 已保存，无重复事件 |

`get_write_receipt` 查不到时，只能表示目前未见已提交收据；若请求仍在途不能据此否定将来提交。重试原 key/payload 或稍后再查。同一内容不同 key 可能是真实重复训练，不自动去重；保留疑似重复提示与明确追加依据。客户端换 key 的行为是 G5 未验证项。

工具级授权错误的 `_meta["mcp/www_authenticate"]` challenge 必须同时含 `error` 和 `error_description`，例如 `Bearer error="insufficient_scope", error_description="Required scope is missing", scope="workout:write"`。协议字段使用固定 ASCII 文本，面向用户的 content 使用中文；不能泄露 token 或上游错误。真实 ChatGPT 重新授权提示仍属 G4 未验证。

## 5. 错误与限流

稳定 code：AUTH_REQUIRED、INSUFFICIENT_SCOPE、NOT_FOUND、PROFILE_REQUIRED、NEEDS_CLARIFICATION、INVALID_RANGE、INVALID_UNIT、INVALID_INPUT、SESSION_AMBIGUOUS、SESSION_SELECTION_REQUIRED、SESSION_FINALIZED、REVISION_CONFLICT、IDEMPOTENCY_CONFLICT、CURSOR_INVALID、CURSOR_EXPIRED、RECORD_TOO_LARGE、RATE_LIMITED、SYNC_IN_PROGRESS、FITDAYS_LOGIN_FAILED、UPSTREAM_TIMEOUT、UPSTREAM_ROUTE_DENIED、SENSITIVE_PAYLOAD_BLOCKED、INCOMPLETE_SYNC、STORAGE_FAILED、COMMIT_STATUS_UNKNOWN。

不传 err.message/response/stack 到模型，尤其不传上游返回的账号、签名 URL 或身份字段。用户消息为固定中文模板；细节只用非敏感码。只记录 request_id、tool、duration、counts、status。

起始限流设计值：`/authorize` 每 IP 10 次/分钟，`/oauth/token` 每 client+IP 20 次/分钟，MCP read 每 owner 60 次/分钟、write 20 次/分钟；全量刷新另有冷却。身份白名单及 rate limit 都必须实际部署测试，IP 不是 owner。批量查询/趋势超预算返回范围建议，不截掉数据装作完整。限流状态应由平台 rate limit 或 D1 原子计数实现，不能使用最终一致 KV 锁。

无 UI，暂不需要 widget CORS。Remote MCP 服务端到服务端不意味着必须 `Access-Control-Allow-Origin:*`。浏览器 Inspector 场景按实际 origin 配置；只暴露必要 MCP headers，验证 Origin，拒绝不可信浏览器来源。公共 healthz 仅 liveness；不拿 `<500` 当 readiness 成功（上游 Docker 的探活过宽）。

## 6. “减肥计划”项目 instructions 与 G4/G5

待真实部署、授权并确认工具列表后写入项目设置：

```text
Kinetrail（身迹）是体测与训练的事实数据库。
分析历史时按需查询 Kinetrail，不把项目记忆当作已保存的事实。
体测查询只读镜像；需要新数据时明确调用 refresh_data，再查询结果与 stale/coverage。
用户明确报告自己已经完成训练时，保留相关原话并记录逐组/有氧数据。
计划、建议、假设、引用他人、否定和未确认完成的内容不得写为训练事实。
到场/开始只建立空会话，不记录完成组。先查询 open sessions，按返回 ID 追加；多个候选先确认。
每个写请求生成一次 idempotency_key，超时/重试保持同键和同参数；冲突先查询，不换键盲重试。
用户明确结束才 finalize；结束后继续需要显式 reopen 或新会话。纠错用 amend 并保留旧版本。
只有收到 committed receipt 才说已保存。明确失败说本次未持久化；超时未知说未能确认持久化并查收据。
新聊天先查询数据库取得 session/revision，不凭记忆补 ID。
```

需记录两聊天真实选择来源/授权/审批行为；本轮只确定该测试契约，**未验证**项目 instructions 会自动驱动所有调用。Annotations 不能强制宿主无确认执行，用户拒绝写入时不得绕过。[ChatGPT 接入测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[Projects](https://learn.chatgpt.com/docs/projects)
