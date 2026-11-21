# 建模智能体：路由与上下文管理落地说明

这两部分不是 LangGraph 的“附属功能”，而是 Agent 能不能稳定运行的基础设施。

## 1. 三层路由

### 1.1 输入路由：先判断用户这句话属于哪类请求

代码位置：`web-cad-demo/modeling-agent/src/modeling_agent/workflows/router.py`。

`InputRouter` 只做确定性分类，不直接执行 CAD 写操作：

| 输入类型 | 处理方式 |
|---|---|
| 创建/生成/建模 | 创建新的 Run，进入需求解析 |
| 继续回答追问 | 绑定唯一的 `WAITING_USER` Run |
| 审批/拒绝 | 绑定唯一的待审批 Run；没有唯一目标时澄清 |
| 修改频率、尺寸等 | 绑定唯一的活跃 Run；多个 Run 时必须澄清 |
| 查询当前模型/文档 | 走只读查询路径 |
| 原理/为什么 | 走直接问答路径 |
| 取消/停止 | 绑定唯一的活跃 Run |
| 无法判断 | `CLARIFY_ROUTE`，不会猜测并进入写流程 |

输入路由的结果是 `RoutingDecision`，包含路由类型、置信度、目标 Run、提取出的参数、风险提示、候选路由和路由版本。要定位已有 Run，接口必须同时提供 `project_id` 和 `user_id`；缺少作用域时只允许产生“新建任务”判断，不能扫描全局 Run。
置信度只是“判断把握”，不是执行授权；写操作仍必须经过 Schema、Capability、Policy、Approval、Revision 和 Execution。

### 1.2 工作流路由：根据已验证状态选择下一个节点

代码位置：`workflows/langgraph_adapter.py`。

LangGraph 条件边只读取结构化状态，不读取模型自由文本。当前关键路由包括：

```text
需求校验
  ├─ 缺字段        -> request_user_input
  └─ 完整          -> theory_analysis

理论分析
  ├─ ReAct/Schema 失败 -> fail_run
  └─ 成功              -> build_plan

审批
  ├─ approve       -> execute_action
  └─ reject/edit   -> request_replan -> 重新需求/计划/审批

观察
  ├─ 临时工具错误  -> recover_transient
  └─ 其他          -> verify_result

验证
  ├─ 成功          -> complete_run
  ├─ 模板失败      -> rollback_actions
  └─ 其他失败      -> fail_run
```

### 1.3 恢复路由：失败后不能统一重试

代码位置：`workflows/recovery.py`。

`RecoveryRouter` 根据 `ErrorClass`、重试次数和“结果是否未知”选择有限路径：

- 临时错误：重试同一个幂等 Action；
- 写入结果未知：先查询 Action 状态，不能盲目再次写入；
- Revision 冲突：刷新世界模型或要求用户决定；
- 验证失败：回滚或重新规划；
- 用户可修复：回到需求澄清；
- 权限/不可恢复错误：直接停止并留下审计记录。

## 2. 上下文管理

代码位置：`context/engine.py`。

模型每次看到的不是整段聊天记录，而是当前节点专用的 `ContextPack`，包含：

- 当前 Goal 快照；
- 当前用户意图；
- 当前文档/世界模型摘要；
- 当前计划切片；
- 最近 Observation；
- 当前节点允许使用的 Tool；
- 知识片段、来源、信任级别；
- Goal Version、Document Revision、Tool Registry Version 等新鲜度信息。

### 2.1 为什么要“节点级”上下文

理论分析节点只需要目标、公式和只读工具；执行节点需要 Action、审批、Revision 和写工具。
如果所有节点共享同一份大上下文，模型容易看到不该看到的工具，也容易引用旧文档状态。

### 2.2 上下文预算

`ContextBudget` 控制最大条数和最大字符数。超预算时按以下顺序裁剪：

```text
知识片段 -> 旧 Observation -> 计划尾部 -> 用户意图 -> 世界摘要 -> Goal
```

裁剪结果会写入 `budgets.used_chars` 和 `budgets.truncated`，方便审计。

### 2.3 上下文失效和重建

`ContextEngine.is_fresh()` 会对比当前 Run 的：

- `goal_version`；
- `document_revision`；
- `tool_registry_version`；
- 可选的 `plan_version` 和 `policy_version`。

任何一项变化，旧 `ContextPack` 都不再可信，`require_fresh()` 会抛出 `ContextStaleError`。
构建上下文时，文档 Revision 以 Repository/Worker 的当前值为准，不接受调用方传入的旧 Revision 覆盖。

LangGraph 的节点包装器在节点执行前构建一次上下文，在节点执行后再构建一次。这样 Action 写入或用户恢复后，下游节点拿到的是新 Revision、新 Goal 的快照，而不是写入前的旧快照。

## 3. 一次请求的完整路径

```text
用户消息
  -> InputRouter
  -> 选定 Run / 必要时澄清
  -> LangGraph 条件路由
  -> 节点级 ContextEngine
  -> Agent/Tool
  -> Observation 更新世界状态
  -> 重新构建 ContextPack
  -> Verification / Recovery / 下一节点
```

## 3.2 Policy 决策

每个 Action 在执行前经过结构化 `PolicyDecision`：记录是否允许、是否需要审批、工具风险级别、副作用类型、策略版本和原因。图根据这个结果选择“审批”“直接执行”或“拒绝”，而不是把审批写死在某个节点里。
## 3.1 写入结果未知时的安全分支

如果 Worker 超时或网络断开，Agent 不把它当作普通失败重试。图会先进入 `query_action_status`：

- 先查本地幂等记录；
- 查到已保存 Observation 时直接进入验证；
- 查不到时标记 `ACTION_STATUS_UNKNOWN`，进入人工核对/失败态；
- 在确认外部动作结果前，不会再次提交 CAD 写命令。
## 4. 当前安全边界

目前只保留内部 ContextEngine，没有新增未接入认证的“任意 Run 上下文查询”网络接口。
上下文包含项目目标、文档状态和工具权限；正式开放查询接口前，应先接入用户、项目、文档和 Run 的授权校验，并确保查询条件不能跨项目。

## 5. 测试覆盖

当前测试覆盖：

- 多个活跃 Run 时，修改请求必须澄清；
- Goal Version 变化后旧 ContextPack 失效；
- Document Revision 变化后旧 ContextPack 失效；
- 调用方传入旧世界模型 Revision 时，ContextEngine 使用权威 Revision；
- 上下文字符预算和裁剪规则；
- 理论节点不会拿到写 Tool；
- LangGraph 节点在状态变更后重建上下文。

## 6. 对外接口与内部职责边界

为了避免路由器、工作流、上下文引擎互相调用成一团，阶段一固定了下面的边界：

| 部件 | 负责什么 | 不负责什么 |
|---|---|---|
| `InputRouter` | 把一句用户话映射为 `RoutingDecision`，选择目标 Run | 不创建 Action，不直接调用 CAD，不绕过审批 |
| `WorkflowEngine` | 驱动 Run 状态机、恢复中断、接受回答、审批、取消 | 不把自然语言当作文档事实 |
| `ContextEngine` | 按节点生成受预算和作用域约束的 `ContextPack` | 不改变文档，不替代 World Model |
| `CapabilityRegistry` | 声明工具参数 Schema、权限、风险和超时 | 不执行工具 |
| `ExecutionService` | 做参数校验、幂等、Revision 检查、审批检查后调用工具 | 不决定用户意图 |

推荐的请求顺序是：

```text
POST /agent/route
  -> 选择唯一 Run（或返回 clarify_route）
  -> WorkflowEngine.respond / decide_approval / change_parameters
  -> 节点前 ContextEngine.build
  -> ReAct 只产生结构化计划或工具调用
  -> ExecutionService 执行并产生 Observation
  -> 节点后重新 ContextEngine.build
  -> Verification / Recovery 决定下一条边
```

关键点：`/agent/route` 是分流口，不是执行口。即使路由置信度很高，写操作仍要经过计划校验、Capability Schema、Policy、Approval、Revision 和验证。

## 7. 当前状态如何被前端可靠消费

`GET /api/v1/agent/runs/{run_id}` 返回权威生命周期状态；`GET /events` 是权威时间线。前端不要根据聊天文本猜测进度，而应使用：

- `status`：`running`、`waiting_user`、`waiting_approval`、`paused`、`completed`、`failed`、`cancelled`；
- `current_stage`：当前所在阶段；
- `run_version`：当前 Run 的乐观并发版本；提交回答、审批、参数修改或取消时可带 `expected_run_version`，迟到请求会被拒绝；
- `progress`：阶段进度和已完成 Action 数；
- `waiting_request_id` / `waiting_approval_id`：需要用户继续操作时的句柄；
- `pending_input` / `pending_approval`：可直接渲染的追问或审批内容；
- `document_revision`：计划和动作所依据的最新文档版本；
- `latest_observation` / `artifact_refs`：最近一次真实执行证据；
- SSE `Last-Event-ID`：断线后从上次序号继续回放。

`POST /pause` 和 `POST /resume` 只允许在追问、审批或外部等待边界执行；不会强行打断正在执行的 CAD 写操作。`GET /events?follow=true&wait_seconds=30` 支持持续跟随；终态 Run 会自动关闭流，超时会发送 `: stream-timeout`。这样浏览器刷新、网络断开或服务重启后，仍可从持久化事件恢复界面，而不是重复调用模型。

## 8. 生产化前仍需补齐的项目

阶段一已经把接口和约束固定下来，但以下内容留给接入真实生产基础设施时完成：

1. 将 JSON 检查点替换为 PostgreSQL 事务仓库；当前 SQLAlchemy Checkpointer 已按 `thread_id` 分行，旧单行表仅作为迁移兼容回退；
2. 在所有网络接口前增加用户、项目、文档、Run 的授权过滤；
3. 把路由规则、工具 Registry、Policy 和 Graph 版本写入可审计的配置发布流程；
4. 对 ContextPack、路由决策、工具调用和 Observation 接入 trace/span，并设置敏感字段脱敏；阶段一已提供 OTel Span 和脱敏的调用次数/耗时聚合；
5. 仿真设置、求解器、结果分析作为后续子图接入，不能在阶段一绕过 `geometry_only` 边界。


## 9. 本轮阶段一补强

为让路由、上下文和执行链更适合持续运行，本轮又补了几项工程契约：

- 所有事件默认把前一个事件写入 `causation_id`，因此可以沿着 Run 的事件流追踪“谁触发了谁”；首个事件的原因为空是正常的。
- LangGraph 的正常执行、瞬时恢复和未知写入结果都会写入 `observation.recorded`，状态接口的 `latest_observation` 只来自真实执行证据。
- 数据库初始化会释放 SQLAlchemy engine，避免本地 SQLite 或测试环境出现文件锁。
- `/route`、Run、回答、审批、参数修改、暂停恢复和建模计划预览都使用 Pydantic v2 请求模型；未知字段在进入工作流前返回 422。
- 仓库新增独立 CI：固定 Python 3.13，执行源码编译、75 个测试、Alembic 升级/回退冒烟检查。

这几项不会改变后续仿真子图的边界；仿真仍然只能通过新的 Graph Node、Tool 和 Artifact 接入。
