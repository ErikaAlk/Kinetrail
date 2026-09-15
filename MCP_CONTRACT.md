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

2026-09-15 定稿并写入“减肥计划”项目设置（语义与原草案相同，换成实际工具名，补充单人数据与整场汇总规则）：

```text
Kinetrail（身迹）是我的体测与训练事实数据库，库里只有我（Erika）一个人的数据，查询时不需要指定成员。
分析历史、回答“我上次练了什么/最近体重怎样”时，先查 Kinetrail，不把项目记忆或聊天记忆当作已保存的事实。

体测
- 体测只读本地镜像：get_measurements、get_latest_measurement_full、get_trend、get_progress_overview。
- 只有我明确说“刷新体测”时才调用 refresh_data：每次刷新都会把我手机上的 FitDays 顶下线。数据显示 stale 时告诉我数据停在什么时候，不要自己刷新。
- refresh_data 返回 queued 只表示已受理，稍后用 get_sync_status 确认，并留意结果里的 stale 和 coverage。

训练记录
- 只有我明确说自己已经完成的训练才能写入。计划、建议、假设、引用他人、否定、以及没说完成的内容，一律不写。
- 我说到健身房或开始训练时，用 start_workout_session 建立空会话，不记录任何组。
- 记录前先调用 get_open_workout_sessions，按返回的 session_id 和 revision 写入；有多个候选时先问我。
- record_workout_event：raw_text 保留我与这次训练相关的原话；逐组填写，我没说的重量或次数留空，不要补。
- 手表或 App 的整场汇总（总时长、心率、消耗、主观强度）写进 finalize_workout_session 的总时长、整体 RPE 和备注，不要单独记成一个动作。
- 每个写请求只生成一次 idempotency_key；超时或重试时保持同一个键和同样参数。遇到冲突先查询，不要换键盲目重试。
- 我明确说练完才调用 finalize_workout_session；结束后要继续，用 reopen_workout_session 或新开会话。
- 纠正或撤回已记录的动作用 amend_workout_entry，旧版本会保留。
- 只有返回 persistence=committed 才告诉我已保存。明确失败就说本次没有保存；超时或结果不明时说无法确认，并用 get_write_receipt 按同一个键查询。

新聊天
- 新开的聊天先查数据库（get_open_workout_sessions 或 get_workout_history）取得 session 和 revision，不凭记忆补 ID。
```

需记录两聊天真实选择来源/授权/审批行为；本轮只确定该测试契约，**未验证**项目 instructions 会自动驱动所有调用。Annotations 不能强制宿主无确认执行，用户拒绝写入时不得绕过。[ChatGPT 接入测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[Projects](https://learn.chatgpt.com/docs/projects)

## 7. 实现细化（2026-09-14，Opus 5）

以下是在契约允许范围内的具体取值与行为，schema（`research/mcp-schemas.json`）未改动。

**协议与鉴权**

- 支持协议版本 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`；`initialize` 请求其他版本时返回 `2025-11-25`。请求须 `Accept` 同时含 `application/json` 与 `text/event-stream`（否则 406）、`Content-Type: application/json`（否则 415）；`MCP-Protocol-Version` 头不在支持列表时 400。为兼容 2025-03-26 客户端接受 JSON-RPC 批量，但最多 4 条、顺序执行、合计响应超过 256 KiB 时返回 413（其中已提交的写入可凭同一 `idempotency_key` 取回收据）；只有通知时 202。`/mcp` 另有每 owner 每分钟 120 次的 HTTP 层限流（429），覆盖不经过工具限流的 tools/list、initialize、ping。
- Protected resource metadata 与 401 challenge 的 `scope` 为 `body:read workout:read`（首连所需的两个读 scope）。
- HTTP 403 `insufficient_scope` 只用于 token 不含四个 scope 中任何一个的情况；单个工具 scope 不足时返回 HTTP 200 的工具结果：`isError:true`、`error.code=INSUFFICIENT_SCOPE`、`_meta["mcp/www_authenticate"]`，challenge 的 `scope` 为“当前 scope ∪ 工具所需 scope”，避免重新授权后丢失已有读权限。宿主是否据此弹出重新授权属 G4 未验证。
- 授权页：所有客户端（包括机密客户端）都必须 PKCE S256；`resource` 若提供必须精确等于 `<origin>/mcp`；未知 scope 回 `invalid_scope`。`OWNER_OIDC_SUB` 为空时进入绑定模式（只显示登录者自己的 sub，不签发）。

**体测读取**

- 关联状态：真实 CN 外键规则核实前（`JOIN_RULES_VERIFIED=false`），唯一匹配也报 `unverified`；多匹配 `ambiguous` 并列出全部候选；外键为空、`""` 或 `"0"` 时 `not_applicable`。附属记录与主记录同 profile，或附属记录缺 suid（`p_unknown`）时才参与匹配。
- 内联上限：单条 raw 超过 64 KiB 只给 `chunk_ref`；ext_data 超过 32 KiB 时 `ext_data_raw`/`ext_data_parsed` 为 null、`complete:false`；同一次体测的关联记录共享 64 KiB 内联预算，超出部分只给 `chunk_ref`。
- `get_raw_dataset`：没有 measured_time 的记录出现在每个时间范围查询中，排在有时间的记录之后并带 `measured_time_missing`。
- 同步 `coverage`：真实分窗/截断/端点行为核实前只会是 `unknown`（完整发布）或 `partial`（有阻断或未知数据集），不会写 `verified_window`。
- `list_profiles` 的 `label` 取 FitDays 成员昵称，没有或形态可疑时为 `未命名成员`。
- 部署配置了 `PROFILE_ALLOWLIST` 时库里只有白名单成员（当前只有本人），`list_profiles` 只返回这些成员，省略 `profile_ref` 时自动选中唯一成员，不会出现 PROFILE_REQUIRED。
- `refresh_data`：FitDays 凭据未配置时直接 `FITDAYS_LOGIN_FAILED`，不创建任务。冷却：增量 60 秒、首次全量（没有检查点，含首批失败或 partial 后）10 分钟、校准全量 24 小时。

**趋势**

- `get_trend` 的 `group_key`：`period` 周期值；`ma7` 最近 7 个日历日均值（仅 day，有效日少于 4 天标 `sparse_window`）；`pop_change` / `pop_change_pct` 与上一完整日历周期比较（仅 week/month，附 `previous_valid_days:N`，上期均值为 0 时百分比 null 并标 `previous_zero`）。被区间截断的周期标 `partial_period`。`missing_count` 为周期内缺该指标的测量次数。bfr≤0 视为未测体脂，不参与体脂率、脂肪量、去脂体重。
- `get_training_trend` 的 `group_key`：`all` 为总体（sessions、training_days、working_sets、warmup_sets、volume_kg、cardio_duration_seconds、cardio_distance_m）；`series:<动作>|<场馆>|<器械>|<负重口径>` 为力量序列（volume_kg、working_sets、best_load_kg、e1rm_epley_kg）。器械未知时键里带会话 ID 并标 `equipment_unknown_not_comparable`；键超过 128 字符时改为 `series:h:<64 位哈希>`，可读部分放在 `quality_flags`（`exercise:`/`facility:`/`equipment:`/`basis:`）。总体 `volume_kg` 只统计未标注或 `total_external` 口径且有 kg 与次数的非热身组（标 `external_load_only`）。
- 点数超过 1000 返回 `INVALID_RANGE`；趋势工具不分页，传入 `cursor` 返回 `CURSOR_INVALID`。

**训练写入与历史**

- `start_workout_session`：`expected_revision` 必须为 0（否则 `INVALID_INPUT`）；原话含未来/建议/假设/否定/他人表达时 `NEEDS_CLARIFICATION`。
- `record_workout_event`：服务端规则检查六类表达（未来、意图、建议、假设、否定、他人），命中即 `NEEDS_CLARIFICATION` 且不写入；“准备组/准备活动”不算意图。已知误报方向是“多问一次”，不会误写。空组（只有 RPE/备注等）`INVALID_INPUT`；数值与单位不成对 `INVALID_UNIT`；完成时间晚于服务端时间 5 分钟以上 `INVALID_INPUT`。
- 会话自动选择：省略 `session_id` 时，没有 open 会话则新建（`expected_revision` 须为 0）；恰好一个且最近活动 ≤12 小时、开始 ≤18 小时、场馆不冲突时追加（`expected_revision` 须等于其 revision）；多个 `SESSION_AMBIGUOUS`；其他 `SESSION_SELECTION_REQUIRED`。完成时间早于会话开始 1 小时以上时，即使指定了 `session_id` 也拒绝（补录请先 `start_workout_session` 建对应会话）。
- 不同键、相同原话写入同一会话时照常保存，`content` 文本提示疑似重复。
- `reopen_workout_session` 对 open 会话返回 `INVALID_INPUT`。
- 任何写入字段出现邮箱、URL、JWT、MAC 等形态时 `SENSITIVE_PAYLOAD_BLOCKED`（与读工具输出检查同一规则）。
- `get_write_receipt` 查不到时 `status:"empty"`、`data:null`。
- `get_workout_history`：`limit` 最大 20（超出 `INVALID_INPUT`）；一页最多 100 条条目且约 200 KiB；会话条目未读完时 `entries_complete:false` 并给 `entry_cursor`，续读须同时传同一个 `session_id`；按 `exercise_id`/`equipment_ref` 筛选时被筛掉的会话也推进 `next_cursor`，一页可能为空但仍有下一页。
