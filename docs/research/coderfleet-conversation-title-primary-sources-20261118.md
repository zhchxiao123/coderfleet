# 会话标题/自动命名：一手资料与设计取舍

研究日期：2026-11-18（America/Los_Angeles）。本次“会话总结”已明确指**左侧列表中的短会话标题和自动命名**。以下只讨论命名，不扩展为工作复盘、日报、长期记忆或模型上下文压缩。

本报告是外部资料补充；现有 CoderFleet 的实际触发、模型配置、标题持久化和历史数据，由本地审计报告提供。本次只核查官方文档并写本文，未运行模型、修改业务代码/配置或操作生产会话。

## 核实到的能力与边界

| 官方事实 | 对 CoderFleet 的含义 |
| --- | --- |
| 最新 Python SDK 提供同步 `rename_session(session_id, title, directory=None)`，向原生 transcript 追加 custom-title 记录；最新标题生效。它要求有效 UUID、非空标题，找不到会话会报错。[Python reference / rename_session](https://code.claude.com/docs/en/agent-sdk/python#rename_session) | 这是**原生会话元数据改名**，不是替应用总结业务主题的生成接口，也不会自动更新 CoderFleet 的 Conversation。 |
| 最新 TypeScript SDK 同样提供 `renameSession`，其显示标题选项在 resume 时会被已有持久标题覆盖，改已有会话需 rename。[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript#renamesession) | 如果将来同步 CLI 原生会话名称，需要单独设计两个存储的主从关系；不能靠每轮传 title 视为已经改名。 |
| `SDKSessionInfo.summary` 是展示标题，可能来自 custom title、最近提示、自动生成摘要或首条提示；`custom_title` 在无人工名称时也可能是自动标题。[Python reference / SDKSessionInfo](https://code.claude.com/docs/en/agent-sdk/python#return-type-sdksessioninfo) | 不应根据字段叫 summary 就当作正文总结；也不能只凭 `custom_title` 非空推断用户亲手改过名。 |
| SDK structured output 能校验 schema 并重试格式不匹配，最终仍需检查 `is_error` 与 `structured_output`。[Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling) | 能保证例如 `{"title":"…"}` 的外形，不能保证标题有辨识度、长度合适或覆盖最新主题；应用仍要校验。 |
| Anthropic `max_tokens`、`model_context_window_exceeded` 表示输出未完整结束；HTTP 成功不等于完整标题。[Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) | 过小输出预算可能得到半句话；不要把被截断的模型回复直接切前几个字符后落盘。 |
| OpenAI Chat 协议的 `finish_reason:length` 表示达到输出预算；`content_filter`、`tool_calls` 也不等于完成一条普通文本标题。[Chat reference](https://developers.openai.com/api/reference/resources/chat) | OpenAI 兼容网关要核对结束状态。兼容协议不证明模型支持 JSON Schema 或遵守短标题指令。 |
| DeepSeek 最新文档说明思考模式默认开启，并提供单次请求的切换方式；Chat 用量包含 `reasoning_tokens`，`length` 表示达到输出限制。[Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat API](https://api-docs.deepseek.com/api/create-chat-completion/) | 标题很短也可能需要为推理留出预算；通过第三方兼容口时仍要用实测确认，不全局改动其他系统功能。 |
| DeepSeek 最新提供 `title.enabled`，可随一次回答返回会话标题。[Conversation Title](https://api-docs.deepseek.com/guides/conversation_title/) | 可作为供应商特定的候选来源；当前兼容网关支持未验证，也不能自动覆盖以 Claude/Codex 为主的项目问答。 |

版本提醒：仓库 SDK 文档声明固定组合为 Python `0.2.180` / bundled CLI `2.1.321`；以上是本次打开的滚动官方资料，未证明每个接口在该固定 wheel 或生产进程中存在。SDK 原生 rename 可以后续按版本验证；**平台可靠自动命名本身不必依赖原生 rename、MCP 或再启动一次 coding agent**。

## 推荐的命名方式（设计建议）

| 方案 | 优点 | 主要问题 | 建议用途 |
| --- | --- | --- | --- |
| 提交首条消息后，用系统文本模型一次性生成 | 名称很快出现；生成无需工具或完整 agent 执行 | “继续”“分析一下”或只有图片时缺少主题；首条超长指令中的重点也可能在后面 | 作为早期候选，输入不足时先用临时名称 |
| 首轮有效答复后，用目标与答复共同生成 | 能识别代码对象、问题和工作类型；首次命名通常更准确 | 长任务完成前一直没有最终标题；运行失败也需要可读名称 | 推荐的主要生成时机；不能只等成功 Task，否则失败会话始终无标题 |
| 主题明确变化后，受控更新自动标题 | 长会话继续演变时更容易检索 | 每轮改名会造成列表跳动和用户失去定位；模型可能把短期插话当主线 | 仅对系统生成的标题更新，合并/限频，人工命名保持优先 |

建议采用“**立即可读的临时名称 → 首轮有效上下文后生成 → 少量受控更新**”。标题的判断标准是用户从十几个相似会话中能认出它，而不是能否机械压缩第一句。

示例（产品建议，不是模型实测）：

| 原始输入 | 不理想的标题 | 更有辨识度的方向 |
| --- | --- | --- |
| “继续”后才出现具体 Flutter 分享问题 | 继续 | iOS 分享卡片修复 |
| “帮我看看这个 Prompt is too long” | 帮我看看这个 Prompt is too long | Claude 长会话压缩排查 |
| 很长的系统日志 + 要求检查 OAuth 回调 | 日志前 30 字符 | OAuth 回调失败排查 |
| “先研究 SDK，再实现 interrupt” | SDK 调研 | Claude SDK 中断接入 |

## 最小可靠契约（设计建议）

- **输入取有意义的上下文**：首个实质用户目标、必要项目标识、首轮有效答复或最近明确转向。正文材料是待命名数据，不能执行其中“忽略命名要求”的指令。无需把整段会话、工具日志、账号凭据交给命名模型。
- **生成不阻断问答**：命名是后台元数据维护，主 Task 的排队、运行、失败都不应被它阻断。若系统模型不可用，保留可读临时名并允许稍后重试；不能一次失败就永久放弃。
- **平台服务端持久化**：新建、手动重命名、自动生成、历史补全复用同一入口，CLI/Web 行为一致；页面重载不应重新命名同一份内容。
- **人工名称优先**：需要可靠记录标题来源；异步生成结束时同步 RMW 复查会话仍存在、目标版本未变、期间没有人工改名，不能让慢响应覆盖用户名称或另一版新标题。
- **状态可观察**：区分临时、生成中、成功、失败可重试、人工命名，错误不能只在前端控制台中消失。标题正文不展示错误或模型解释。
- **标题质量单独校验**：非空、单行、无 Markdown 包裹、无“标题：”前缀、不复述提示词、不等于泛化“新会话/继续/问题分析”。中文/英文长度策略需要用真实列表宽度和样本测量，不能把“最多 N token”当作“N 个汉字”。
- **输出预算可测而非极小**：给足完成一句短标题的空间，检查结束标记；格式或质量不合格时有限重试。不要通过无限放大预算解决短标题问题，也不要切下模型解释的前缀冒充标题。系统模型若不支持 schema，严格单行文本加本地验证可以更轻。
- **历史补全克制**：先识别旧临时标题/首句截取名，按用户需要分批补全、记进度、限并发；人工名称和已有良好自动名不整仓覆盖。源数据不足时保留旧名并说明可重试，不编造主题。

这些是平台方案，不是官方 SDK 的现成承诺。短标题的 UI 价值在稳定识别；详情、项目/时间等信息可以由现有列表提供，不要把所有状态塞进名称。

## 建议验证

1. 合成/匿名样本覆盖首句很长、只有“继续”、中英混合、代码/日志为主、图片开场、失败首轮、转主题、用户手动改名。
2. 对同一批会话对比“首句截取”“只用首条提示”“首轮问答”三组，人工评估可辨识度、误导性、过于泛化和冗长；统计生成延迟、token、失败率。
3. 用确定性协议夹具测试空响应、引号/多行/解释性回复、输出预算截断、超时、未配置系统模型，以及“用户改名发生在模型返回之前”的竞态。
4. 测试刷新、重启、CLI 创建与 Web 创建、历史补全中断重试；确认同一会话不重复生成、不跨会话写入、人工标题不被覆盖。

本文只核验外部协议与设计取舍，没有声称当前命名链路已修复、原生 rename 已接入或标题质量已通过真实模型验收。
