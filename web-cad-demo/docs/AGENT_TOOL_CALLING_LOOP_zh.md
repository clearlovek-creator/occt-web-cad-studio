# 历史兼容实现：Tool Calling 外层循环架构

> 当前工作台使用 Pi RPC + CAD MCP，不使用本文旧服务端循环作为默认 Agent。当前职责、能力协商及工程前置条件以 [AGENT_ARCHITECTURE_zh.md](./AGENT_ARCHITECTURE_zh.md) 开头的当前实现章节为准。以下仅保留历史接口说明，不代表工作台仍有 Plan/Edit 或确认弹窗。

## 目标与硬约束

1. Agent 不允许切换到 Local 规则解析。没有可用 Provider 时，只能提示用户配置大模型。
2. 大模型只能通过已声明的 CAD Tool Calling 与 Web Studio 交互；模型不能直接访问 OCCT Worker。
3. Gateway 是 Agent Loop 的控制者，负责会话、工具白名单、权限确认、工具执行、错误回传和停止条件。
4. Plan 模式只暴露查询/测量工具；Edit 模式才暴露几何修改工具。

## 运行链路

```text
用户输入
  -> ModelingAgentPanel
  -> ModelingController.streamAgentRun()
  -> POST /api/agent/run/stream
  -> Gateway 读取 Conversation Store 和当前 CAD Model
  -> requestCadToolTurn()（OpenAI Responses / Chat Completions）
  -> 模型返回 CAD Tool Call
  -> Gateway 校验 Tool 名称、参数、Body/Feature/Topology 引用和风险
  -> command() / executeMutation() 访问 Web Studio Command Bus
  -> 保存 assistant Tool Call + tool Tool Result
  -> 重新读取压缩后的会话上下文
  -> 下一轮模型调用
  -> final text / needs-input / awaiting-confirmation / max-turns
```

前端不再执行模型返回的建模计划。服务端执行成功的结果通过 SSE `run` 事件返回，前端只负责刷新模型状态和显示结果。

## OpenCode 风格 Agent Loop

`gateway/server.mjs` 中的 `runAgentLoop()` 对每一轮执行以下动作：

- 从持久化会话重新加载消息，而不是只依赖内存上下文；
- 重建 system prompt、当前模式和可用 Tool 集合；
- 调用一次模型；
- 保存模型输出和每个 Tool Call；
- 执行工具并保存 `role: tool` 的结果；
- 将工具错误也作为 Tool Result 回传，让模型在下一轮修正参数；
- 没有 Tool Call 时结束；达到 `AGENT_LOOP_MAX_TURNS` 时安全停止。

Chat Completions 使用结构化消息：

```text
system -> user -> assistant(tool_calls) -> tool(tool_call_id) -> assistant ...
```

Responses API 使用 `function_call` / `function_call_output` 输入项。两种协议都使用相同的 CAD Tool 定义和执行器。

## Tool 分层

### 查询工具

- `query_model`：几何树、Body、Feature、变量、材料、坐标系、历史；
- `measure_geometry`：Body、Face、Edge 测量。

### 修改工具

- 基础体、变换、Boolean；
- Feature 编辑、圆角、倒角、Pattern；
- 变量、材料、坐标系和 Body/Face/Edge 属性；
- 删除、Undo、Redo 等生命周期操作。

`toolDefinitionsForProtocol()` 根据 `mode` 过滤工具。Plan 模式不会把修改工具发送给模型；即使模型越权返回修改工具，Gateway 也会返回 `blocked`，不会调用 CAD Worker。

## 安全与确认

以下操作需要确认：Boolean、Body 删除、Feature 生命周期修改、Undo/Redo 等高风险操作。

确认流程：

1. Gateway 保存 `activePlan`、`pendingPrompt` 和原始 `pendingToolCall`；
2. 前端显示确认卡片；
3. 用户确认后再次调用 `/api/agent/run/stream`，带 `confirmed: true`；
4. Gateway 优先恢复并执行保存的原始 Tool Call，不让模型在恢复轮次中替换目标；
5. 执行结果继续进入下一轮模型上下文。

## 错误恢复与重试

- 网络错误、超时、HTTP 408/429/5xx 按指数退避重试；
- Tool 参数 JSON 错误、未知 Tool、Schema 校验错误和 CAD 执行错误都会保存为 Tool Result；
- 下一轮模型可以读取错误并修正调用；
- 不会退回 JSON 计划，也不会退回 Local 规则解析。

## 会话与上下文压缩

`gateway/agent-conversation-store.mjs` 持久化：

- `user`、`assistant`、`tool`、`system` 消息；
- Tool Call ID、Tool 名称、Tool 参数、Tool Result；
- 当前计划、待确认调用和上下文摘要。

`gateway/llm/context-manager.mjs` 保留最近消息，并将更早消息压缩为摘要和关键事实。每一轮重新读取会话并生成模型消息，避免上下文只存在于单次请求的内存中。

## 前端职责

- `ModelingAgentPanel`：CLI 风格对话、Plan/Edit 切换、历史会话和确认 UI；
- `ModelingController.streamAgentRun()`：消费 SSE `start`、`tool-call`、`tool-result`、`plan`、`run`、`error` 事件；
- 前端不调用 `executePlan()` 来执行 Agent 生成的几何，避免重复执行。

## 当前接口

| 接口 | 用途 |
|---|---|
| `POST /api/agent/run/stream` | 启动或恢复一次外层 Agent Loop |
| `POST /api/agent/conversations/:id/state` | 保存计划和待确认 Tool Call |
| `POST /api/agent/model/query` | 直接查询 Web Studio 模型上下文 |
| `GET/POST /api/agent/conversations` | 会话列表、创建、读取和消息持久化 |
| `GET /api/agent/audit` | Agent 和 CAD 执行审计 |

旧的 `/api/agent/plan` 接口仅作为兼容测试入口保留，当前 Web UI 不使用它执行几何；所有实际 Agent 建模都走 `/api/agent/run/stream`。

## 验证要求

至少覆盖：

- 无 Provider 时不会调用 Local 解析器；
- Edit 模式创建几何后，第二轮模型能看到 Tool Result；
- Tool 错误会触发下一轮修正；
- Plan 模式不会改变几何 Revision；
- 高风险 Tool Call 可暂停、确认并恢复；
- 会话重载后仍保留 Tool Call/Result 和上下文摘要；
- OpenAI Responses、Chat Completions 和 SSE 均通过 Tool Calling。
- 思考模式兼容：Chat Completions 返回的 `reasoning_content` 会随助手工具调用保存到会话，并在下一轮携带工具结果时原样回传，避免 DeepSeek 的 `reasoning_content must be passed back` 协议错误。
