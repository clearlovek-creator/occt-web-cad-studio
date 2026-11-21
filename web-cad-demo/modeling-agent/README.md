# Modeling Agent 第一阶段实现

这是建模智能体第一阶段的 Python 实现，当前完成的是“可暂停、可恢复、可审批、可验证”的最小闭环。

## 本地运行

在 modeling-agent 目录执行：

~~~powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -q
~~~

如果当前环境的 pytest 进程在测试完成后不退出，也可以使用：

~~~powershell
python -m unittest discover -s tests -v
~~~

启动 API：

~~~powershell
$env:PYTHONPATH = "src"
$env:MODEL_AGENT_DATA_PATH = ".data/agent-state.json"
uvicorn modeling_agent.main:app --reload
~~~

连接现有 Gateway/OCCT Worker 时，先设置：

~~~powershell
$env:MODEL_AGENT_GATEWAY_URL = "http://127.0.0.1:8788"
uvicorn modeling_agent.main:app --reload
~~~

## 当前实现

- 领域契约：Run、Goal、Action、Approval、Observation、Verification。
- 三层路由：输入路由、工作流路由、局部 Tool 路由。
- Context Engine：按节点构造、来源追踪、Revision 新鲜度。
- LangGraph：真实审批中断和恢复。
- LocalWorkflowEngine：离线可运行的确定性闭环。
- FakeGeometryAdapter：默认的离线契约测试适配器；设置 `MODEL_AGENT_GATEWAY_URL` 后会切换到 HTTP Gateway 适配器。
- HttpGeometryAdapter：已打通现有 Gateway 的 `document.summary`、`primitive.box` 协议，并做米到毫米的单位转换。
- JsonRepository：本地重启恢复。
- SQLAlchemy 模型、SqlAlchemyRepository 和 Alembic 迁移（包含追问与幂等记录）。
- FastAPI Run、回复、审批、取消和 SSE 事件接口。

## 路由与上下文管理

入口先经过 `POST /api/v1/agent/route`。它只负责判断这是新建、继续、审批、取消、查询、修改还是普通问答。路由查询会按 `project_id + user_id` 找活跃 Run；多个 Run 同时匹配时返回澄清，不会猜错对象。

进入 LangGraph 后，每个节点都由 `ContextEngine` 生成自己的 ContextPack：目标快照、当前用户意图、文档 Revision、最近观察、当前计划片段、该节点允许使用的 Tool，以及来源和新鲜度。ContextPack 有最大字符预算，超限时先丢知识和旧观察，最后才对低优先级摘要做硬截断，并记录 `budgets.used_chars` 与 `budgets.truncated`。

## 结构化 LLM Planner 与材料/仿真边界

自然语言 Run 不再由固定模板拆分任务。LangGraph 的 planning 节点会调用结构化 LLM Planner，要求模型返回 Task DAG：

- 每个任务包含 `task_id`、Tool、参数、依赖、成功标准和审批组；
- Planner 校验 Tool 是否在 Capability Registry 中、参数是否符合 schema、依赖图是否有环、文档作用域是否正确；
- 系统按拓扑序编译为执行计划，并按 `approval_group` 合并审批；
- LLM 只负责提出 DAG，Policy、Revision、幂等、执行和验证仍由确定性代码控制。

如果没有配置 LLM，直接输入自然语言 Patch 任务会返回 `PLANNER_REQUIRED`，不会静默退化成一个 Box。显式传入 `template_id` 只用于离线契约测试和兼容性预览，不是自然语言任务的默认拆分路径。

Planner 生成的计划仍会输出：

- 基板和导体的材料需求（介电常数/电导率），但第一阶段只把它们作为可审计计划数据；
- `simulation_preflight`，列出频段、边界、激励、网格和输出请求等仿真前置项；
- `execution_boundary=geometry_only`，明确本阶段不会启动求解器。

模板动作在验证失败后按逆序调用 Gateway `document.undo`。Gateway 会在首次写入前保存空文档检查点，因此可以回到模板开始前；如果 Revision 已被外部修改，回滚会停止并把失败原因写入事件，避免覆盖他人的修改。

## 当前明确限制

- 理论计算已替换为矩形微带贴片闭式初始估算，但仍不是完整天线设计。
- 未设置 `MODEL_AGENT_GATEWAY_URL` 时默认使用 FakeGeometryAdapter；设置为现有 Gateway 地址后可执行真实的创建、观察、版本校验闭环。
- 尚未接入真实仿真求解器。
- JsonRepository 只适合本地开发；团队和生产使用 PostgreSQL。
- LangGraph 主图在提供 runtime 时会真实调用 ExecutionService、GeometryPort 和 GeometryVerifier；无 runtime 时仅用于协议测试。

## 使用 LangGraph 主图模式

除了默认的本地确定性引擎，还可以启动真正的 LangGraph 工作流：

~~~powershell
$env:MODEL_AGENT_WORKFLOW_ENGINE = "langgraph"
$env:MODEL_AGENT_CHECKPOINT_PATH = ".data/langgraph-checkpoints.bin"
$env:MODEL_AGENT_GATEWAY_URL = "http://127.0.0.1:8788"
$env:PYTHONPATH = "src"
uvicorn modeling_agent.main:app --reload
~~~

LangGraph 模式会把追问、审批、Action、Gateway 执行、文档观察和几何验证放在同一张可恢复的主图中。服务重启后，JSON Checkpoint 可以恢复等待中的节点；生产环境应替换为 PostgreSQL Checkpointer。

## 理论计算

矩形微带贴片初始尺寸使用统一的闭式估算服务：根据频率、基板厚度和相对介电常数计算贴片宽度、有效介电常数、边缘延伸和长度。结果会记录假设、警告和置信度，并明确提示仍需全波仿真校准。

## 参数化贴片模板

兼容性接口仍可以预览参数化计划：

~~~http
POST /api/v1/agent/modeling/plan
~~~

返回的计划包含基板和贴片两个动作、每个动作的尺寸和原点、以及动作依赖。如果 Run 创建时指定?

~~~json
{"template_id":"antenna.rectangular_patch_stack"}
~~~

该接口使用显式模板生成兼容性计划；自然语言 Run 不会自动选择模板。

### LLM Planner / theory model

Set `MODEL_AGENT_LLM_BASE_URL`, `MODEL_AGENT_LLM_MODEL` and optionally `MODEL_AGENT_LLM_API_KEY` to enable both the bounded theory subgraph and the structured LLM Planner. The planner uses the same OpenAI-compatible Chat Completions endpoint and requires JSON matching the Task DAG schema.
