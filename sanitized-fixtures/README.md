# fixture 来源

当前两份 JSON **全部人工合成，不含真实 FitDays 响应或真实训练**。

- `synthetic-cn-sync.json`：按上游类型构造的 raw 边界样例。关联字段是测试设定，真实 CN 规则未验证。
- `workout-flow.json`：逐组力量、有氧、多轮完成与未来计划的输入样例。

运行 `research/spike/check.mjs` 会扫描两个 JSON 中的受禁键和常见敏感值模式，再验证 raw/状态机。扫描器只是边界测试，不是通用秘密检测器。不能将“合成 fixture 检查通过”写成“真实脱敏链已经验收”。

真实 fixture 必须等 Secret 接入后按 DATA_CONTRACT 的来源标注、身份替换、测量变换和安全审核流程生成；本轮未创建任何 real-cn 文件。
