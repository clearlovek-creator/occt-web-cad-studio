# Web CAD Agent 实施状态

更新时间：2026-08-16

## 已完成的可验证闭环

| 方案阶段 | 当前实现 | 证据 |
|---|---|---|
| Phase 0 | 独立 Python 包、领域模型、Tool/Skill Registry、JSON/SQLAlchemy/SQLite Store、Alembic Migration、Fake Adapter、Config Snapshot | `src/webcad_agent/domain`、`adapters`、`tools`、`migrations`；66 项 pytest（Textual 未安装时另有 1 项可选测试跳过），含七场景 Eval Runner 与发布门槛测试 |
| Phase 1 | Session/Run/Event、ContextPack、预算估算、自动/手动压缩、CompactionCheckpoint、Elicitation、Spatial Model Query、新鲜度、CONTROL/READ/EXECUTE Router | `application/service.py`、`context`、`routing`、`domain/models.py`、`adapters/gateway.py` |
| Phase 2 | Box/Translate Preview、Approval、Revision Guard、幂等、几何 Verify、DocumentDiff、Undo/Redo | `propose_box` / `propose_translate`、`verification`、Gateway `/api/commands` |
| Phase 3 | DAG Planner、空心管确定性 Skill、批次步骤引用、公共原子批处理和失败回滚 | `planning`、`contracts/command-batches.v1.schema.json`、Gateway `/api/command-batches` |
| Phase 4 | 31 个受控核心 Tool；除 Primitive/Transform/Boolean/Detail 外，已加入 Linear/Circular/Rectangular/Mirror Pattern、变量、坐标系、材料、Body 材料分配、Property 与自定义 Property Type/Instance，以及 `geometry.relation`；自然语言入口覆盖 Fillet/Chamfer/Pattern/Material；每个写 Tool 声明输入/输出 Schema、风险、预览、幂等和验证契约 | `extensions/builtin.py`、`tools/spec.py`、`planning/executor.py`、`verification/geometry.py`、`nl/parser.py`、`contracts/geometry-relation.v1.schema.json` |
| Phase 5 | 有界 Decide/Act/Observe/Verify、可选 LangGraph StateGraph、MemorySaver 与基于 JSON/msgpack 的本地 Durable Checkpoint、Run 暂停/恢复/取消、审批恢复和 Revision 失效 | `react`、`application/service.py` |
| Phase 6 | 标准库 CLI、可选 Textual 三栏 UI（窄屏折叠、审批 Modal、Slash Command Palette、Session/Run/Inspector 命令）、80×24/120×36 Headless Snapshot、事件总线、深链接、JSON 事件日志、脱敏和 `none`/`console`/`otlp_http` OpenTelemetry exporter | `cli.py`、`ui`、`application/events.py`、`observability` |
| Phase 7 | Fault Adapter、七场景 Eval Runner、`eval --repetitions` CLI（20 次连续 Eval 已通过）、opt-in provider-neutral Model Eval、Route/Schema/Approval 发布门槛、Artifact 限制、独立工程 CI、离线 Wheel 构建（约 100 KB）、Node Gateway/UI 串行全量 203 项测试通过和发布状态文档 | `testing`、`evals`、`tests/test_release_gates.py`、`observability/artifacts.py`、`.github/workflows/modeling-agent.yml` |

## 当前明确边界

- 默认模式是 `supervised`；写操作没有审批不会发送到 Gateway。
- Gateway 批次只允许单文档；批次失败会恢复 XBF 检查点；部分幂等重放被拒绝。
- CLI/TUI `run` 对 Box、Cylinder、Cone、Sphere、Torus、空心管、布尔、平移、Fillet/Chamfer、Pattern 和 Material 做确定性解析；复杂任务可通过 `StructuredPlanner` + provider-neutral `HttpJsonModel` 接入外部模型，模型只能返回待校验数据，不能直接发送 Gateway 请求。
- Textual 为可选依赖；未安装时默认 TUI 回退到标准库 REPL；核心布局有纯 Python Headless Snapshot 测试。
- SQLite 是默认状态库，`.json` 后缀仍可选择 JSON Store 进行调试和迁移。
- 当前 Gateway Spatial Query 已提供 Revision 绑定的 AABB/中心/尺寸、OCCT Worker 精确 OBB（`source=occt-exact`、`exact=true`，旧 Worker 自动降级为 `aabb-derived`）和明确标注为近似的紧凑 AABB 关系提示。独立的 `geometry.relation` 读操作已由 OCCT Worker 使用 BRep 距离/Boolean Common 计算，并返回 `source=occt-brep`、`exact=true`、距离、相交体积和关系分类；Fake/旧 Worker 路径保持 `aabb-derived`、`exact=false`。已提供 opt-in provider-neutral 真实模型 Smoke Eval。OpenTelemetry 已支持 `none`、`console`、`otlp_http` 配置并对属性脱敏。

## 验证命令

```powershell
$py = "C:\Users\15863\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
cd D:\Project\OCCT8.0\web-cad-agent
& $py -m compileall -q src
& $py -m pytest -q
```

真实 Gateway 验证包括：健康检查、Box Preview/执行、Translate 中心点验证、三步 Cylinder/Cylinder/Cut 批次成功，以及第二步故意失败后的 Revision/Body 回滚。
另验证 `/api/agent/model/query` 可在不启动浏览器前端时返回 Revision 绑定的 Spatial Summary。
