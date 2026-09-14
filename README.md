# Kinetrail（身迹）

私有体测与训练事实数据连接器。当前完成离线研究与最小 spike；未部署，未连接真实 FitDays 或 ChatGPT 项目。

- [架构决策](ARCHITECTURE_DECISION.md)：Worker 实现目标、上游审计、OAuth 与上线阻断项。
- [数据契约](DATA_CONTRACT.md)：秘密边界、raw 保真、训练事实与统计口径。
- [MCP 契约](MCP_CONTRACT.md)：19 个工具的权限、输入输出、幂等和错误语义。
- [实施计划](IMPLEMENTATION_PLAN.md)：复现命令、分阶段验收及“减肥计划”双聊天测试。
- [Opus 5 编码提示词](OPUS5_HANDOFF_PROMPT.md)：可直接交接。

`sanitized-fixtures/` 全是人工合成数据；真实脱敏响应待 Secret 接入后生成。`research/spike/worker.mjs` 包含合成测试授权入口，禁止部署或注入真实凭据。
