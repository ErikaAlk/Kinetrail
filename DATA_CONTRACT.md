# Kinetrail 数据契约 v1

2026-09-14。约束定案；真实中国区字段、单位和关联尚未验证。`sanitized-fixtures/` 当前全是人工合成样本，不能称为“脱敏真实响应”。上游字段依据固定提交，见 ARCHITECTURE_DECISION。

## 1. 数据边界与无损含义

完整测量数据指已确认测量数据集内的全部已知和未知测量字段，不包括 account、登录上下文和认证/身份秘密。不能先把全响应存进 raw_records 再清理。

接收链：有限字节 response text（仅内存）→ 保真解析与测量数据集选择 → 秘密检查/隔离拒绝 → raw 文本与 presence manifest → 逐条索引 → 发布同步批次。完整响应的临时内存不得被日志、异常上下文、trace 或 crash dump 捕获。

原始层保留 JSON 值、类型、缺失/null/空值差异、数字词法和值，以及 ext_data 字符串的实际内容；不承诺包含秘密的整段网络响应逐字节重现。对象排版/外层空白不作为测量事实。`raw_format_version=1` 明确该定义。

### 数字与 ext_data

- JS 普通 JSON.parse 会把 `9007199254740993` 舍入。本轮 Node 22.23.2 和 workerd 已验证 `JSON.parse` reviver 的 `context.source` 与 `JSON.rawJSON`，可按数字 token 原文序列化，不新增第三方解析库。
- raw_text 保存保真的数值字面量；索引只接受已知字段的有限安全数值，无法安全表示时保持索引 null + `numeric_precision_unverified`。MCP 完整数据同时提供 raw_json 字符串；对象形式便于模型使用，但不替代 raw_json。
- ext_data 状态为 `missing|null|string`，空字符串不等于 null。保存 `ext_data_raw`、`parse_status=missing|null|empty|ok|invalid|blocked`、`ext_data_parsed`，解析失败不使安全的 raw 记录丢失。
- 字符串内部若含秘密，原字符串本身不能进入普通库。重建脱敏字符串并标 `redacted=true`、版本和被移除字段路径；不能仍声称原始 ext_data 字符串逐字保真。无法可靠区分秘密与测量时整条拒绝发布，批次标 partial，不推进“完整同步成功”。

### 安全筛选策略

1. 顶层 `account` 无条件丢弃，认证 envelope 不保留。允许的测量列表为下表八类。devices/profiles 属于单独白名单投影，禁止照搬整个列表。
2. 递归检查对象、数组及允许的 JSON 编码字符串。标准化键名后识别 token/access_token/refresh_token/password/email/phone/mobile/open_id/authorization/cookie，以及签名 URL、等价密码摘要；秘密永远不进入模型输出、普通 raw 或 fixture。
3. 未知测量数值/结构保留。未知自由字符串、opaque blob、新数据集、无法安全解析的疑似敏感内容采用 fail-closed：不输出、不落普通库，只记字段路径/类型和错误码；在可信安全环境分类后重取。不得把黑名单当成可保证识别任意未来秘密的通用算法。
4. 未确认新字段是否为测量值时，安全与“立即可查询全部未知字段”无法同时绝对保证。选择安全阻断并显式 `coverage=partial`，不静默丢字段后报全量成功。部署前 G1 要核实真实字段目录及字符串策略。
5. UID/SUID 是关联 ID，内部保留；输出为 profile_ref 或按必要性输出来源 ID。MAC/SN、email/phone/open_id 都不是测量值，默认不存也不返回；设备标识需要关联时用稳定内部映射，设备型号/固件等按投影保留。

当前 `fitdays-check.mjs` 的扫描器仅验证合成边界样例，**不是可直接上线的通用脱敏实现**。它不证明能识别所有真实、编码或无标签秘密。生产需加入真实字段审查、自由文本策略和输出端二次检查；检查失败必须阻断该响应。

## 2. 数据集、字段、主键与关联

| 来源 | 状态/字段依据 | 身份与关联策略 |
| --- | --- | --- |
| weight_list | 上游有显式 WeightRecordRaw 类型 | 候选 key `(owner,dataset,suid,data_id)`；真实唯一性未验证 |
| height_list | 上游有显式 HeightRecord 类型 | 同上，真实单位/主键未验证 |
| impedance_list | `Record<string,unknown>` | 字段/主键未验证；weight.imp_data_id → data_id 仅候选规则 |
| balance_list | `Record<string,unknown>` | weight.balance_data_id → data_id，仅候选 |
| gravity_list | `Record<string,unknown>` | weight.gravity_data_id → data_id，仅候选 |
| hr_list | `Record<string,unknown>` | 无已确认 weight 外键，不按时间硬匹配 |
| rulers_list | `Record<string,unknown>` | 真实字段/单位/非空情况未验证 |
| skip_list | `Record<string,unknown>` | 作为 FitDays 来源测量保留；不重复自动导入用户汇报训练事实 |
| devices/bind_device | 单独设备投影 | 映射 device_id；排除 mac/sn/wifi_ext_data/自定义身份备注 |
| users | 单独 profiles 投影 | suid、内部名称、必要测量上下文；排除 photo 等非必要身份信息 |
| products | 上游宽类型 | 不属于已证实测量集，暂不向 raw tool 暴露；真实用途未验证 |
| account | 明确包含秘密 | 禁入普通 raw 与模型 |

上游类型：[`src/types/sync.ts`](https://github.com/roquerodrigo/fitdays-api/blob/e448d72db0a2f7cea88a4e4a1fd63681b730d7d0/src/types/sync.ts)。字段注释也是上游假设，不代表 CN 账户实测。

### 上游 weight 字段清单

```text
adc adc_list app_ver balance_data_id bfa_type bfr bm bmi bmr bodyage
created_at data_calc_type data_id device_id electrode ext_data
gravity_data_id hr id imp_data_id is_deleted kg_scale_division
lb_scale_division measured_time pp rom rosm sfr source suid uid
updated_at uvi vwc weight_g weight_kg weight_lb
```

除 ext_data 的可选/null/string 特例，源码分别将各 ID/文本标 string、数值标 number，删除标 `0|1`。真实 API 可能混用字符串和数字，raw 不强制转型；索引转换保留警告。不能因上游 TS 字段必填而拒绝保存缺字段的合法 raw。

### 上游 ext_data 字段清单

```text
age arm armAndLegBalance armBalance bfmControl bfmMax bfmMin bfmStandard
bfpMax bfpMin bfpStandard bmiMax bmiMin bmiStandard bmrMax bmrMin
bmrStandard bodyScore bodyType boneMax boneMin chest dataType
deviceModelExt deviceNameExt deviceSoftwareVer ffmControl ffmStandard
height hip is_show_circumference_layout legBalance muscleMassMax
muscleMassMin neck obesityDegree onlyMeasureWeight originalImps
peopleType proteinMassMax proteinMassMin sex smi smmMax smmMin
smmStandard targetBodyfatMass targetSMMMass targetWeight thigh waist
waterMassMax waterMassMin weightControl weightMax weightMin
weightStandard whr
```

这些字段原样保留。`originalImps` 暂不解释编码、频率或分段含义；`onlyMeasureWeight` 在源码是 string，不自行把任意 truthy 字符串当真。target 的 0/负数 sentinel 未验证，不擅自当作 null。

### 上游 height 字段清单

```text
created_at data_id device_id height height_cm height_inch id is_deleted
measured_time source suid uid updated_at
```

### 身份与重复版本

`source_record_id` 优先经验证的 data_id；源 ID 缺失时，以保真规范化测量 payload 的 SHA-256 做 `identity_kind=content_hash`，不声称能够识别后续修改是同一条记录。不能凭时间相近合并两次称重。键冲突而 suid/device 不一致时保留冲突状态，不覆盖。

相同 source key + 相同 raw_hash：只更新 last_seen；同 key 不同 raw_hash：新增 raw_record_version，保留 first_seen 和旧版本。即使真实更新规律未确认也采用追加版本，避免上线后无法回溯。同步批次不包含秘密字段的哈希；不能以邮箱/密码哈希作为去重键。

每个数据集有 manifest：`presence=missing|null|array|unexpected_type`、count、keys/types（无值）、coverage、batch_id。空数组不是“删除所有历史”；missing/null 不生成清空操作。

### join 结果

先限制同 owner/profile，然后按**已验证的显式外键**查找。返回 `exact|missing|ambiguous|unverified|not_applicable` 及 relation_ref；一个外键多匹配不任取第一项。非关联数据永远作为 orphan 可查。心率不能把任意同日 record 当作这次称重的心率；weight.hr 可独立保留。fixture 的 i1/b1/g1 join 只证明本地关联算法，不证明真实来源关系。

## 3. 持久化逻辑模型

```text
sync_batches: id, owner_id, mode, requested_start/end, source_region,
  state(staging|published|failed|partial), generation, manifest_json,
  counts, started_at, finished_at, sanitized_error, coverage
raw_records: id, owner_id, dataset, profile_ref, source_record_id,
  identity_kind, first_seen_at, last_seen_at
raw_record_versions: id, raw_record_id, batch_id, source_updated_at,
  raw_hash, byte_length, raw_format_version, sanitizer_version,
  raw_json OR chunk_manifest, measured_time_raw, is_deleted_raw
raw_chunks: version_id, chunk_index, bytes (UTF-8), chunk_hash
measurement_index: raw_version_id, owner_id, profile_ref, device_ref,
  measured_time_utc, local_date, timezone, metrics, quality_flags,
  formula_version, normalization_version
```

查询只读已发布批次的最新有效版本；快照 cursor 固定可见 generation。source 时间不是 ingestion 时间，UTC epoch 和来源无时区日期字符串分开保存；不把宿主 Windows 太平洋时区用于测量日历。

普通查询排除 is_deleted=1；专家查询可包含 tombstone。未识别的删除编码导致 quality warning，不自动解释为有效。全量校准同样不根据“这批未返回”产生删除。

## 4. 训练事实、状态机与审计

```text
workout_sessions: id, owner_id, started_at, ended_at?, timezone,
  status(open|finalized), revision, facility?, title?, duration_seconds?,
  duration_source(user_reported|timestamps|unknown), overall_rpe?, notes?, created_at, updated_at
workout_events: id, owner_id, session_id, operation, occurred_at,
  raw_text, completion_assertion, evidence_origin, parsed_json,
  schema_version, parser_version, idempotency_key, payload_hash,
  previous_revision, resulting_revision, created_at
workout_entry_versions: entry_id, session_id, revision,
  supersedes_version_id?, state(active|retracted), entry_json
write_receipts: owner_id, idempotency_key UNIQUE, tool_name,
  canonical_payload_hash, outcome_json, committed_at
```

set 数据在 `entry_json.sets[]` 逐组完整保存。单用户 V1 不必先拆成每组一张表；查询归一化到稳定 set schema，再计算。若数据量实际要求 SQL 聚合，可添索引/投影，不能丢原始逐组内容。事件和版本是事实来源，current projection 可重建，不是另一份可随意修改的事实。

每条 entry 包含：`exercise_name_raw`、可选 canonical exercise_id、category、facility/equipment_ref、equipment_label 原文、notes、sets。强制 sequence 与稳定 entry_id，由服务端生成。raw_text 仅本次训练相关原话，不保存完整聊天。模型解析并不构成真实完成的独立证明：`evidence_origin=user_report_via_model`，不得标为设备证实。

### 完成规则

- start 只建立 open 会话，不计训练完成、时长或训练天数。“到健身房了”不能产生已完成组。
- record 必须包含用户完成声明和对应 raw_text；计划、助手建议、引用他人、假设、否定完成或混合歧义返回 NEEDS_CLARIFICATION，不能进入 accepted facts。无害缺失的负重/次数等留空，不能模型补值。
- schema 验证、时间/单位约束、与 raw_text 的明显未来/否定矛盾检查及审计均在服务端；不把一个模型传来的 `completed` 布尔值当作可信授权。规则无法判明时不自动记事实。
- 服务端不能证明模型确实逐字引用了宿主消息，也不能从任意自然语言绝对证明完成。这个信任限制必须保留；G5 通过真实 ChatGPT 正反例测试及写入确认降低误写，不能声称单靠提示词或关键词完全解决。
- finalized 后 record 拒绝；显式 reopen 或明确新会话才继续。amend 允许修正 finalized 中既有事实，不隐式 reopen。撤回采用新 `state=retracted` 版本，不物理删除。

### 会话选择

优先显式 session_id，且 owner 匹配。省略时先查询 open candidates；仅一个、最近活动 12 小时内且开始不超过 18 小时、场馆一致才能自动追加；超过阈值要求明确选择，不自动 finalize。阈值是产品默认，不是人体训练规律。

允许两个并行场景，多个候选返回 SESSION_AMBIGUOUS；不得凭“最新一条”选。跨午夜保持 session_id，按事件发生的本地日期统计有效训练日；finalized session 计数按结束日另列。补录过去日期不能串入当前会话。无 open 且明确完成的首条可原子创建；并发创建须事务检查候选和 expected_revision=0，不能一轮聊天生两个隐形会话。

### 幂等与修订

`(owner_id,idempotency_key)` 全局唯一，同时保存 tool_name 和输入 hash（含 expected_revision）。相同 key/payload 重试返回首次提交收据；同 key 改参数返回 IDEMPOTENCY_CONFLICT。先鉴权，再查收据，再验 revision，最后一个事务提交 event、entry version、session revision、receipt。重试不新增业务审计事件。

amend 必须提供稳定 entry_id、session_id、expected_revision、修正原话及完整 replacement；生成新版本指向被替代版本。修正重量不改同事件其他组，除非 replacement 明确包含变化。任何错误必须整笔回滚；D1 的 `UPDATE ... WHERE revision=?` 影响 0 行不会自动令 batch 失败，实施时必须用约束/触发器或单条条件写使 CAS 冲突显式失败，不能忽略 rows_changed。

超时不等于未提交。读收据后决定 `committed|not_committed|unknown`；unknown 不改 key 重试。重试同键保证 exactly-once effect，不保证模型换键的语义去重。疑似重复只提示确认，不静默吞掉真实第二组。

## 5. 单位与可重复统计

结束总结的 duration_seconds、duration_source、overall_rpe、notes 必须随事件提交并可由 get_workout_history 回读；未知为 null，重开不抹去旧版本。timestamps 仅用于明确起止的会话跨度，不能冒充有氧运动时长。

未知或特殊单位使用 load_original、distance_original、speed_original 的 {value,unit} 保存，不能塞入受限枚举。辅助负重以非负 assistance_value + assistance_unit 表示，原报告负号另存 load_original。服务端输出 StoredEntry.normalized_sets 与 sets 一一对应，保留 normalization_version；无法转换的标准值为 null 并附 quality_flags。客户端不能提供标准化计算值。

原值字段和标准化值并存，`normalization_version=1`。未知单位保留原值，不参与跨单位聚合。空值不当 0；负数负重在 assisted 场景须单独语义，不混入普通外加负荷。

| 字段 | 原值与标准化 |
| --- | --- |
| load_value/load_unit | kg/lb；kg = lb × 0.45359237，最终展示才舍入 |
| distance_value/distance_unit | m/km/mi；m = km ×1000 或 mi ×1609.344 |
| duration_seconds | 非负整数；缺失不以“当前时间减开始时间”推断已运动 |
| reps | 非负整数；0 可表示失败尝试，不计有效次数 |
| set_type | warmup/working/drop/failure/other；未知留空，统计单列 |
| rpe/rir | RPE 0–10，RIR 非负；缺失留空，不相互自动推导 |
| speed/speed_unit | m/s、km/h、mph；与 distance/time 不一致保留原值并告警 |
| incline_pct | 百分比，不把“档位 2”直接当 2% |
| resistance/resistance_unit | 可为数字/档位标签；只同设备口径比较 |
| power_watts、heart_rate_avg/max | 非负有限值；范围异常告警，不丢 raw |

动作别名按版本表映射，保留原名；默认序列键 `(canonical_exercise_id或raw_name,facility,equipment_ref,load_basis)`。equipment 未知不能自动把两个未知场馆机器合为同一个设备；仅显示“未确认可比”。双手/单手、单片/总重、史密斯/自由杠、辅助负荷都需 load_basis，不猜。

### 体测趋势 v1

以 `Asia/Shanghai` 自然日分组。区间输入采用 `[start,end)`；周从星期一开始。每次有效体测先计算 `fat_mass_kg=weight_kg*bfr/100`、`fat_free_mass_kg=weight_kg-fat_mass_kg`，然后每日中位数、再周期内有数据日的等权均值。不能先周均体重乘周均体脂。7 日均线是最近 7 个日历日中有效日的均值，返回有效天数；不等于最近 7 次测量。环比使用等长日历窗，前期均值为 0 时百分比 null。只有称重记录而缺少 bfr 时不算脂肪量，body-only 状态未知不得用 0% 填补。

索引候选单位来自上游命名：weight_kg kg、weight_g g、bfr/rom/rosm/vwc/pp/sfr 百分比、bm kg、bmr kcal/day、uvi 无量纲、bodyage 年；真实 CN 单位及 sentinel **未验证**。smi/whr 不额外猜算法版本。数值变化仅作观察，不作因果或诊断。

### 训练趋势 v1

- 训练频率：有 active completed entry 的 session 数；有效训练日：有该事实的本地日期去重。open 中已完成组可计入，但标 `provisional_session=true`；空 session 不计。
- 力量训练量：仅可确认 external load、kg 和 reps 的组 `Σ(load_kg × reps)`；warmup 默认单列；未知器械/单侧口径不合并。bodyweight、assisted 不套同一公式。
- 最好组保留重量/次数/器械/日期原数据；e1RM 用 Epley `kg*(1+reps/30)`（2–10 次），1 次使用实际 kg，超过 10 次/未知负荷不估算。标 `estimate/epley_v1`，不当作实测 1RM。
- 有氧时长 Σ已报告完成 segment.duration；距离按可转换单位累计。不要将 session 总时长再与 segment 时长相加。
- session 总时长只在明确 start/end 或用户报告时给出，并标来源；不同维度的时长不互相替代。
- 综合概览并列同一时区/窗口下体测和训练，不进行医疗判断或因果推断。每个指标附 samples、valid_days、missing_count、formula_version、比较分组和质量标记。

## 6. fixture 与证据

`synthetic-cn-sync.json`：4 weight、2 impedance、1 balance、1 gravity；hr=null、height 缺失、rulers/skip 空；最大 weight 序列化 331 bytes，总紧凑 JSON 1055 bytes。数据为人工构造，不是 CN 真实分布。

`workout-flow.json`：三次已完成汇报和一条计划；逐组重量不同、有氧字段。SQLite 测试拒绝显式 planned 标记，不证明自然语言分类器或 ChatGPT 已正确辨别所有表达。

真实 fixture 交付 gate：用 Secrets 请求 → 内存筛选 → 所有身份 ID 一致替换、时间一致平移、测量值按明确方法变换 → 自动秘密扫描 + 人工 review → provenance 标明真实衍生、字段保留/删改清单与捕获时间。fixture 禁真实认证/身份值；不用实际邮箱/手机号作为测试示例。未通过 gate 前不写 `real-cn*.json`。

## 7. 实现细化（2026-09-14，Opus 5）

契约语义未改；以下是实现中确定的具体规则，真实 CN 数据（G1）可能要求调整，调整时同步更新本节与测试。

**秘密边界**（`src/sanitize.ts`，`sanitizer_version=1`）

- 秘密键：标准化键名（小写、去掉非字母数字）命中 token/password/secret/cookie/authorization/openid/unionid/email/phone/mobile/apikey/signature/credential 子串，或等于 account、mac、sn、ssid、ip、birthday、photo、remark_name 等。整个字段移除，路径记入 `redacted_paths_json`；键名本身像秘密时路径写 `<redacted-key>`。
- 可疑值：Bearer、JWT、邮箱、任何 URL、MAC；未知字段中的手机号形态（去空格/括号/连字符，允许 +86/0086/86 前缀，字符串和数字都查）。已知字段（上游类型里的 ID/时间/来源类）不做手机号形态判断，避免误删 ID。
- 已知秘密值精确/子串匹配：登录名、密码、FitDays 等价密码摘要、登录返回的 token/refresh token，以及登录响应与同步响应 `account` 中**认证/联系方式类键**下的值（普通字段如 updated_at 不收集）。
- 未知字段里的字符串只接受空串、数字、数字列表、日期时间形态，其他一律 `UNCLASSIFIED_STRING` 阻断整条；JSON 样字符串能解析时递归检查。
- 不能解析的 JSON 样字符串（含 ext_data）用线性词法分析逐个记号判断，转义先解码、区分对象与数组：键（带不带引号）不能是秘密键；值必须是安全形态且不像手机号（ext_data 的已知字符串键除外）；数组元素一律按值处理；末尾被截断的键片段只查秘密键，截断的值允许数字/日期前缀；对象键位置的裸词只允许 12 个字母以内。能确认安全时原串保留、`parse_status=invalid`（如 `{invalid`、`{"deviceNameExt":"客厅秤","smi":7.1`），否则 `SECRET_IN_UNPARSEABLE_STRING` 阻断整条。
- `__proto__`、`constructor` 等键按普通数据保留。

**身份、时间与索引**

- `profile_ref = p_` + SHA-256(“profile\\0” + suid) 前 16 位；无 suid 为 `p_unknown`。`device_ref` 同理（`d_`）。设备投影只保留型号与固件。
- `source_record_id` = `data_id`（空、`""`、`"0"` 视为缺失）；缺失时 `sha256:` + 规范化记录哈希。`first_seen_at` 为首次暂存时间（失败批次也可能留下身份行，但没有已发布版本，查询不可见）。
- `measured_time` 大于 1e11 视为毫秒并标 `measured_time_ms_assumed`；缺失标 `measured_time_missing`，不回退到无时区的 created_at。
- `is_deleted` 缺失按 0（标 `is_deleted_missing`）；非 0/1/true/false 视为未识别（索引 null、默认查询排除、标 `is_deleted_unrecognized`）。
- 索引指标：weight_kg（缺失时由 weight_g/1000 并标记）、bmi、body_fat_pct←bfr、muscle_pct←rom、skeletal_muscle_pct←rosm、body_water_pct←vwc、protein_pct←pp、subcutaneous_fat_pct←sfr、visceral_fat_index←uvi、bone_mass_kg←bm、bmr_kcal←bmr、body_age←bodyage、heart_rate_bpm←hr、smi/whr←ext_data；height 数据集 height_cm。数字字符串接受但标 `<字段>_numeric_string`。
- 派生：`fat_mass_kg`、`fat_free_mass_kg` 只在 bfr>0 时计算；bfr=0 标 `body_fat_zero_unverified`。
- 存储分块 256 KiB（BLOB）；输出分块 24 KiB（base64）。

**同步**

- 窗口 180 天、相邻窗口重叠 1 天、最新端点为当前时间 +1 天；增量从上个完整批次的检查点往前重叠 7 天。partial 批次不推进检查点。
- 成员白名单（2026-09-15，用户决定只存本人）：`PROFILE_ALLOWLIST` 非空时，只处理其中 profile_ref 的记录与 users 昵称，判断先于消毒；其他成员与无 suid（`p_unknown`，无法证明归属）的记录不落库、不计入 blocked、不使批次 partial，计数写入 `counts_json.excluded`。为空时保留全部成员。已入库的其他成员数据由一次性脚本 `scripts/purge-non-owner-profiles.sql` 物理删除（事实表“不物理删除”的唯一例外，经用户明确授权）。
- 未知数据集为空数组或 null 时只记入 manifest，不标 partial；有内容才 fail-closed 并标 partial。manifest 对未知数据集记形态、条数、键名、类型，不记值。
- 每次尝试一个 batch_id；暂存分多个 D1 batch 写入（未发布不可见），发布为单个 D1 batch（lease 守卫 + 置已发布 + last_seen + 投影 + sync_meta + 批次状态 + 释放 lease）。
- stale：从未成功、最后成功超过 15 分钟，或最后一次尝试失败晚于最后成功。

**训练**

- 单位换算表：kg/公斤/千克、lb/lbs/磅；m/米、km/公里/千米、mi/英里；m/s、km/h/公里每小时、mph。`*_original` 单位不在表中时标准化值为 null 并标 `unknown_*_unit`。
- 质量标记：`speed_distance_time_inconsistent`（偏差 >15%）、`heart_rate_out_of_range`（<25 或 >250）、`power_out_of_range`（>3000 W）、`assisted_load_semantics_unclear`。
- 事件 `parsed_json` 保存标准化后的条目与 `checks.numbers_in_raw_text`（结构化数字是否都出现在原话中，仅审计用，不阻断）；`evidence_origin=user_report_via_model`，`parser_version=server_rules_v1`。
- 会话时长：用户报告优先（`user_reported`）；显式 start 的会话在结束时按起止时间计算（`timestamps`）；由首条记录自动创建的会话为 `unknown`。重开后保留上次结束时写入的时长/RPE/备注，直到再次结束。
- 训练日按条目发生时间的本地日期计；跨午夜会话会计入两天。

## 8. Health Connect 来源（2026-09-15，Opus 5）

来源 `health_connect`：手机上的 FitDays+（`cn.icomon.fitdayspro`，Google 渠道包）在每次保存主用户称重时写入 HC，手机端 App 读取后推送。静态分析、实测与完整规则见 `research/HEALTHCONNECT.md` 第 1、3、5 节；本节是规范摘要，实现为 `src/ingest.ts`。

**范围**：只接收 7 个类型（体重 kg、体脂 %、水分质量 kg、骨量 kg、BMR kcal/day、去脂体重 kg、心率 bpm），来源固定为 FitDays+。FitDays+ 只写主用户，不回填历史，不把 App 内的修改或删除同步到 HC；HC 记录没有设备信息和 clientRecordId。

**身份**：同一来源、同一时刻（`time_ms`，秒级）的记录为一次测量，存为 `dataset=weight`、`source_record_id=hc:cn.icomon.fitdayspro:<time_ms>`、`profile_ref=HC_PROFILE_REF`（本人现有 profile）。按时刻精确分组有静态分析（一次 `insertRecords`、同一 `Instant`）与实测依据，不属于“凭时间相近合并”。

**范围**：体重不在 (2, 400] kg 整组拒绝；其他类型越界时 raw 照存、该指标索引为 null 并标 `<type>_out_of_range`。

**raw 与索引**：raw 为规范化整组（记录按类型、hc_id 码点排序，保留 HC 返回的 double 原值与 `last_modified_ms`、已删 id 列表）。索引 `weight_kg`、`body_fat_pct`、`bone_mass_kg`、`bmr_kcal`、`heart_rate_bpm`；恰好是 float32 的值取最短十进制；`body_water_pct` 由水分质量 ÷ 体重派生、保留 2 位小数并标 `body_water_pct_derived_from_mass`；`bmi` = 体重 ÷ (`HC_HEIGHT_CM` / 100)² 保留 1 位小数，标 `bmi_derived_from_height`（FitDays+ 不写 BMI；身高缺失或不在 (50, 250] 时不算；改身高只影响之后新产生的版本）；恒标 `source_health_connect`。与旧 FitDays 记录相比没有肌肉率、骨骼肌率、蛋白质、皮下脂肪、内脏脂肪、身体年龄，缺失指标不以 0 填补。

**版本与删除**：已存 `hc_id` 的类型、值、修改时间与组的时区偏移不可变，冲突整组拒绝；只能补齐组内从未出现过的类型。HC 删除（`deleted_hc_ids`）把整条记录移入组的 `deleted_records` 并写新版本，删体重即 `is_deleted=1`；已删 id 与已删类型都不再接收；不物理删除。这是“来源明确 tombstone 才产生删除版本”（第 3 节）在 HC 来源上的实现。

**截断与去重**：`HC_ACCEPT_AFTER`（线上为 2026-09-15T09:17:00+08:00，旧 FitDays 最后一条测量）之前的 HC 组不入库；两个来源不做跨来源匹配，也不同时导入同一时段。

**批次**：每次推送一个 `sync_batches`（`source_region='health_connect'`、`mode='incremental'`、`coverage='unknown'`），在 `sync_lease` 内读取已存组、合并、暂存、原子发布；中断批次由调度标失败但不重排。
