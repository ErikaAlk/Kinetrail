# 离线验证记录

日期：2026-09-14。数据：人工合成。真实凭据：未配置、未读取。主机 PowerShell 7.6.6；宿主 Node 24.16.0；固定执行 Node 22.23.2；Python 3.11.9（版本需复现时重查）。

| 检查 | 实际结果 | 限制 |
| --- | --- | --- |
| `node check.mjs`（Node 22.23.2） | PASS，见 spike-results.json | workerd/本地 KV、D1；不是云端部署 |
| `node node-http-check.mjs`（Node 22.23.2） | PASS，见 node-results.json | 合成只读 Node HTTP endpoint；无 Docker、Node AS |
| `node contract-check.mjs` | 38 schema 编译、7 负例及 4 项审查回归通过 | 不替代跨字段规则及实际 19 tools/list |
| `python core-check.py` | SQLite 完成三轮写入、重试/回滚/修订/结束/重开及独立连接读回（含 duration/RPE/notes 总结） | 固定单 fixture 会话，非完整 D1/MCP 训练实现 |
| `python trend-check.py` | 固定数字断言通过 | 不是完整 trend 端点；7 日窗口/环比仍需实施测试 |
| `python regression-check.py` | 内存副本移除 planned 拦截后在预期断言变红 | 检查能检测该守卫缺失，不证明自然语言理解能力 |
| `node --check` 所有研究 mjs；Python AST parse | 通过 | 非生产 TS lint/typecheck |
| 研究契约 Markdown 本地链接 | 无断链 | Web 链接仅按研究引用，不批量探活 |
| `npm audit --json` spike 全依赖 | 0 已报告漏洞 | 见 dependency-audit.json |
| 上游 MCP `npm audit --omit=dev --json` | 0 已报告运行时漏洞 | 见 upstream-mcp-audit.json；未运行上游完整 CI |

已修正的实验问题：esbuild neutral 必须显式 mainFields；Miniflare 5 alpha 需 v4 options 转换；Provider 0.10.3 拒绝 HTTP issuer，因此内部分发用 https://localhost（不代表真实 TLS 握手）；createClient 生成实际 ID，不能继续使用请求中的 fixture ID；授权码重放会影响 grant，因此负例放在正常功能检查之后；无推送需求时关闭 GET SSE，避免回环代理等待无限流；变异测试失败路径用 ExitStack 关闭 SQLite，避免 Windows 文件锁掩盖断言。

Node 24.16.0 Inspector 在输出工具列表后曾因 Windows libuv assertion 非零退出，因此没有把该运行标成功；固定 Node 22.23.2 后两项 Inspector 命令正常退出。Miniflare 当前最新为 alpha；本轮仅用作模拟器，不作为生产 runtime 依赖。

fixture 扫描检查的是受禁键与常见敏感模式，全部样本由人工构造。**真实脱敏链、真实字段、真实用户事实、Access/OIDC/CIMD、过期撤销、云端 D1 全训练事务、ChatGPT 项目两聊天全流程均未验证。** G1–G5 位于 IMPLEMENTATION_PLAN。

`upstream-inventory.json` 记录两个已审查提交、包清单、lock/许可证 hash，以及 314 个 lock 条目的许可证声明。包含其他平台 optional 条目，不代表本机实际加载了 314 个包。开发依赖中有 LGPL（libvips/sharp 二进制）和 MPL-2.0（lightningcss）；它们不应进入生产 Worker。分发研究工具包也需核对相应许可证义务，不能称所有传递依赖均 MIT。

末轮契约复核：已验证未知单位/辅助负重原值与标准化输出 schema、REVISION_CONFLICT.current_revision、训练总结输出；已在本地 MCP scope 拒绝响应断言 error_description。真实 ChatGPT 授权提示未验证。

独立审查：GPT-6 Astra ultra 对授权边界与契约执行只读复核；末轮四项修正复核无新增阻断。主代理末轮重跑 workerd/MCP/OAuth/D1/SQLite 检查通过。该结论仅覆盖离线交付。
