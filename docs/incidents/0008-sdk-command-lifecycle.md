# 原生命令状态被显示为错误 JSON

## 表现

SDK 升级后，正常回答前后出现三张红色 JSON 卡，type 为 command_lifecycle，state 依次为 queued、started、completed。command_uuid 相同，事件自己的 uuid 不同。任务回答本身可以成功。

## 原因

worker 保留了正确的原始事件，但共享 renderer 没有对应分发。未知类型进入 `_rawLine`，该诊断视图默认标记 is-error；普通生命周期被误当成错误。事件自己的 uuid 也不能用来聚合一条命令。

## 修复与防回归

共享渲染器按 session / command_uuid 维护状态，兼容显式 system/command_lifecycle 形状，更新原有节点；不把 completed 认作 Task 或回复成功。重复与迟到事件不能倒退终态。桌面、移动、历史与实时流复用同一实现。行为测试同时验证单一节点、折叠、取消、跨 session 及 Task footer 边界。遇到新事件时先检索 `command_lifecycle` 与分发 default，再判断其语义，不能从未知类型推断错误。

同批原生工作流的真实隔离验收还发现 PreToolUse 将运行时注入的 StructuredOutput 误当写工具。已添加“数据提交可用／Write 仍拒绝”的真实 SDK 协议回归，并在新合成会话中验证 schema 工作流完成。没有通过放宽 Bash、Write、插件或 MCP 解决该问题。
