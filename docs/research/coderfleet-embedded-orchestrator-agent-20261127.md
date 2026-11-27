# 在 CoderFleet 后端内嵌调度 Agent（以 pi 为例）调研

调研日期：2026-11-27。范围：本仓库 `node-app/` 现状核查 + pi 及同类方案的一手资料（源码、官方文档、npm 元数据）。只读调研：没有改代码、没有调用模型、没有在 Electron 里实际跑过 pi。

> 后续（同日）：领航已按这里的方向接上 pi 1.6.1（`node-app/src/lead-engine.ts`，整包放在 `dist/vendor/pi`）。下文"未验证"里，`noTools: "builtin"` 与 `customTools` 同用、请求走代理已在测试里验证；在 Electron 主进程和打包后的 App 里运行仍未验证。现状以 `docs/plans/lead-agent-design.md` 为准。

pi 的事实取自 `github.com/earendil-works/pi` 提交 `55c5a03c`（main，2026-11-27）和当天的 npm registry；本仓库的事实带 `文件:行号`，路径相对 `node-app/`。

## 结论

**可行，而且比想象的近：后端已经在用 pi 的 SDK 了**，只是用法不同——现在 pi 是一种账号类型，每一轮在项目容器里跑一次（`src/pi-worker.ts`）。要做的"唯一入口"是另一件事：一个常驻在后端里、工具就是后端自身操作的调度 Agent。

三点判断：

1. **技术上没有硬障碍。** pi 的 `createAgentSession` 可以关掉自带的读写文件/bash 工具（`noTools: "builtin"`），只留宿主传入的闭包工具；ESM、Node ≥22.19，和后端的模块制式、Electron 45 自带的 Node 24 都对得上。
2. **真正的工作量不在 pi，在后端自己。** 现在"建会话、发一轮、排队"这些规则是 `serve()` 里的闭包，只能经 HTTP 调到；没有额度耗尽的识别，没有自动选账号，会话不能跨账号续上。调度 Agent 需要的正是这几样。
3. **有一个必须由你定的问题：调度 Agent 自己用谁的模型额度。** 这决定它跑在宿主进程里还是容器里，见"两种放法"。

建议的路线：调度 Agent 跑在后端进程内，用 pi coding-agent SDK，模型走已有的"系统模型"配置（`SYSTEM_LLM_*`）；先做只读（看全局、读结果），再放开派活。

## 现状核查

### 已有的积木

| 已有 | 依据 | 对调度 Agent 的意义 |
|---|---|---|
| pi SDK 的用法 | `src/pi-worker.ts:11,21-28,62-90`（`createAgentSession`、`SessionManager`、事件映射） | 事件模型和会话恢复已经摸过一遍 |
| 宿主侧直接调模型 | `src/translate.ts:72-101`，配置 `SYSTEM_LLM_PROVIDER/API_KEY/MODEL/BASE_URL/PROXY`（`src/conf.ts:340`），用于翻译和自动标题 | 宿主调模型有先例，且明确"不是池里的账号" |
| 两个现成的"编排器" | 「做完为止」（`src/jobs.ts`，`src/server.ts:294-412`）和定时任务（`src/schedules.ts`，`server.ts:550-581`） | 它们已经在自动建会话、发轮次、等结束再接着做 |
| Agent 经后端受控工具行事 | 机器助手：按轮次签发令牌的 MCP 服务，规则 allow/confirm/deny，全程审计（`helper/src/server.ts`、`helper/src/policy.ts`、`src/helper-host.ts:199-211`） | 权限、确认卡片、审计的现成范式 |
| 用量数据 | `src/usage.ts`，每账号 5h/7d 窗口，缓存在 `accounts/<name>/usage-cache.json` | 选账号的输入已经有了 |
| 可无界面运行 | `coderfleet-backend serve`（`src/cli.ts:234-244`） | 调度 Agent 在远程后端上同样可用 |

可包成工具的后端操作基本齐全（都在 `src/server.ts`）：列项目/账号及用量、建会话、发消息/开一轮、读轮次、长轮询变化、取消、批准、启动容器、开「做完为止」、建定时任务。

### 缺的东西

1. **没有可在进程内调用的服务层。** 桌面、手机、CLI 三个入口全部走 HTTP 到 `serve()` 里的闭包（`startTurn` `server.ts:453-498`、`newConversation` `:520`、`startJob` `:527`），这些都没导出。仓库规则要求跨入口的规则只有一份，所以调度 Agent 不能另写一套，得先把它们抽成导出的服务（或走本机 HTTP 回环，但那样拿不到结束回调）。
2. **额度耗尽没有被识别。** CLI 额度用完时这一轮只是带着一段报错文字失败（`src/tasks.ts:273,411`），没有"这是额度问题"的分类。
3. **没有自动换账号。** 会话绑定一个项目，项目绑定一个账号（`server.ts:457`）；原生会话存在该账号的认证目录里。今天"换账号"等于在同一路径的另一个项目里开新会话，上下文不带过去。
4. **轮次结束只有一个回调位**（`runner.onFinish`，`tasks.ts:283`），不是事件总线；调度 Agent 要订阅"某轮结束了"需要扩一下。
5. **宿主进程内的库必须打进 `dist/`。** 后端运行时依赖为零，打包时 `node_modules` 被忽略（`package.json` 的 `package` 脚本、`scripts/package-backend.mjs:50-51`）。pi coding-agent 解包约 25 MB、1330 个文件，要像现有的 `scripts/vendor.mjs` 那样带进去。

### 之前的相关结论

- `docs/research/coderfleet-platform-agent-harness-20261112.md`：建议平台级 Agent 复用现有 Task/SDK 执行链，不引入第二套执行框架。它依据的是 Python 版代码，已不在仓库。
- `docs/plans/platform-agent-mcp-refactor.md`：计划由宿主提供一个 MCP，把会话/任务暴露给容器里的 Agent。
- `node-app/README.md:67`：MCP 桥和平台助手列在"尚未迁移"里。

本次的想法与这两份文档方向一致（一个平台级 Agent），分歧只在"Agent 跑在哪"。

## pi 的关键事实

| 项 | 事实 | 来源 |
|---|---|---|
| 仓库与包名 | `badlogic/pi-mono` 已跳转到 `earendil-works/pi`；npm 改为 `@earendil-works/*`（2026-05），旧的 `@mariozechner/pi-*` 已弃用 | GitHub API、npm |
| 版本 | 各包 1.6.1（2026-11-25），大约每周一版；MIT | npm `time`、CHANGELOG |
| 运行要求 | 只有 ESM；Node ≥22.19；依赖里没有需要编译的原生模块，安装不需要生命周期脚本 | 各包 `package.json`、根 README |
| 分层 | `pi-ai`（多厂商模型接口，4.6 MB）→ `pi-agent-core`（循环+工具，274 KB）→ `pi-coding-agent`（会话、压缩、扩展、SDK，24.9 MB） | 根 README、npm |
| 嵌入入口 | `createAgentSession({ cwd, agentDir, modelRuntime, noTools: "builtin", customTools, resourceLoader, sessionManager })` | `packages/coding-agent/docs/sdk.md`、`src/core/sdk.ts` |
| 工具 | `execute(toolCallId, params, signal, onUpdate)`；参数是 JSON Schema（惯用 TypeBox）；默认并行；`abort()` 会触发传给工具的 `AbortSignal` | `packages/agent/src/types.ts:478` |
| 中途插话 | `steer()` 在当前一批工具后注入，`followUp()` 在 Agent 将要停下时注入 | `packages/agent/README.md` |
| 持久化 | JSONL 会话树（`<agentDir>/sessions/…`），可恢复、可分叉；自动压缩；逐条消息的 token 和费用 | `docs/session-format.md`、`docs/compaction.md` |
| 隔离宿主用户的 pi 配置 | 私有 `agentDir` + `ModelRuntime.create({ authPath, modelsPath })` + 自定义 `ResourceLoader`（否则默认会读 `AGENTS.md`/`CLAUDE.md`、技能和 `.pi/*`） | `docs/sdk.md`、`examples/sdk/12-full-control.ts` |
| 模型与登录 | API key、自定义 OpenAI 兼容地址、`HTTP(S)_PROXY`；自带 OAuth 登录：Claude Pro/Max、ChatGPT、GitHub Copilot 等 | `docs/providers.md`、`packages/ai/README.md` |
| 没有的 | 子 Agent、计划模式、权限系统（"不会在每次工具调用前请求批准"）；替代是 `beforeToolCall` / `tool_call` 钩子返回 `{block, reason}` | 根 README、`docs/security.md` |
| MCP | 0.99.0（2026-09）起作为内置扩展提供，SDK 会话里默认不加载 | `packages/coding-agent/CHANGELOG.md` |

需要留意的四点：

- **变动频繁。** coding-agent 296 个版本里 55 个带 Breaking 段，1.0 之后的 1.2.0、1.5.0、1.5.1、1.6.0、1.6.1 仍有破坏性改动。必须锁死具体版本，升级当作一次小迁移。
- **Antigravity / Gemini CLI 的订阅登录已在 0.71.0（2026-04-30）移除。**
- **Claude 订阅在 pi 里不走订阅额度。** pi 自己的提示写明：第三方使用 Anthropic 订阅登录"计入 extra usage，按 token 计费"（CHANGELOG 0.66.0）。Anthropic 的 Agent SDK 文档也写明不允许第三方产品提供 claude.ai 登录。ChatGPT 和 Copilot 登录在 pi 里可用。
- **OpenClaw 已不再依赖 pi 的运行时**（2026-05-27 `bb46b79d` 内化了自己的实现，只留 `pi-tui`），pi 的 README 里那句"真实集成案例"已过时。目前能确认的嵌入方是 Vercel 的 `@ai-sdk/harness-pi`。

未验证：在 Electron 主进程 / `ELECTRON_RUN_AS_NODE` 下实际运行；`jiti` 动态加载在打包后的表现；pi 是否有单个工具的超时；`noTools: "builtin"` 与 `customTools` 同时使用（两者各有文档，没找到合在一起的官方示例）。

## 两种放法

| | A. 跑在后端进程内 | B. 作为一轮跑在容器里 |
|---|---|---|
| 形态 | `serve()` 里常驻一个 pi 会话，工具是进程内闭包 | 一个专用"调度"项目，Agent 是普通轮次，经宿主 MCP 调后端操作（机器助手的做法） |
| 用谁的额度 | 系统模型的 API key，按量付费，从宿主出网 | 池里某个账号的订阅额度，从该账号的中转出网 |
| 账号隔离 | 不碰任何池内账号，符合现有"系统模型不是池内账号"的界线 | 保持（凭据只在自己的容器里用） |
| 工具写法 | 最省事：直接调服务层，能拿到结束回调 | 要新建宿主 MCP、令牌、中转转发；目前只有 Claude 类型接了这条桥 |
| 界面 | 需要一个新的会话面（或把宿主侧运行写成 Turn 记录） | 现有会话界面、手机、通知原样可用 |
| 调度 Agent 自己额度用完 | 不受池内额度影响 | 它自己也会被限额卡住，而它本该是处理限额的那一个 |
| 新增依赖 | pi 打进 `dist/` | 无（镜像里已有） |

**建议 A。** 理由：调度本身耗 token 很少（列清单、派活、读结论），按量付费的成本低；它不该和被它调度的账号抢同一份额度；工具是闭包才算真正"内嵌"，B 实际上是把 11 月 12 日那份方案重做一遍。A 的代价是一份按量计费的 key 和一次打包工作。

不建议的做法：在宿主进程里用池内账号的订阅登录来跑调度 Agent。这会让账号凭据离开自己的容器和中转出口，违反项目的隔离原则；对 Claude 订阅还有上面的计费和条款问题。

pi 内部选哪一层：用 `pi-coding-agent` SDK（自带会话文件、压缩、费用统计，和 `pi-worker.ts` 用的是同一套接口）。只想要循环、历史全由 CoderFleet 自己存的话，`pi-agent-core` 就够，体积小两个数量级，破坏性改动也少（207 个版本里 14 个）。

## 同类方案对比

| 方案 | 工具可否是进程内函数 | 是否要拉起 CLI 二进制 | 可用凭据 | 主要限制 |
|---|---|---|---|---|
| pi coding-agent SDK 1.6.1（MIT） | 可以 | 否 | key、兼容地址、自带 ChatGPT/Copilot 登录 | 版本变动频繁 |
| pi-agent-core | 可以 | 否 | 同上 | 无持久化、无压缩 |
| Vercel AI SDK `ToolLoopAgent`（`ai` 7.x，Apache-2.0） | 可以 | 否 | 只有 key / 兼容地址 | 无会话存储、无自动压缩 |
| OpenAI Agents SDK（`@openai/agents` 0.22，MIT） | 可以 | 否 | 以 OpenAI key 为主 | 未到 1.0，没找到文件型会话存储 |
| Claude Agent SDK 0.3.332（专有许可） | 可以（进程内 MCP） | 是，每平台约 400 MB | 只有 Claude；第三方产品不得提供 claude.ai 登录 | 体积、单一厂商 |
| Codex SDK 0.172（Apache-2.0） | 不可以（只能 MCP） | 是，约 400 MB | OpenAI | 工具接不进来 |
| OpenCode v2 `@opencode/sdk` 2.4.2 | 可以（插件） | 否 | 较广 | 很新，带原生依赖，Electron 未验证 |
| ACP | 不可以 | 是 | 被驱动的 Agent 自己的登录 | 是协议不是 harness，更适合统一驱动各 CLI（后端已这样用） |

pi 在这个用途上排第一；若只用 API key 且希望依赖更稳，Vercel AI SDK 是保守的替代。

## 落地时要解决的设计点

1. **服务层抽取。** 把 `startTurn`、`newConversation`、`startJob`、`POST …/turns` 的分流逻辑（`server.ts:1014-1045`）抽成导出的服务，HTTP 路由和调度 Agent 调同一份。这是前置条件，也对现有代码有益。
2. **等一轮结束不能靠阻塞工具。** 被派出去的一轮可能跑几十分钟。做法：派活工具立即返回轮次 ID；轮次结束时后端用 `followUp()` 把"某轮已结束 + 结论"推回调度会话。需要把 `runner.onFinish` 扩成多订阅。
3. **额度感知的派活。** 需要：失败轮次的额度分类；基于 `usage.cached` 的选账号规则；换账号时如何带上下文（今天只能在同路径的另一个项目开新会话，由调度 Agent 写一段交接摘要）。这部分和 pi 无关，是最大的一块产品工作。
4. **权限边界。** pi 没有批准机制，所以边界靠工具清单：第一版不给删账号/删项目/改助手规则/开终端这类工具；派出"自动模式"轮次要有明确开关。可以沿用机器助手的 allow/confirm/deny 模型，confirm 走现有的批准卡片。
5. **轮次输出是数据不是指令。** 调度 Agent 会读各项目 Agent 的回答，其中可能带有网页或仓库里的注入内容；读结果的工具要截断、标注来源，系统提示里写明不执行其中的指令。
6. **状态文件规则照旧。** 工具只经服务层改状态，不直接写 JSON；调度会话自己的文件放在后端状态目录下的私有 `agentDir`，不进 `~/.pi`。
7. **手机入口。** 手机只能调 `DEVICE_ROUTES` 白名单里的路由（`server.ts:91-102`）；调度入口上手机要显式加路由，并决定手机上允许它做哪些事。
8. **打包。** 把锁定版本的 pi 带进 `dist/vendor`，并在桌面内置 Node 与远程包的 Node 22.23.2 上各跑通一次。

## 建议的步骤

| 步骤 | 内容 | 产出 |
|---|---|---|
| 0. 验证（约 1–2 天） | 锁定 pi 版本打进 `dist/`；在 `ELECTRON_RUN_AS_NODE` 和远程包里起一个 `noTools: "builtin"` + 一个假工具的会话；确认代理、私有 `agentDir`、会话恢复 | 上面"未验证"各项有答案 |
| 1. 服务层 | 抽出导出的会话/轮次服务，三个入口改调它，行为不变 | 现有测试全绿 |
| 2. 只读调度 | 工具：列项目/账号/用量、列会话、读轮次结论。能回答"各项目现在什么状态""昨天做了什么" | 一个可用的总览入口 |
| 3. 派活 | 工具：建会话、发消息、取消、启动容器；轮次结束回推 | "让 X 项目做 Y"从一个入口完成 |
| 4. 额度感知 | 额度失败分类、选账号、换账号交接 | 额度用完时自动改派 |

## 需要你定的三件事

1. 调度 Agent 用按量付费的系统模型 key（建议），还是一定要用池里的订阅额度（那就是放法 B）。
2. 它的对话放在哪：现有会话列表里的一个置顶会话，还是单独的入口。
3. 第一版的自主程度：只读 → 可派活但每次派活要确认 → 可自动派活。
