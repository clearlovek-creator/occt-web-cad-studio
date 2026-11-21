# 建模智能体 Python 第一阶段实施方案

> 文档状态：可执行开发基线\
> 适用工程：`web-cad-demo`\
> 开发语言：Python 3.13\
> 核心编排：LangGraph\
> 文档日期：2026-08-06\
> 对应总架构：`MODELING_AGENT_TARGET_ARCHITECTURE_zh.md`

## 0. 先说结论

第一阶段不是开发一个完整的天线设计智能体，也不是马上接入真实仿真求解器。

第一阶段要完成的是一副能够长期使用的“智能体骨架”，并跑通一个小而真实的闭环：

~~~text
用户输入一个简单天线需求
    ↓
系统把需求转换为结构化目标
    ↓
发现信息不足时暂停并追问
    ↓
生成初步理论参数和建模计划
    ↓
涉及写模型时请求用户批准
    ↓
通过受控执行器调用现有 OCCT Worker
    ↓
读取实际执行结果
    ↓
用确定性规则验证
    ↓
保存 Run、事件、模型 Revision 和结果
    ↓
向用户说明完成结果
~~~

这个闭环不追求第一天就会设计各种天线，而是证明下面这些基础能力成立：

1. Agent 有明确状态，不依赖聊天记录猜测当前进度。
2. LangGraph 能暂停、恢复、分支和循环。
3. 业务数据模型不与 LangGraph、LangChain 或某个模型厂商绑定。
4. ReAct 只能在划定的小范围内运行，并且有次数、时间和工具权限限制。
5. LLM 不能直接修改 CAD；写操作必须经过 Policy、Approval、Execution、Observation 和 Verification。
6. 每个写动作都有 Revision 和幂等键，重试不会重复创建模型。
7. 服务重启后，Run 可以从持久化状态恢复。
8. 前端可以实时看到当前阶段、工具调用、等待原因和最终结果。
9. 后续理论分析、仿真配置、求解和结果分析都可以作为子图接入，不需要推翻第一阶段。

建议第一阶段用 4 周完成。若只有一名开发者，按 6 至 8 周估算更现实。

## 1. 第一阶段的边界

### 1.1 第一阶段必须完成

- 建立独立 Python Agent 服务。
- 建立领域模型和版本化的数据契约。
- 引入 LangGraph，搭建顶层工作流骨架。
- 实现输入路由、工作流路由、恢复路由和局部 Tool 路由。
- 实现按节点构造 Context Pack 的 Context Engine。
- 实现结构化需求解析。
- 实现缺失信息追问和恢复。
- 实现一个有界的理论分析或规划 ReAct 子图。
- 实现 Tool/Capability Registry。
- 实现最小 Policy 和 Approval。
- 实现统一 Action Envelope。
- 实现一个现有 OCCT 能力的真实端到端调用。
- 实现 Observation 和确定性 Verification。
- 实现 Run、Event、Action、Approval 的持久化。
- 实现 LangGraph 持久化 Checkpointer。
- 实现 SSE 实时事件接口。
- 实现取消、超时、有限重试和服务重启恢复。
- 建立单元、契约、集成和最小端到端测试。
- 接入基础 OpenTelemetry Trace。

### 1.2 第一阶段只做一个真实建模样例

建议选择现有系统最稳定的建模能力作为样例，例如：

~~~text
根据结构化参数创建一个矩形介质基板或矩形贴片基础体
~~~

如果当前 OCCT Worker 的 Box 命令最成熟，就先用 Box 跑通闭环。第一阶段的目标是验证 Agent 架构，不是用第一个样例证明完整天线建模能力。

样例至少要覆盖：

- 输入参数和单位。
- 生成写 Action。
- 用户审批。
- expected revision 检查。
- 调用 Worker。
- 得到新的 model revision。
- 查询实际尺寸或包围盒。
- 将实际结果与期望参数比较。
- 成功提交或失败回滚。

### 1.3 第一阶段明确不做

- 不接入完整电磁仿真求解器。
- 不实现真实网格生成闭环。
- 不实现天线全品类理论库。
- 不做自动参数优化。
- 不做自由多智能体协作。
- 不做长期用户记忆。
- 不做多租户 SaaS。
- 不做复杂权限体系。
- 不做分布式任务调度。
- 不允许 Agent 自己安装 Tool 或 Skill。
- 不让 LLM 直接生成并执行任意 Python、Shell 或数据库语句。

这些能力可以预留接口，但不能干扰第一阶段闭环。

## 2. 第一阶段完成后，用户能看到什么

建议用下面这个演示作为第一阶段的最终验收场景。

### 2.1 演示输入

用户输入：

~~~text
帮我创建一个工作在 2.45 GHz 的矩形微带贴片天线初始模型，
基板使用 FR-4，厚度 1.6 mm。
~~~

### 2.2 系统行为

1. 创建一个 Agent Run。
2. 将自然语言转换为 `AntennaRequirements`。
3. 发现基板尺寸、铜层厚度或设计目标缺失。
4. 根据规则判断哪些信息可以使用明确默认值，哪些必须询问用户。
5. 通过 LangGraph `interrupt` 暂停并发出结构化追问。
6. 用户补充答案后，使用同一个 `run_id/thread_id` 恢复。
7. 理论分析节点调用受控公式工具，生成初始贴片尺寸建议。
8. Planner 生成结构化建模计划。
9. Policy 判断建模是写操作，创建 Approval Request。
10. 用户查看将要创建的对象、参数和影响范围。
11. 用户批准后继续运行。
12. Execution Engine 调用 OCCT Worker 执行一个真实建模动作。
13. Observer 查询新的模型状态和 Revision。
14. Verifier 检查实际尺寸、对象存在性和几何有效性。
15. 保存结果并将 Run 标记为 Completed。
16. 前端显示完成摘要、模型 Revision、使用的参数和仍未实现的后续仿真阶段。

### 2.3 服务重启验证

演示过程中在“等待用户补充”或“等待审批”状态停止 Python 服务，然后重启：

- Run 仍然存在。
- 当前等待原因没有丢失。
- 用户可以继续回答或审批。
- 已经执行成功的写 Action 不会重复执行。

如果这一条做不到，第一阶段不能算完成。

## 3. 总体结构

第一阶段采用下面的运行结构：

~~~text
Web 前端
   │
   │ HTTP + SSE
   ▼
Python Agent API（FastAPI）
   │
   ├── Run Service
   ├── LangGraph Workflow Engine
   ├── Requirement Agent
   ├── Theory/Planning ReAct 子图
   ├── Policy / Approval
   ├── Execution Engine
   ├── Observer / Verifier
   └── Event Publisher
          │
          ├── PostgreSQL
          │     ├── 业务表
          │     └── LangGraph Checkpoint
          │
          └── Geometry Adapter
                    │ HTTP/JSON
                    ▼
             现有 Gateway / OCCT Worker
~~~

核心原则：

> LangGraph 管流程；领域服务管规则；Execution Engine 管副作用；OCCT Worker 管权威几何。

## 4. 为什么第一阶段就使用 LangGraph

在需求较简单时，可以先写普通 Python 状态机。但当前已知目标包含：

- 理论分析。
- 参数化建模。
- 仿真设置。
- 长时间求解。
- 结果查询。
- 参数修改。
- 每个阶段都有局部 ReAct。
- 人工确认和中途修改。

如果先写一个临时的大循环，第二阶段很可能需要整体迁移。因此第一阶段就应该建立 LangGraph 主图。

但不能把业务对象直接写成 LangGraph 专属对象。需要定义一个内部接口：

~~~python
from typing import Protocol

class WorkflowEngine(Protocol):
    async def start(self, run_id: str, initial_input: dict) -> None: ...
    async def resume(self, run_id: str, user_input: dict) -> None: ...
    async def cancel(self, run_id: str, reason: str) -> None: ...
    async def get_status(self, run_id: str) -> dict: ...
~~~

第一阶段实现：

~~~text
LangGraphWorkflowEngine
~~~

这样领域层依赖 `WorkflowEngine`，而不是到处直接调用 LangGraph API。

## 5. 推荐工程目录

建议在现有工程下增加独立目录：

~~~text
web-cad-demo/
├── modeling-agent/
│   ├── pyproject.toml
│   ├── README.md
│   ├── alembic.ini
│   ├── migrations/
│   ├── src/
│   │   └── modeling_agent/
│   │       ├── main.py
│   │       ├── api/
│   │       │   ├── dependencies.py
│   │       │   ├── errors.py
│   │       │   ├── runs.py
│   │       │   ├── approvals.py
│   │       │   └── events.py
│   │       ├── domain/
│   │       │   ├── goals.py
│   │       │   ├── runs.py
│   │       │   ├── plans.py
│   │       │   ├── actions.py
│   │       │   ├── approvals.py
│   │       │   ├── observations.py
│   │       │   ├── verification.py
│   │       │   ├── revisions.py
│   │       │   ├── artifacts.py
│   │       │   └── errors.py
│   │       ├── application/
│   │       │   ├── run_service.py
│   │       │   ├── approval_service.py
│   │       │   ├── action_service.py
│   │       │   └── recovery_service.py
│   │       ├── workflows/
│   │       │   ├── protocol.py
│   │       │   ├── state.py
│   │       │   ├── main_graph.py
│   │       │   ├── routing.py
│   │       │   ├── nodes/
│   │       │   └── subgraphs/
│   │       ├── context/
│   │       │   ├── engine.py
│   │       │   ├── pack.py
│   │       │   ├── budgets.py
│   │       │   ├── provenance.py
│   │       │   ├── freshness.py
│   │       │   └── builders/
│   │       ├── agents/
│   │       │   ├── requirement_agent.py
│   │       │   ├── theory_agent.py
│   │       │   └── planner_agent.py
│   │       ├── capabilities/
│   │       │   ├── registry.py
│   │       │   ├── schemas.py
│   │       │   └── builtins/
│   │       ├── execution/
│   │       │   ├── engine.py
│   │       │   ├── policy.py
│   │       │   ├── idempotency.py
│   │       │   └── transaction.py
│   │       ├── verification/
│   │       │   ├── geometry.py
│   │       │   └── requirements.py
│   │       ├── adapters/
│   │       │   ├── llm/
│   │       │   ├── geometry/
│   │       │   ├── persistence/
│   │       │   └── telemetry/
│   │       └── settings.py
│   └── tests/
│       ├── unit/
│       ├── property/
│       ├── contract/
│       ├── integration/
│       ├── e2e/
│       ├── evals/
│       └── fixtures/
└── docs/
~~~

第一阶段不要按“每个 Agent 一个微服务”拆分。先保持一个 Python 服务、清晰模块边界，避免过早引入分布式复杂度。

## 6. Python 依赖建议

第一阶段核心依赖：

~~~text
Python 3.13
FastAPI
Uvicorn
Pydantic v2
pydantic-settings
LangGraph
LangChain Core
具体模型厂商适配包
SQLAlchemy 2
Alembic
asyncpg
HTTPX
OpenTelemetry API/SDK
pytest
pytest-asyncio
Hypothesis
respx
~~~

依赖原则：

1. 使用 `pyproject.toml` 管理项目。
2. 生成锁文件，CI 和生产必须按锁文件安装。
3. LangChain 只引入实际需要的包，不安装大量未使用的集成。
4. 领域层不能 import LangGraph、LangChain、FastAPI 或 SQLAlchemy。
5. 模型厂商 SDK 封装在 `adapters/llm` 中。
6. SQLite 只用于快速单元测试；正式联调直接使用 PostgreSQL。

## 7. 第一阶段领域模型

### 7.1 Run

Run 表示用户发起的一次完整工作任务。

~~~python
from datetime import datetime
from enum import StrEnum
from pydantic import BaseModel

class RunStatus(StrEnum):
    CREATED = "created"
    RUNNING = "running"
    WAITING_USER = "waiting_user"
    WAITING_APPROVAL = "waiting_approval"
    WAITING_EXTERNAL = "waiting_external"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class AgentRun(BaseModel):
    id: str
    project_id: str
    document_id: str
    user_id: str
    status: RunStatus
    current_stage: str
    goal_version: int
    graph_version: str
    config_snapshot_id: str
    created_at: datetime
    updated_at: datetime
~~~

### 7.2 Goal

Goal 不能只保存用户原话，还要保存结构化成功标准。

~~~python
class AntennaGoal(BaseModel):
    original_request: str
    antenna_type: str | None
    center_frequency_hz: float | None
    bandwidth_hz: float | None
    min_gain_dbi: float | None
    max_s11_db: float | None
    substrate_material: str | None
    substrate_thickness_m: float | None
    constraints: list[str]
    assumptions: list[str]
    success_criteria: list["SuccessCriterion"]
~~~

第一阶段只支持少量字段，但字段必须有：

- 明确单位。
- 数据来源。
- 是用户输入、系统默认还是理论推导。
- 是否已经由用户确认。

### 7.3 Action

Action 是 Agent 想执行的动作，不等于动作已经执行。

~~~python
class ActionRequest(BaseModel):
    action_id: str
    run_id: str
    tool_name: str
    tool_version: str
    arguments: dict
    risk_level: str
    expected_document_revision: int | None
    idempotency_key: str
    reason: str
    success_criteria: list[dict]
~~~

### 7.4 Observation

Observation 必须来自系统真实返回，不能由 LLM 编造。

~~~python
class Observation(BaseModel):
    action_id: str
    success: bool
    result: dict
    before_revision: int | None
    after_revision: int | None
    artifact_refs: list[str]
    duration_ms: int
    error_code: str | None
~~~

### 7.5 Verification

~~~python
class VerificationResult(BaseModel):
    action_id: str
    passed: bool
    checks: list["VerificationCheck"]
    actual_values: dict
    failure_reason: str | None
    recommended_route: str | None
~~~

验证结果决定下一步，而不是让 LLM 只根据一句“执行成功”继续。

### 7.6 Approval

~~~python
class ApprovalRequest(BaseModel):
    approval_id: str
    run_id: str
    action_id: str
    action_hash: str
    summary: str
    impact: list[str]
    expires_at: datetime
    allowed_decisions: list[str]
~~~

用户批准必须绑定 `action_hash`。如果 Agent 在等待期间修改了动作参数，旧批准自动失效。

## 8. LangGraph State 设计

Graph State 是运行快照，不是业务数据库的替代品。

~~~python
from typing import TypedDict

class ModelingAgentGraphState(TypedDict, total=False):
    run_id: str
    project_id: str
    document_id: str
    user_id: str

    goal_id: str
    goal_version: int
    current_stage: str

    user_messages: list[dict]
    structured_goal: dict
    missing_fields: list[str]
    assumptions: list[dict]

    theory_artifact_ref: str | None
    plan_id: str | None
    current_action_id: str | None
    pending_approval_id: str | None

    expected_document_revision: int | None
    observed_document_revision: int | None

    last_observation: dict | None
    last_verification: dict | None
    retry_counts: dict[str, int]

    waiting_reason: str | None
    terminal_result: dict | None
    error: dict | None
~~~

State 设计规则：

- 保存原始数据和引用，不保存拼好的 Prompt。
- 不保存完整 BRep、网格或大型结果文件。
- 不把数据库 Session、HTTP Client 或函数放入 State。
- 所有字段必须可序列化。
- State Schema 必须带版本。
- 大对象只保存 Artifact Reference。

## 9. 第一阶段主图

### 9.1 主流程

~~~mermaid
flowchart TD
    A["START"] --> B["load_run_context"]
    B --> C["parse_requirement"]
    C --> D["validate_requirement"]
    D --> E{"是否缺少必要信息"}
    E -- "是" --> F["request_user_input"]
    F --> C
    E -- "否" --> G["theory_analysis_subgraph"]
    G --> H["build_modeling_plan"]
    H --> I["validate_plan"]
    I --> J{"计划是否有效"}
    J -- "否，可修复" --> H
    J -- "否，不可修复" --> X["fail_run"]
    J -- "是" --> K["prepare_action"]
    K --> L["evaluate_policy"]
    L --> M{"是否需要审批"}
    M -- "是" --> N["request_approval"]
    N --> O{"审批结果"}
    O -- "拒绝" --> P["handle_rejection"]
    P --> H
    O -- "批准" --> Q["execute_action"]
    M -- "否" --> Q
    Q --> R["observe_world"]
    R --> S["verify_result"]
    S --> T{"验证结果"}
    T -- "通过" --> U["complete_run"]
    T -- "可恢复" --> V["recover_or_replan"]
    V --> H
    T -- "不可恢复" --> X
    U --> Z["END"]
    X --> Z
~~~

### 9.2 每个节点只做一件事

| 节点 | 责任 | 是否调用 LLM | 是否允许副作用 |
|---|---|---:|---:|
| `load_run_context` | 读取 Run 和文档状态 | 否 | 否 |
| `parse_requirement` | 转换为结构化目标 | 是 | 否 |
| `validate_requirement` | 单位、字段和规则校验 | 否 | 否 |
| `request_user_input` | 生成追问并暂停 | 可选 | 只写等待状态 |
| `theory_analysis_subgraph` | 理论工具调用和候选参数 | 是 | 只读 |
| `build_modeling_plan` | 生成结构化计划 | 是 | 否 |
| `validate_plan` | Tool、参数和依赖校验 | 否 | 否 |
| `prepare_action` | 生成 Action Envelope | 否 | 只写业务记录 |
| `evaluate_policy` | 判断风险和审批要求 | 否 | 否 |
| `request_approval` | 创建审批并暂停 | 否 | 写审批记录 |
| `execute_action` | 通过执行器调用 Worker | 否 | 是 |
| `observe_world` | 查询真实文档和几何状态 | 否 | 只读 |
| `verify_result` | 确定性验证成功标准 | 否 | 否 |
| `recover_or_replan` | 错误分类和路由 | 部分情况 | 否 |
| `complete_run` | 固化结果和摘要 | 可选 | 写完成状态 |

### 9.3 Interrupt 的使用位置

第一阶段只在明确位置中断：

- 缺少必要用户信息。
- 需要确认默认假设。
- 写操作需要批准。
- Revision 冲突，需要用户决定刷新还是取消。
- 自动恢复次数耗尽。

中断载荷必须是结构化 JSON：

~~~python
class ElicitationRequest(BaseModel):
    request_id: str
    reason_code: str
    question: str
    expected_schema: dict
    choices: list[dict] | None
    current_value: object | None
    recommended_value: object | None
~~~

恢复时必须：

- 使用相同 `run_id`。
- 使用相同 LangGraph `thread_id`。
- 校验输入是否对应当前等待请求。
- 防止过期回答恢复错误的节点。

### 9.4 路由系统

路由不等于 LangGraph 里写几条条件边。第一阶段至少需要三层路由：

~~~text
第一层：输入路由——判断用户这句话是什么性质
第二层：工作流路由——根据当前 Run 状态决定进入哪个阶段
第三层：局部 Tool 路由——在 ReAct 子图内选择允许的 Tool
~~~

三层不能混成一次 LLM 分类，否则一句“帮我直接创建”可能绕过需求校验、审批和执行策略。

#### 9.4.1 输入路由

输入路由位于主图之前，负责判断新输入如何处理。

~~~python
from enum import StrEnum
from pydantic import BaseModel

class InputRoute(StrEnum):
    DIRECT_ANSWER = "direct_answer"
    READ_QUERY = "read_query"
    START_WORKFLOW = "start_workflow"
    CONTINUE_ACTIVE_RUN = "continue_active_run"
    CHANGE_ACTIVE_GOAL = "change_active_goal"
    APPROVAL_RESPONSE = "approval_response"
    CANCEL_RUN = "cancel_run"
    CLARIFY_ROUTE = "clarify_route"
    REJECTED = "rejected"

class RoutingDecision(BaseModel):
    route: InputRoute
    confidence: float
    reason_codes: list[str]
    target_run_id: str | None
    target_request_id: str | None
    extracted_payload: dict
    required_capabilities: list[str]
    risk_hint: str
    router_version: str
~~~

| 用户输入 | 路由 |
|---|---|
| “矩形贴片天线为什么通常是半波长？” | DIRECT_ANSWER |
| “当前模型里基板厚度是多少？” | READ_QUERY |
| “创建一个 2.45 GHz 的贴片天线” | START_WORKFLOW |
| 系统追问时回复“1.6 mm” | CONTINUE_ACTIVE_RUN |
| “把中心频率改成 5.8 GHz” | CHANGE_ACTIVE_GOAL |
| 在审批卡片选择“批准” | APPROVAL_RESPONSE |
| “停止这次任务” | CANCEL_RUN |
| 存在两个 Run 时只说“继续” | CLARIFY_ROUTE |

DIRECT_ANSWER 和 READ_QUERY 不必强制包装成完整建模 Run；简单问题走短路径，复杂任务才进入长期工作流。

#### 9.4.2 路由判断顺序

1. API 已明确的输入，例如审批和取消专用接口。
2. 当前 Run 是否处于 WAITING_USER 或 WAITING_APPROVAL。
3. 明确命令，例如取消、暂停、继续。
4. 确定性规则，例如只读查询和已知菜单动作。
5. LLM 结构化分类。
6. 低置信度或存在多个候选时追问。

能通过状态和规则判断的，不先交给 LLM 猜。用户点击“批准”按钮时应调用审批接口，不能再让模型判断“批准”的含义。

#### 9.4.3 置信度和安全回退

~~~text
confidence >= 0.85：进入候选路由
0.60 <= confidence < 0.85：结合 Run 状态和规则复核
confidence < 0.60：CLARIFY_ROUTE
~~~

置信度不是安全授权。即使置信度为 1.0，写操作仍必须经过：

~~~text
Schema → Capability → Policy → Approval → Revision → Execution
~~~

安全回退规则：

- 不确定是查询还是修改时，先按只读解释或追问。
- 不确定关联哪个 Run 时，不能自动选择。
- 不确定用户是否批准时，视为未批准。
- 不确定参数单位时，暂停追问。
- 不存在的路由或未知 Tool，直接拒绝。

#### 9.4.4 工作流路由

工作流路由位于 LangGraph 内部，依据结构化状态决定下一节点。

~~~python
def route_after_requirement_validation(
    state: ModelingAgentGraphState,
) -> str:
    if state.get("error"):
        return "fail_run"
    if state.get("missing_fields"):
        return "request_user_input"
    return "theory_analysis_subgraph"
~~~

工作流路由输入必须是已验证的 State、Verification Result、Policy Decision、Approval Decision 或 Error Classification。不能直接把模型自然语言当作边的条件。

| 路由点 | 主要依据 | 候选方向 |
|---|---|---|
| 需求校验后 | 缺失字段、冲突、单位 | 追问、理论分析、失败 |
| 理论分析后 | 置信度、适用条件 | 计划、追问、人工复核 |
| 计划校验后 | Tool 能力和参数 | 准备动作、重规划、失败 |
| Policy 后 | 风险和自治等级 | 自动继续、审批、拒绝 |
| Observation 后 | Tool 真实返回 | 验证、查状态、恢复 |
| Verification 后 | 成功标准 | 完成、修复、重规划、失败 |
| 用户改目标后 | 影响范围 | 重新分析、重建模、仅重算 |

#### 9.4.5 恢复路由

恢复不能只写成“失败就重试”。

~~~python
class RecoveryRoute(StrEnum):
    RETRY_SAME_ACTION = "retry_same_action"
    QUERY_ACTION_STATUS = "query_action_status"
    REFRESH_WORLD_MODEL = "refresh_world_model"
    REPLAN_CURRENT_STAGE = "replan_current_stage"
    RETURN_TO_REQUIREMENTS = "return_to_requirements"
    WAIT_FOR_USER = "wait_for_user"
    ESCALATE_TO_HUMAN = "escalate_to_human"
    FAIL_RUN = "fail_run"
~~~

- 只读 HTTP 连接失败：RETRY_SAME_ACTION。
- 写请求超时且结果未知：QUERY_ACTION_STATUS。
- Revision 冲突：REFRESH_WORLD_MODEL。
- 几何验证失败但参数可调整：REPLAN_CURRENT_STAGE。
- 用户目标发生实质变化：RETURN_TO_REQUIREMENTS。
- 自动恢复预算耗尽：ESCALATE_TO_HUMAN。

#### 9.4.6 局部 Tool 路由

~~~text
理论分析 → 只看到公式、材料查询、单位换算
建模规划 → 只看到能力查询和只读模型查询
执行节点 → 不让 LLM 自由选工具，只执行已批准 Action
~~~

Tool Router 输出必须先验证 Tool 是否存在、版本是否匹配、当前阶段是否允许、输入 Schema 是否通过以及预算是否足够。

#### 9.4.7 路由审计和测试

每次路由记录 routing_decision_id、run_id、输入事件、Router 版本、候选路由、最终路由、置信度、reason codes、是否调用 LLM 以及规则覆盖原因。

至少测试：

1. 简单理论问题走直接回答。
2. 只读问题不会进入写流程。
3. 创建请求进入长期 Run。
4. 追问回答绑定正确 request。
5. 两个活动 Run 下的模糊“继续”必须追问。
6. “批准”不能批准已变化或过期的 Action。
7. 用户修改目标触发新 Goal Version。
8. 低置信度不能自动进入写路径。
9. 任意路由都不能绕过 Policy。
10. Router 升级后旧 Run 保留原 Router Version。

### 9.5 上下文管理系统

上下文管理不是把所有聊天、Tool、CAD 文档和知识一次塞给模型。它要在正确时间，把当前节点真正需要、来源可信、版本新鲜、大小可控的信息交给模型。

第一阶段建立独立 ContextEngine：

~~~python
class ContextEngine(Protocol):
    async def build(
        self,
        *,
        run_id: str,
        node_name: str,
        budget: "ContextBudget",
    ) -> "ContextPack": ...
~~~

#### 9.5.1 三种状态必须分开

~~~text
业务事实
  Run、Goal、Action、Approval、Revision、Artifact
  存在业务数据库和权威 Worker

工作流状态
  当前节点、等待点、重试次数、最近结果引用
  存在 LangGraph Checkpoint

模型上下文
  为本次模型调用临时组装的 Context Pack
  使用后丢弃或按审计策略保存
~~~

模型上下文不能反过来成为业务事实来源。

#### 9.5.2 Context Pack

~~~python
class ContextSource(BaseModel):
    source_id: str
    source_type: str
    version: str | None
    trust_level: str
    captured_at: datetime
    document_revision: int | None

class ContextPack(BaseModel):
    context_pack_id: str
    run_id: str
    node_name: str
    goal_snapshot: dict
    current_user_intent: dict
    world_model_summary: dict
    active_plan_slice: list[dict]
    recent_observations: list[dict]
    applicable_constraints: list[dict]
    available_tools: list[dict]
    knowledge_excerpts: list[dict]
    pending_interaction: dict | None
    budgets: dict
    sources: list[ContextSource]
    freshness: dict
    context_schema_version: str
~~~

每个 Context Pack 必须说明信息来源、Goal Version、Document Revision、Tool Registry Version、获取时间、是否经用户确认，以及它是默认值还是模型推断。

#### 9.5.3 来源和可信度

允许来源：

- 当前用户输入。
- 已确认 Goal Snapshot。
- 当前 Run 状态。
- 当前文档的权威摘要。
- 当前 Action 和 Plan 的相关部分。
- 最近的 Observation 和 Verification。
- 当前节点允许的 Tool Schema。
- 审核过的天线公式和材料数据。
- 当前 Policy、预算和自治等级。

优先级：

~~~text
权威系统状态
  > 用户明确确认的信息
  > 已验证的工程 Artifact
  > 审核过的领域知识
  > 系统默认值
  > LLM 推断
~~~

来源冲突时按可信等级、版本、新鲜度和确认状态处理，不能简单采用最后一条。

#### 9.5.4 按节点裁剪

| 节点 | 必须提供 | 不应提供 |
|---|---|---|
| 需求解析 | 当前输入、已有 Goal、单位规则 | 全部几何数据、全部工具 |
| 理论分析 | 已确认需求、材料数据、公式工具、成功标准 | 写 CAD Tool、无关聊天 |
| 建模规划 | 理论结果、文档摘要、Capability Schema | 完整 BRep、仿真大结果 |
| Policy | Action、用户权限、自治等级、风险规则 | 长篇对话和领域文章 |
| Execution | 已批准 Action、Revision、幂等键 | 自由自然语言 Prompt |
| Verification | 成功标准、Observation、权威测量值 | 无关历史消息 |
| 完成摘要 | Goal、关键事件、验证结果、Artifact | 隐藏推理和全部调试日志 |

Execution 节点原则上不需要模型上下文，只需要确定性执行数据。

#### 9.5.5 Token 预算和压缩

~~~text
系统规则和安全约束：15%
Goal 与成功标准：15%
World Model：20%
当前 Plan 和最近 Observation：20%
领域知识：20%
输出预留与安全余量：10%
~~~

超出预算时依次去重、移除无关旧事件、压缩旧 Observation、大型 Artifact 只保留引用、缩减知识片段；仍超限则停止并报告上下文构建失败。

不能优先删除当前 Goal、成功标准、Revision、Action、Policy、安全限制或 Pending Approval。

聊天上下文建议保留最近 4 至 8 条原始交互，加一份经过 Schema 校验的摘要和有效事实引用。摘要必须区分用户事实、系统默认、工具观测和 Agent 推断，不能把“Agent 建议 1.6 mm”压缩成“用户确认 1.6 mm”。

#### 9.5.6 新鲜度和失效

~~~python
class ContextFreshness(BaseModel):
    goal_version: int
    document_revision: int
    plan_version: int | None
    tool_registry_version: str
    policy_version: str
    built_at: datetime
~~~

以下情况必须重建 Context Pack：

- 用户修改 Goal。
- CAD Document Revision 变化。
- Action 执行完成。
- Approval 被编辑或过期。
- Tool Registry 或 Policy Version 变化。
- Run 从暂停状态恢复。
- Context Pack 超过节点有效时间。

任何写操作执行前都重新读取当前 Document Revision，不能只信几分钟前构建的 Context Pack。

#### 9.5.7 隔离和防污染

第一阶段即使不做多租户，也必须：

- 查询绑定 project_id、document_id 和 run_id。
- 一个 Run 不能自动检索另一个 Project。
- Tool Result 标记来源文档。
- 缓存 Key 包含项目、文档、Revision 和权限范围。
- Context Pack 生成后检查所有 Source 的作用域。
- 外部知识文本只能作为数据，不能覆盖系统 Policy。

#### 9.5.8 Context 更新规则

~~~text
用户补充需求
  → 新 Goal Version
  → 旧 Plan 标记 superseded
  → 重建理论和规划上下文

建模 Action 成功
  → 新 Document Revision
  → 旧 World Model Summary 失效
  → 重新 Observe 并构建验证上下文

Verification 失败
  → 保存失败事实
  → 只把相关证据加入重新规划上下文

用户拒绝审批
  → 旧 Approval 终止
  → 重新规划时带入拒绝原因
  → 不复用旧批准
~~~

#### 9.5.9 审计和测试

关键 LLM 调用保存 Context Pack ID、Schema Version、Source 引用、裁剪记录、Token 估算、模型、Prompt 和 Tool Registry Version。默认不必永久保存完整 Prompt，但必须能说明“模型当时看到了哪些事实”。

至少测试：

1. 理论 Agent 看不到写 Tool。
2. Execution 节点不接收无关聊天。
3. Document Revision 变化后旧 Context 失效。
4. Goal Version 变化后旧 Plan 不再进入上下文。
5. 跨 Project 内容不能进入 Context Pack。
6. 超预算时优先裁剪非关键内容。
7. 用户事实、默认值和 LLM 推断不会在摘要中混淆。
8. 服务重启后能根据引用重建 Context Pack。
9. Tool Result 中的提示注入文本不能改变 Policy。
10. 所有关键 Context Source 都能追踪来源。
## 10. 第一阶段的 ReAct 子图

### 10.1 只实现一个受控 ReAct

第一阶段建议在理论分析或建模计划阶段实现一个小型 ReAct 子图，用来验证架构。不要同时开发多个自由 Agent。

~~~text
读取结构化目标
    ↓
判断需要什么理论信息
    ↓
调用白名单公式或材料查询工具
    ↓
读取 Observation
    ↓
判断是否已经足够
    ├── 否：继续调用工具
    └── 是：输出 TheoryAnalysisResult
~~~

### 10.2 工具白名单

第一阶段可提供：

- `get_material_properties`
- `calculate_patch_initial_dimensions`
- `convert_unit`
- `get_current_document_summary`
- `get_capability_schema`

理论 Agent 不允许调用任何写 CAD 工具。

### 10.3 循环边界

~~~python
class AgentBudget(BaseModel):
    max_iterations: int = 5
    max_tool_calls: int = 8
    max_elapsed_seconds: int = 60
    max_input_tokens: int
    max_output_tokens: int
~~~

必须设置停止条件：

- 得到满足 Schema 的最终结果。
- 缺少只能由用户提供的信息。
- 工具连续失败。
- 达到调用次数、Token、时间或费用限制。
- 结果置信度低于阈值。

达到限制后不能继续无限循环，应转换为：

~~~text
WAITING_USER
FAILED
或 NEEDS_REPLAN
~~~

### 10.4 ReAct 输出必须结构化

最终必须生成：

~~~python
class TheoryAnalysisResult(BaseModel):
    method: str
    assumptions: list[dict]
    derived_parameters: list[dict]
    evidence: list[dict]
    warnings: list[str]
    confidence: float
    requires_user_confirmation: bool
~~~

不要把模型的隐藏推理过程作为业务数据保存。保存工具调用、输入输出、决策摘要和可审计证据即可。

## 11. Capability 和 Tool 设计

### 11.1 Tool Schema

~~~python
class ToolDefinition(BaseModel):
    name: str
    version: str
    description: str
    input_schema: dict
    output_schema: dict
    side_effect: str
    risk_level: str
    required_capabilities: list[str]
    timeout_seconds: int
    retry_policy: dict
    verifier_name: str | None
~~~

### 11.2 第一阶段 Tool 分类

~~~text
PURE
  单位换算、理论公式、参数计算

READ
  查询文档、对象、属性、尺寸和 Revision

WRITE
  创建基础体或更新一个允许的参数
~~~

Policy 默认规则：

- PURE：自动允许。
- READ：自动允许，但记录审计。
- WRITE：默认需要审批。
- 未注册 Tool：拒绝。
- Schema 校验失败：拒绝。
- Revision 不匹配：拒绝并重新观察。

### 11.3 Capability Registry

Agent 不应该靠 Prompt 猜当前系统支持什么。

Registry 至少返回：

~~~json
{
  "name": "geometry.create_box",
  "version": "1.0",
  "available": true,
  "input_schema": {},
  "side_effect": "write",
  "supports_preview": false,
  "supports_rollback": true
}
~~~

第一阶段启动时从配置加载 Registry，并保存到 Config Snapshot。运行过程中不能悄悄改变 Tool 定义。

## 12. 写操作执行管线

写操作必须统一经过：

~~~text
Plan
  → Action Schema Validation
  → Capability Check
  → Policy Check
  → Approval Check
  → Revision Check
  → Idempotency Check
  → Execute
  → Observe
  → Verify
  → Commit / Rollback
~~~

### 12.1 幂等

LangGraph 恢复节点时，节点中的部分代码可能重新执行。因此 Worker 调用必须有幂等保护。

建议幂等键组成：

~~~text
run_id + action_id + tool_version + canonical_arguments_hash
~~~

如果相同键已经成功：

- 不再次调用 Worker。
- 返回之前保存的 Observation。

如果相同键参数不同：

- 视为协议错误。
- 不允许覆盖原记录。

### 12.2 Revision

每个写 Action 带：

~~~text
expected_document_revision
~~~

执行前查询真实 Revision：

- 一致：可以继续。
- 不一致：禁止执行。
- 重新观察 World Model。
- 判断是否可以重新规划。
- 原 Approval 失效。

### 12.3 事务和回滚

第一阶段至少支持一种安全方案：

方案 A，推荐：

~~~text
Worker 提供事务或临时文档
  → 执行动作
  → 验证
  → 提交
~~~

方案 B，若 Worker 暂时没有事务：

~~~text
执行前保存文档快照
  → 执行动作
  → 验证
  → 失败时恢复快照
~~~

如果两种都不具备，第一阶段只允许对专用测试文档执行写操作，不能声称已经达到生产安全。

## 13. 数据持久化

### 13.1 PostgreSQL 中的最小业务表

建议第一阶段建立：

| 表 | 用途 |
|---|---|
| `agent_runs` | Run 主状态 |
| `agent_goals` | 原始需求和结构化目标版本 |
| `agent_events` | 追加式审计事件 |
| `agent_actions` | 计划执行的动作及生命周期 |
| `agent_observations` | 工具真实返回 |
| `agent_verifications` | 验证结果 |
| `agent_approvals` | 审批请求和决定 |
| `agent_artifacts` | 理论报告、计划和模型结果引用 |
| `config_snapshots` | 当前 Run 使用的配置和 Tool 版本 |

LangGraph Checkpointer 使用独立表，不把它当成业务查询接口。

### 13.2 Event 类型

第一阶段至少记录：

~~~text
run.created
run.started
stage.entered
goal.parsed
user_input.requested
user_input.received
plan.created
action.proposed
approval.requested
approval.decided
action.started
action.succeeded
action.failed
observation.recorded
verification.passed
verification.failed
run.completed
run.failed
run.cancelled
~~~

Event 必须包含：

~~~text
event_id
run_id
sequence_number
event_type
occurred_at
actor
correlation_id
causation_id
schema_version
payload
~~~

### 13.3 事实来源

- CAD 文档和 Revision 的事实来源：OCCT Worker。
- Run 生命周期的事实来源：Agent 业务数据库。
- LangGraph 当前执行位置：Checkpointer。
- 大型工程产物：Artifact Store。

不要把同一事实分别维护成多个互不校验的副本。

## 14. API 设计

### 14.1 创建 Run

~~~text
POST /api/v1/agent/runs
~~~

请求：

~~~json
{
  "project_id": "project-1",
  "document_id": "document-1",
  "message": "创建一个工作在 2.45 GHz 的矩形微带贴片天线",
  "autonomy_level": "supervised"
}
~~~

返回：

~~~json
{
  "run_id": "run-...",
  "status": "created",
  "events_url": "/api/v1/agent/runs/run-.../events"
}
~~~

### 14.2 查询 Run

~~~text
GET /api/v1/agent/runs/{run_id}
~~~

返回当前：

- 状态。
- 阶段。
- 进度摘要。
- 等待原因。
- Pending Input。
- Pending Approval。
- 最近错误。
- 产物引用。

### 14.3 提交用户补充

~~~text
POST /api/v1/agent/runs/{run_id}/responses
~~~

必须带：

~~~text
request_id
response
expected_run_version
~~~

防止迟到回答恢复已经发生变化的 Run。

### 14.4 审批

~~~text
POST /api/v1/agent/runs/{run_id}/approvals/{approval_id}/decision
~~~

决定类型：

~~~text
approve
reject
edit
~~~

批准时需要校验：

- 当前用户是否有权批准。
- Approval 是否仍有效。
- Action Hash 是否一致。
- Document Revision 是否仍一致。

### 14.5 取消

~~~text
POST /api/v1/agent/runs/{run_id}/cancel
~~~

取消不是删除：

- Run 进入 CANCELLED。
- 保留事件和审计。
- 尚未执行的动作停止。
- 已经提交的外部任务进入取消或遗弃处理。

### 14.6 实时事件

~~~text
GET /api/v1/agent/runs/{run_id}/events
Content-Type: text/event-stream
~~~

前端不需要轮询整个 Run。SSE 推送：

- 阶段变化。
- 正在调用的工具。
- 追问。
- 审批。
- 验证结果。
- 错误。
- 完成摘要。

断线重连使用 `Last-Event-ID` 从数据库事件序号继续。

## 15. 与现有 OCCT 工程的连接

### 15.1 第一阶段推荐 HTTP/JSON Adapter

保留当前 C++ Worker 和现有 Gateway，不把 OCCT 链接进 Python 进程。

原因：

- C++ 崩溃不会直接带崩 Agent 服务。
- 沿用现有协议和测试。
- Python Agent 与几何内核解耦。
- 以后可替换为 gRPC，而不影响领域层。

定义端口：

~~~python
class GeometryPort(Protocol):
    async def get_document_summary(
        self, document_id: str
    ) -> "DocumentSummary": ...

    async def execute(
        self, action: ActionRequest
    ) -> Observation: ...

    async def verify_shape(
        self, document_id: str, entity_id: str
    ) -> "GeometryCheck": ...
~~~

实现：

~~~text
HttpGeometryAdapter
~~~

### 15.2 HTTPX 配置

必须显式设置：

- 连接超时。
- 读取超时。
- 总连接数。
- 每主机连接数。
- 重试范围。
- Correlation ID。
- 响应大小限制。

只自动重试：

- 明确幂等的读取。
- 已经带可靠幂等键的写操作。

不能因为网络超时就盲目重复建模命令。

### 15.3 Worker 契约测试

使用固定测试样例校验：

- 请求字段。
- 单位。
- 错误码。
- Revision 语义。
- 重复 idempotency key。
- 超时后真实动作状态。
- Worker 返回未知字段时的兼容性。
- Worker 少字段时的失败方式。

## 16. 错误分类和恢复

第一阶段定义统一错误：

| 类型 | 示例 | 处理 |
|---|---|---|
| `USER_FIXABLE` | 缺参数、单位不明确 | 暂停追问 |
| `LLM_RECOVERABLE` | 结构化输出不合 Schema | 带错误信息有限重试 |
| `TOOL_TRANSIENT` | 临时网络错误 | 指数退避重试 |
| `REVISION_CONFLICT` | 文档已被修改 | 重新观察和规划 |
| `POLICY_DENIED` | 无权限或动作不允许 | 停止或请求更高授权 |
| `VERIFICATION_FAILED` | 实际几何不符合目标 | 回滚并重新规划 |
| `NON_RECOVERABLE` | 数据损坏、协议不兼容 | Run 失败并人工处理 |

第一阶段恢复预算建议：

~~~text
LLM Schema 修复：最多 2 次
只读工具瞬时错误：最多 3 次
写工具不明确超时：先查询动作状态，不直接重试
重新规划：最多 2 次
整体节点循环：最多 20 个主要步骤
~~~

## 17. 可观测性

### 17.1 Trace 层级

~~~text
Agent Run Span
  ├── Graph Node Span
  │     ├── LLM Call Span
  │     ├── Tool Call Span
  │     └── Verification Span
  └── Geometry Worker Span
~~~

每个 Span 带：

- run_id。
- project_id。
- graph_version。
- node_name。
- action_id。
- tool_name/version。
- model_name。
- document_revision。
- outcome。

### 17.2 第一阶段指标

- Run 完成率。
- Run 平均耗时。
- 每个阶段耗时。
- 等待用户时间。
- LLM 调用次数和 Token。
- Tool 成功率。
- Revision 冲突次数。
- Verification 失败次数。
- 恢复次数。
- 重复 Action 被幂等层拦截次数。

不要在日志和 Trace 中直接记录：

- API Key。
- 完整模型文件。
- 未脱敏的用户机密数据。
- 模型隐藏推理。

## 18. 测试方案

### 18.1 单元测试

覆盖：

- Pydantic Schema。
- 单位转换。
- 状态迁移。
- Policy 规则。
- Action Hash。
- Revision 判断。
- 错误分类。
- 路由函数。
- Verification 规则。

### 18.2 Hypothesis 属性测试

重点测试：

- 任意非法单位不会进入执行器。
- 任意参数顺序生成相同 canonical hash。
- 同一个幂等键不能产生两个成功动作。
- 终态 Run 不能重新进入 RUNNING。
- 过期 Approval 永远不能放行。
- Revision 不一致永远不能写入。
- 任意恢复路径都不会绕过 Policy。

### 18.3 Graph 路径测试

至少覆盖：

1. 完整需求直接进入理论分析。
2. 缺失需求暂停，回答后恢复。
3. 用户回答不合法，再次追问。
4. 计划 Schema 错误，有限修复后成功。
5. 审批通过后执行。
6. 审批拒绝后重新规划。
7. Approval 过期。
8. Revision 冲突。
9. Worker 短暂失败后恢复。
10. Worker 超时但动作实际成功。
11. Verification 失败后回滚。
12. Run 取消。
13. 服务重启后恢复。
14. 达到 ReAct 预算后停止。

### 18.4 契约测试

- Agent 到 Gateway。
- Gateway 到 OCCT Worker。
- 前端到 Agent API。
- LangGraph Checkpoint 序列化。
- 数据库 Migration 升级和回退策略。

### 18.5 端到端测试

最终至少有三个：

~~~text
E2E-1：缺信息 → 追问 → 审批 → 建模 → 验证成功
E2E-2：服务在审批阶段重启 → 恢复 → 建模成功
E2E-3：Revision 冲突 → 阻止旧动作 → 重新观察 → 新审批
~~~

测试模型调用尽量使用可重复的 Fake Model。真实 LLM 测试放入 evals，不作为普通单元测试的随机依赖。

## 19. 四周开发计划

### 第 1 周：工程骨架和领域契约

目标：没有接 LLM，也能创建 Run 并按确定性状态机流转。

任务：

- 建立 `modeling-agent` Python 工程。
- 配置 Python 3.13、代码格式、静态检查和测试。
- 建立 FastAPI 健康检查。
- 定义 Run、Goal、Action、Observation、Verification、Approval。
- 定义错误码和状态迁移。
- 建立 SQLAlchemy 模型和第一版 Alembic Migration。
- 建立 Event Store。
- 定义 `WorkflowEngine`、`GeometryPort`、`ModelPort`。
- 使用 Fake Workflow 跑通创建、查询和取消 Run。
- 建立 CI。

周验收：

- API 可以创建 Run。
- Run 和 Event 能写入 PostgreSQL。
- 非法状态迁移被拒绝。
- Migration 可在空数据库执行。
- 单元测试和类型检查通过。

### 第 2 周：LangGraph、追问和有界 ReAct

目标：跑通可暂停、可恢复的只读智能流程。

任务：

- 实现 LangGraph 主图骨架。
- 实现输入 Router、工作流 Router 和恢复 Router。
- 实现 Context Engine、节点级 Context Builder 和 Token Budget。
- 实现 Context Source、Provenance、Freshness 和失效重建。
- 接入持久化 Checkpointer。
- 实现需求结构化输出。
- 实现确定性需求校验。
- 实现结构化 Elicitation Request。
- 实现 `interrupt/resume`。
- 实现理论分析 ReAct 子图。
- 建立 Tool Registry 和只读工具。
- 实现预算和停止条件。
- 实现 SSE 事件流。
- 使用 Fake Model 覆盖所有主要路径。

周验收：

- 缺失信息时进入 WAITING_USER。
- 服务重启后可以继续。
- ReAct 超预算能够停止。
- Agent 不能调用白名单外工具。
- 模糊输入不会被自动路由到写流程。
- Goal 或 Document Revision 变化后旧 Context 自动失效。
- 不同 Project 的上下文不会串入当前 Run。
- 前端或测试客户端能收到实时事件。

### 第 3 周：审批和真实建模动作

目标：通过安全执行管线调用一个真实 OCCT 写能力。

任务：

- 实现 Action Envelope。
- 实现 Policy。
- 实现 Approval Request 和决定接口。
- 实现 Action Hash 和审批绑定。
- 实现 Idempotency Store。
- 实现 Revision Check。
- 实现 HTTP Geometry Adapter。
- 接入一个真实基础体建模动作。
- 实现 Observer。
- 实现尺寸、对象存在性和 Revision Verifier。
- 实现事务或快照回滚方案。

周验收：

- 未批准不能调用写工具。
- 参数变化后旧批准失效。
- 同一个动作重复恢复不会创建两个对象。
- Revision 冲突不会覆盖用户修改。
- 验证失败能够回滚或明确标记人工处理。

### 第 4 周：恢复、观测、端到端和交付

目标：把“能跑”提升到“可验证地稳定运行”。

任务：

- 完成错误分类和恢复路由。
- 接入 OpenTelemetry。
- 完成 Run/Event/Tool 指标。
- 完成三个端到端场景。
- 做服务重启、网络超时和 Worker 失败注入。
- 检查日志脱敏。
- 固化 Graph Version 和 Config Snapshot。
- 完成运维说明、开发说明和 API 文档。
- 录制或整理最终演示步骤。

周验收：

- 三个 E2E 全部稳定通过。
- 服务重启恢复通过。
- 故障不会绕过审批和 Policy。
- 每次真实写入能从 Run 追踪到 Action、Approval、Observation 和 Revision。
- 团队成员按 README 可以在新环境启动系统。

## 20. 工作分解和人员建议

三人小组的推荐分工：

### Python/Agent 开发

- 领域模型。
- LangGraph。
- LLM Adapter。
- API。
- 持久化。
- ReAct 子图。

### CAD/Worker 开发

- Geometry Adapter 契约。
- Revision。
- 幂等支持。
- 事务或快照。
- Observation。
- Geometry Verifier。

### 前端/测试开发

- Run 状态 UI。
- SSE。
- 追问卡片。
- 审批卡片。
- 测试夹具。
- E2E 和故障场景。

还需要一名天线或电磁领域专家兼职参与：

- 确认第一版需求 Schema。
- 审核理论公式工具。
- 定义默认值和必须追问字段。
- 审核最终演示是否具有工程意义。

如果只有一名开发者，建议严格按以下顺序：

~~~text
领域契约
  → 数据库
  → LangGraph 只读流程
  → 追问恢复
  → 单个写动作
  → 审批与验证
  → 可观测性
  → 前端体验
~~~

## 21. 关键技术选项

### 21.1 LangGraph Graph API 还是 Functional API

第一阶段推荐 Graph API。

原因：

- 主流程有明显阶段。
- 需要条件边和循环。
- 需要可视化和路径测试。
- 以后要拆成多个子图。

Functional API 可以用于少量内部函数，但不要同时用两套风格描述同一层流程。

### 21.2 LangChain `create_agent` 还是原始 LangGraph

推荐：

- 顶层流程使用原始 LangGraph `StateGraph`。
- 单个理论 ReAct 子图可以使用 LangChain `create_agent`，或者自行实现轻量 Tool Loop。
- 领域模型不能依赖 LangChain Message 类型。

### 21.3 PostgreSQL 还是 SQLite

推荐：

- 本地快速单元测试：SQLite 或纯内存 Fake Repository。
- 第一阶段集成、E2E 和部署：PostgreSQL。

因为恢复、并发、锁和持久化是第一阶段验收内容，不能只在 SQLite 上验证后就宣称可生产使用。

### 21.4 HTTP 还是 gRPC 连接 Worker

第一阶段继续使用 HTTP/JSON。

只有出现以下需求时再评估 gRPC：

- 大规模流式数据。
- 更严格的跨语言类型契约。
- HTTP/JSON 序列化成为明确性能瓶颈。
- Worker 已经具备稳定 gRPC 基础设施。

### 21.5 是否使用 Temporal

第一阶段不使用。

LangGraph 已经负责智能体流程持久化。真实仿真求解尚未进入第一阶段，此时同时引入 Temporal 会增加部署和认知负担。

未来当求解任务具备以下特征时再评估：

- 持续数小时或数天。
- 大量并发任务。
- 跨服务事务和补偿。
- 复杂定时、重试和运维要求。

届时可以：

~~~text
Temporal 管长期业务任务
LangGraph 管需要 LLM 推理的认知子流程
~~~

## 22. 第一阶段验收门槛

只有同时满足下面条件，才能进入第二阶段。

### 功能门槛

- 能创建、查询、暂停、恢复和取消 Run。
- 能进行至少一次结构化追问。
- 能区分直接回答、只读查询、启动任务、继续任务、修改目标、审批和取消。
- 每个 LLM 节点只获得经过裁剪、可追溯且版本新鲜的 Context Pack。
- 能运行一个有边界的 ReAct 子图。
- 能生成结构化 Plan 和 Action。
- 能完成一次审批。
- 能调用一个真实 OCCT 写工具。
- 能通过真实 Observation 验证结果。
- 能保存完整审计链。

### 可靠性门槛

- 服务重启后 Run 可恢复。
- 同一 Action 重放不产生重复副作用。
- Revision 冲突不会覆盖现有模型。
- Approval 不能批准已变化的 Action。
- ReAct 不会无限循环。
- Worker 超时不会直接盲目重试写入。
- 失败路径有明确终态或人工等待态。

### 测试门槛

- 核心领域层单元测试覆盖关键状态转换。
- Graph 主要分支全部有路径测试。
- 输入路由、恢复路由和安全回退均有测试。
- Context 裁剪、失效、来源追踪和跨项目隔离均有测试。
- 三个端到端测试通过。
- 至少完成一次服务重启故障注入。
- 至少完成一次 Worker 超时故障注入。
- Schema 和 Adapter 契约测试通过。

### 可观测性门槛

- 能通过 run_id 找到完整 Trace。
- 能看到每个 Node、LLM 和 Tool 的耗时。
- 能查看 Action、Approval、Observation、Verification 链条。
- 日志不存在 API Key 和明显敏感内容。

### 文档门槛

- 本地启动说明。
- 数据库迁移说明。
- API 示例。
- Graph 节点说明。
- Tool 注册说明。
- 故障排查说明。
- 第二阶段扩展点说明。

## 23. 第一阶段结束时应该留下哪些扩展点

第二阶段接入真实天线建模时，新增：

~~~text
Theory Analysis Subgraph
Parameterized Modeling Subgraph
Model Validation Subgraph
~~~

接入仿真时，新增：

~~~text
Simulation Configuration Subgraph
Solver Job Adapter
Result Query Subgraph
Result Verification
Parameter Impact Analyzer
~~~

这些扩展只新增 Graph Node、Subgraph、Tool 和领域 Artifact，不应该修改：

- Run 的基本生命周期。
- Approval 安全模型。
- Action Envelope。
- Revision 和幂等规则。
- Event Envelope。
- Execution Engine 边界。
- Observation/Verification 分离原则。

如果第二阶段必须推翻这些基础对象，说明第一阶段设计没有真正完成。

## 24. 第一阶段最容易出现的错误

### 错误一：先做一个万能 Agent

把所有 Tool 全部交给一个 `create_agent`，短期演示快，后续无法稳定控制。

正确做法：

~~~text
确定性主图 + 局部有限 ReAct + Tool 白名单
~~~

### 错误二：把聊天记录当状态

聊天消息只是一种输入，不是 Run、Goal、Revision 和 Approval 的事实来源。

### 错误三：Checkpointer 代替业务数据库

Checkpoint 用于恢复 Graph；业务表用于审计和产品查询。两者都需要。

### 错误四：Tool 返回成功就认为任务成功

Tool 调用成功只说明请求执行完成。必须重新查询真实状态并进行 Verification。

### 错误五：写操作网络超时后直接重试

超时意味着结果未知，不等于执行失败。应先通过幂等键或动作查询确认真实状态。

### 错误六：第一阶段塞入完整仿真

这会把求解器、队列、结果库等复杂度混入 Agent 基础设施，导致无法判断问题究竟来自架构还是领域能力。

## 25. 建议的 Definition of Done

每个第一阶段任务只有满足以下条件才算完成：

- 领域输入输出有 Pydantic Schema。
- Schema 带版本或有明确兼容策略。
- 关键分支有自动化测试。
- 副作用有幂等和 Revision 保护。
- 错误映射为统一错误类型。
- 事件中可以追踪 correlation 和 causation。
- Trace 能关联到 Run 和 Action。
- 日志完成脱敏。
- 文档说明行为和限制。
- Fake Adapter 和真实 Adapter 使用同一契约测试。

## 26. 推荐开工顺序

如果明天开始开发，按下面顺序建任务：

1. 创建 Python 工程和 CI。
2. 定义 Run/Goal/Action/Observation/Verification/Approval。
3. 定义状态迁移和错误码。
4. 建 PostgreSQL 表和 Migration。
5. 实现 Run API 和 Event Store。
6. 建 `WorkflowEngine` 接口。
7. 建 LangGraph 主图空骨架。
8. 实现需求解析和确定性校验。
9. 实现追问的暂停恢复。
10. 实现 Tool Registry。
11. 实现一个有界理论 ReAct 子图。
12. 实现 SSE。
13. 实现 Policy 和 Approval。
14. 实现 Geometry Port 和 HTTP Adapter。
15. 接入一个真实写 Action。
16. 实现幂等、Revision 和回滚。
17. 实现 Observer 和 Verifier。
18. 完成故障恢复。
19. 接入 OpenTelemetry。
20. 完成 E2E、故障注入和交付文档。

## 参考资料

- LangGraph Overview：<https://docs.langchain.com/oss/python/langgraph/overview>
- LangGraph Graph API：<https://docs.langchain.com/oss/python/langgraph/graph-api>
- LangGraph Persistence：<https://docs.langchain.com/oss/python/langgraph/persistence>
- LangGraph Interrupts：<https://docs.langchain.com/oss/python/langgraph/interrupts>
- LangGraph Workflows and Agents：<https://docs.langchain.com/oss/python/langgraph/workflows-agents>
- LangChain Agents：<https://docs.langchain.com/oss/python/langchain/agents>
- FastAPI：<https://fastapi.tiangolo.com/>
- Pydantic：<https://docs.pydantic.dev/latest/>
- SQLAlchemy 2：<https://docs.sqlalchemy.org/en/20/>
- Alembic：<https://alembic.sqlalchemy.org/>
- OpenTelemetry Python：<https://opentelemetry.io/docs/languages/python/>
- Hypothesis：<https://hypothesis.readthedocs.io/>
