# Web CAD Agent

独立的 Python CLI/TUI Agent Runtime，通过 HTTP/JSON 使用同级 `web-cad-demo` 的 Gateway，不依赖浏览器页面，也不直接链接 OCCT 或 Geometry Worker。

## 当前实现状态

当前首批实现覆盖：

- Pydantic 领域模型：Session、Run、Action、Observation、Verification、Approval、ContextPack。
- JSON 文件持久化：Session、Run、Event 和幂等动作。
- HTTP Gateway Adapter：health、document.summary、geometry.measure、geometry.check、commands。
- Tool/Skill Registry 和 Python Entry Point 扩展发现。
- 安全的 Box 写入流程：Plan → Approval → Revision/Idempotency → Execute → Verify。
- 确定性 Intent Router、Planner、DAG 校验和 `create_hollow_tube` 原子批次流程。
- 缺参/对象歧义会持久化为 `ElicitationRequest`，可通过 `answer-input` 恢复等待中的 Run。
- 有界 ReAct Decide/Act/Observe/Verify 循环、实体解析和 Revision 新鲜度判断。
- 可替换的 `LLMModel` 协议与结构化 Planner；模型只能返回待校验数据，不能直接发送 Gateway 请求。
- `HttpJsonModel` 可对接任意配置的结构化模型 HTTP Endpoint，不绑定模型厂商。
- 可通过 `--model-endpoint` 或 `WEBCAD_AGENT_MODEL_ENDPOINT` 启用模型规划；模型只返回结构化 Plan，仍必须经过 Registry、Policy、Revision、Approval 和 Verification。
- SQLAlchemy + SQLite 默认持久化（`.json` 路径仍可使用可审计 JSON Store），支持暂停、恢复、取消、Undo/Redo；旧版 SQLiteStore 作为兼容调试实现保留。
- 长会话超过阈值会自动生成 `CompactionCheckpoint`；原始消息保留，可通过 `/compact` 手动压缩。
- `extensions list/info/validate` 提供扩展发现和声明式 Manifest/Skill 校验；Agent 不自动安装 Python 包。
- 标准库 CLI 兼容入口；安装 Typer/Textual 后可切换完整 CLI/TUI。
- `spatial` 查询可读取 Gateway 的 Revision 绑定 AABB、中心、尺寸和近似 Body 关系；`relation BODY_A BODY_B` 通过 OCCT Worker 读取 BRep 精确距离/相交关系（回退适配器会显式标记为 `aabb-derived`）；`variables`、`coordinates`、`materials`、`history`、`properties` 与 `property-types` 也可通过同一模型查询边界读取。
- 核心 Tool 白名单覆盖 Primitive、Transform、Boolean、Fillet/Chamfer、Pattern、变量、坐标系、材料、Body 材料分配、Property 及自定义 Property Type/Instance；写 Tool 均先经过 Schema、Policy、Approval/幂等和验证。
- `run` 自然语言入口可确定性解析 Box、Cylinder、Cone、Sphere、Torus、空心管、平移、Fillet/Chamfer、Linear/Circular/Rectangular/Mirror Pattern 和 Material；缺参会创建持久化 ElicitationRequest。
- `config show` 输出脱敏的有效配置，`backup --destination <dir>` 生成带 SHA-256 校验的状态备份。

## 启动

可安装为独立命令行程序：

```powershell
python -m pip install -e ".[dev]"
webcad-agent --help
```

发布 wheel 后可使用 pipx 隔离安装（不读取 `web-cad-demo` 的源码或数据目录）：

```powershell
python -m build --wheel
pipx install .\dist\webcad_agent-0.1.0-py3-none-any.whl
webcad-agent --help
```

首次部署或升级数据库结构时：

```powershell
python -m alembic upgrade head
```

在 `web-cad-demo` Gateway 已运行的情况下：

```powershell
cd D:\Project\OCCT8.0\web-cad-agent
$py = "C:\Users\15863\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$env:PYTHONPATH = "src"
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 health
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 summary --document demo
```

查询空间摘要（不依赖浏览器选中状态）：

```powershell
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 spatial --session <session-id> --kind geometry-tree
# --kind 也支持 body、variables、coordinates、materials、history、properties、property-types
```

创建 Box 默认需要显式批准：

```powershell
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 create-box `
  --document demo --width 100 --depth 80 --height 50
```

只读模式会在策略层拒绝所有写入意图：

```powershell
& $py -m webcad_agent.cli --mode readonly run "创建一个 10×10×10 mm 的盒子" --document demo
```

命令会先展示计划并返回等待批准；带 `--approve` 才会提交写入：

```powershell
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 create-box `
  --document demo --width 100 --depth 80 --height 50 --approve
```

多步空心管流程使用 Gateway 的原子批处理契约：

```powershell
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 create-tube `
  --document demo --outer-radius 40 --inner-radius 30 --height 100 --approve
```

自然语言单次入口对 Box、Cylinder、Cone、Sphere、Torus、空心管、布尔和平移做确定性解析，缺失参数会返回结构化追问：

```powershell
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 run `
  "创建一个 100×80×50 mm 的长方体" --document demo --approve --output json
```

对稳定 Body ID 执行平移也会先测量、预览、审批，再验证中心点位移：

```powershell
& $py -m webcad_agent.cli --gateway http://127.0.0.1:8788 translate body-1 `
  --session <session-id> --dx 10 --dy 0 --dz 5
```

查看当前安装的 Tool 扩展快照：

```powershell
& $py -m webcad_agent.cli extensions list
& $py -m webcad_agent.cli extensions info core
& $py -m webcad_agent.cli extensions validate .\extension.json --trusted
& $py -m webcad_agent.cli extensions enable .\extension.json --trusted
& $py -m webcad_agent.cli extensions disable acme.geometry
& $py -m webcad_agent.cli extensions doctor
```

查看当前进程的结构化运行指标：

```powershell
& $py -m webcad_agent.cli metrics
& $py -m webcad_agent.cli eval --repetitions 20
# 配置模型端点后执行真实模型 Smoke Eval（不会把模型原文写入报告）
& $py -m webcad_agent.cli --model-endpoint http://127.0.0.1:9000/model eval --repetitions 3
```

OpenTelemetry 默认关闭；发布环境可显式选择控制台或 OTLP/HTTP exporter：

```powershell
& $py -m webcad_agent.cli --otel-exporter console health
$env:WEBCAD_AGENT_OTEL_EXPORTER = "otlp_http"
$env:WEBCAD_AGENT_OTEL_ENDPOINT = "http://127.0.0.1:4318/v1/traces"
& $py -m webcad_agent.cli health
```

配置与备份：
```powershell
& $py -m webcad_agent.cli config show
& $py -m webcad_agent.cli --state .data/agent.db backup --destination .data/backups
```

## 目录

```text
src/webcad_agent/
├─ domain/          # 领域契约和状态机
├─ application/     # Session/Run/写入服务
├─ adapters/        # HTTP Gateway 和本地存储适配器
├─ context/         # ContextPack、预算、压缩、新鲜度
├─ planning/        # Planner、DAG 校验、批次执行
├─ routing/         # CONTROL/READ/EXECUTE 路由
├─ resolution/      # Body/Feature 引用解析
├─ react/           # 有界 ReAct 子图
├─ tools/           # ToolSpec 和 Registry
├─ skills/          # SkillSpec 和计划构建
├─ extensions/      # Entry Point 扩展发现
├─ verification/    # 几何和文档验证
└─ ui/              # CLI/TUI 适配层
```

## 约束

- 活动 Run 固定 `document_id`、Revision、Registry Version 和 Action Hash。
- 写动作没有 Approval 不能执行。
- HTTP 写超时不自动盲目重试。
- `web-cad-demo/gateway/server.mjs` 已增加 `/api/command-batches`：单文档、Revision Guard、步骤引用、整批幂等和失败回滚。
