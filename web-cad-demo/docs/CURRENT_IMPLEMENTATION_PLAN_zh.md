# Web CAD 当前方案实施计划

> 基线日期：2026-07-15\
> 几何内核：Open CASCADE Technology 8.0\
> 当前原则：不实现二维参数化草图；浏览器负责交互和显示，原生 OCCT Worker 负责权威 BRep。

## 1. 已对齐的产品规则

1. 工作台采用顶部菜单和 Ribbon、左侧工程/几何树、中央 3D 视口、底部消息区，不再保留右侧固定 Inspector。
2. 建模命令使用可拖动、可最小化的非模态操作窗口；窗口打开时仍可旋转视口和拾取 Body、Face、Edge。
3. 同一时间只允许一个活动建模命令。普通确认、删除和未定义变量提示使用阻塞式模态窗口。
4. Project 管理 Design、Variables、Materials、Coordinate Systems 和 Geometry。
5. Geometry Tree 按 Body 展示几何结果和建模历史；后端仍以 FeatureGraph/DAG 作为权威依赖模型。
6. Body 是一个可独立选择、显示、变换、赋材和参与 Boolean 的顶层几何对象，通常对应一个连续 Solid。
7. 变量只实现数值标量：Length、Angle、Dimensionless、Integer；不实现 String、Boolean、Vector3、Point3 变量。
8. Feature 参数可以是固定值、标量变量或表达式。字符串、布尔值、Body/Face/Edge、材料和坐标系引用仍是参数，但不是变量。
9. 表达式引用未定义变量时暂停几何命令，集中弹窗提示用户创建变量、替换已有变量或返回修改。
10. 所有可见命令必须可执行；尚未实现的能力不放可点击空按钮。

## 2. 目标架构

```text
Menu / Ribbon / Context Menu / Shortcut
                │
                ▼
         Command Registry
                │
                ▼
      Command Session + Selection
                │
        ┌───────┴────────┐
        ▼                ▼
Operation Window    View Command
        │                │
        ▼                ▼
Typed Geometry API   Three.js Viewer
        │
        ▼
Gateway Transaction / Undo / Redo
        │
        ▼
OCCT CadDocument + FeatureGraph + XCAF
```

前端目标模块：

```text
app/
├─ commands/       命令定义、可用性和分发
├─ workbench/      菜单、Ribbon、工程树、操作窗口
├─ modeling/       基础体、变换、Boolean、细节特征表单
├─ state/          文档、选择、活动命令和窗口状态
├─ viewer/         显示、拾取、预览和视图控制
└─ api/            类型化命令协议
```

## 3. 分阶段实施

### 阶段 A：可用工作台和命令系统

目标：修复空菜单和空按钮，完成非模态窗口架构。

- 建立 Command Registry，菜单、Ribbon 和快捷键共用命令 ID。
- 删除右侧 Inspector，让视口占据剩余空间。
- 实现可拖动、可最小化、Esc 关闭的 Operation Window。
- 接入现有 Box、Cylinder、Cone、Sphere、Torus、Translate、Rotate、Mirror、Scale。
- 接入 Fuse、Cut、Common、Fillet、STEP、用户属性、参数更新、Undo/Redo。
- 接入 Fit、Top、Front、Right、Iso 和 Grid 显隐视图命令。
- 工程树和几何树分栏显示。

验收：所有可见命令有真实行为；不满足选择条件时禁用并给出原因；现有自动化测试全部通过。

### 阶段 B：标量变量、参数表达式和坐标系

状态：**已完成（2026-07-15）**。变量采用当前单 Design 文档作用域。

- 实现 ScalarVariableStore：Length、Angle、Dimensionless、Integer。
- 实现作用域、名称校验、表达式依赖、循环检测、单位和量纲检查。
- 实现 `+ - * /`、括号、`min/max/abs/sqrt` 和基础三角函数。
- 实现未定义变量集中创建弹窗。
- 实现 Global、Local Cartesian、Face、Three-Point 坐标系。
- 坐标系成为 FeatureGraph 依赖；修改后原子重算相关特征和下游。
- 所有基础体和变换参数接入坐标系、原点、方向及表达式。
- 变量和坐标系随 XBF、Undo/Redo 保存恢复。

验收：修改 Width 或 LocalCS 后，所有依赖特征正确重算；失败不提交 revision。

### 阶段 C：工程树、Body 管理和多实体显示

状态：**已完成（2026-07-15）**。

- Project/Design/Variables/Materials/Coordinate Systems/Geometry 使用真实文档数据。
- 视口同时显示所有可见 Body，不再只有活动 Body。
- Body 支持重命名、显示隐藏、颜色、材料、删除、激活和用户属性。
- 树选择与视口选择双向同步。
- 双击 Feature 打开同一参数窗口并支持修改重算。
- Boolean 多输入在投影树中展示 Target/Tool 引用。

验收：多 Body 显示与树一致，重启和 Undo/Redo 后状态一致。

### 阶段 D：补齐基础实体建模

状态：**已完成（2026-07-15）**。

基础体：Box、Cylinder、Cone、Sphere、Torus、Wedge、Prism、Pyramid、Tube。

基础面：Rectangle、Disk、Cylinder、Cone、Sphere。每次创建独立 Sheet Body；Body 元数据持久化 Solid/Sheet/Wire 分类，树中明确展示。

变换：Translate、Rotate、Mirror Point/Axis/Plane、Uniform/Non-uniform Scale、Coordinate Transform、Align、Copy。

Boolean：Fuse、Cut、Common、Section、Split、Partition/Fragments、Imprint；支持多 Target/Tool、Keep、Refine 和结果拆分。

每个算法必须同时完成 OCCT 算法、FeatureNode、重算、拓扑历史、属性传播、API、操作窗口、几何树和回归测试。

### 阶段 E：常用细节与高级特征

- Chamfer、Shell、Thicken、Offset、Draft。
- Linear、Circular、Rectangular、Mirror Pattern。
- Revolve、Sweep/Pipe、Loft，输入仅来自已有 Face、预定义截面、3D Wire 或导入 Wire。
- 测量、Shape Check、Sew 和 Healing。

## 4. 阶段完成门槛

- 操作窗口预览不进入 FeatureGraph，确定后才提交事务。
- Feature 修改可重算全部下游，失败保持最后成功状态。
- Body/Face/Edge 属性只能正确传播、冲突或失效，禁止静默错绑。
- 菜单、Ribbon、右键菜单和快捷键不得实现重复且不一致的业务逻辑。
- 每个新命令必须具备成功、非法参数、旧 revision、重算失败和 Undo/Redo 测试。
- STEP 和 XBF 回归测试不得因新增建模能力退化。

## 5. 近期执行顺序

1. 阶段 A：命令系统与非模态窗口。
2. 阶段 B：标量变量与 Global/Local Cartesian 坐标系最小纵向链路。
3. 阶段 C：真实工程树、多 Body 显示和 Body 管理。
4. 阶段 D：按 Wedge → Tube → Prism/Pyramid → Section/Split → 多输入 Boolean 顺序扩展。



## 6. 阶段 B/C/D 完成记录（2026-07-15）

- 阶段 B：实现 Length、Angle、Dimensionless、Integer 标量变量，表达式、单位、量纲、依赖与循环检查；缺失变量可在建模窗口集中创建并自动重试。Global、Local Cartesian、Three-Point、Face Reference 坐标系持久化到 XBF；Face Reference 从选中面推导局部标架。变量或坐标系修改会重新求值并原子重放相关 FeatureGraph。
- 阶段 C：Project/Variables/Materials/Coordinate Systems/Geometry 使用文档数据；视口同时显示可见 Body；Body 支持名称、可见性、颜色、材料、激活、删除和 Body/Face/Edge 用户属性，并随 XBF 与 Undo/Redo 恢复。
- 阶段 D：补齐 9 类基础体、8 类变换和 Fuse/Cut/Common/Section/Split/Partition/Fragments/Imprint；Boolean 支持多 Target/Tool、Keep Target/Tool、Refine 与结果拆分，并写入 FeatureGraph、重算链和属性迁移流程。
- 验证：`npm run build:worker`、`npm run lint`、`npm test` 均通过；完整测试 35/35，通过新增阶段 B/C/D 端到端 OCCT 用例。

## 7. 阶段 E0 完成记录（2026-07-16）

- Boolean Feature 支持双击恢复并修改操作类型、Target/Tool 角色和 Refine，修改后原子重算下游；Keep Target、Keep Tool 与 Split Results 因会改变输出 Body 数量，在编辑模式中明确只读。
- Transform（Copy 除外）与 Fillet 支持抑制、恢复和删除。抑制会跳过该 Feature 并重算下游，恢复会重新启用，删除会把下游依赖重连到其前驱 Feature。
- Feature 生命周期操作遵守 revision 并发检查、失败不提交、XBF 持久化和文档 Undo/Redo。
- Primitive、STEP 根特征、Copy 与 Boolean 暂不直接抑制/删除；这些操作会改变存活 Body 的数量或身份，需要在下一阶段先实现结果 Body 重建事务。
- 验证覆盖 Boolean 编辑、非法输入回滚、Feature 抑制/恢复/删除、依赖重连、不支持类型报错和 Undo。
## 8. 基础面与 Sheet Body 完成记录（2026-07-17）

- 新增 Rectangle、Disk、Cylinder、Cone、Sphere 五类基础面，均支持标量表达式、单位、参考坐标系和 Feature 参数重算。
- 基础面创建独立 Sheet Body；Solid/Sheet/Wire 分类进入 API、XBF 持久化和几何树。STEP 导入及 Copy、Boolean、Offset、Thicken 和重算路径同步维护分类。
- Thicken 可从 Sheet Face 创建新的 Solid Body 并保留源 Sheet；Shell 对 Sheet 返回 `BODY_KIND_MISMATCH`，Offset 同时接受 Solid 与 Sheet。
- 菜单和 Ribbon 新增“基础面”，使用单一类型下拉弹窗；双击几何树中的 Surface Feature 可修改参数。
- 验证：Worker 编译、TypeScript 类型检查、前端构建及完整回归测试通过，测试总数 59/59。
## 9. 阶段 E1 Draft 拔模完成记录（2026-07-21）

- 新增 `detail.draft`，支持对 Solid Body 的平面、圆柱面和圆锥面执行拔模。
- 参数包括拔模角、中性面原点/法向和拔模方向，支持单位、角度变量和标量表达式。
- Draft 接入 FeatureGraph、参数重算、拓扑属性失效标记、抑制/恢复/删除和几何树标签。
- Web 特征菜单增加“拔模”，从 Face 选择进入非模态参数窗口。
- 验证：Worker 编译、TypeScript、前端构建及完整回归测试通过，测试总数 61/61。

下一步：实现 Pattern 所需的动态输出 Body 事务，再接入 Linear、Circular、Rectangular 和 Mirror Pattern。
## 10. 阶段 E1 Pattern 线性阵列完成记录（2026-07-21）
- 新增 `pattern.linear` OCCT 特征：沿指定方向复制 Solid/Sheet Body，支持数量、间距和方向参数。
- Pattern 使用动态 Body 事务：首个实例复用源 Body ID，新增实例分配独立 Body ID；编辑数量时自动扩展/收缩输出 Body，并保留名称、可见性、颜色和材料元数据。
- Pattern 已接入 FeatureGraph、参数重算、Body 属性映射、抑制/恢复/删除生命周期和几何树标签 `Linear Pattern`。
- Web 端新增“线性阵列”命令和 Body 选择弹窗，数量/间距支持标量变量表达式，方向支持 X/Y/Z 输入。
- 验证：`npm run build:worker`、`npm run typecheck`、`npm run lint`、`npm test` 全部通过；完整测试 63/63。

下一步：在 Pattern 动态 Body 事务基础上继续实现 Circular、Rectangular 和 Mirror Pattern，并补充阵列实例属性继承与拓扑映射策略。

## 11. Circular Pattern 环形阵列完成记录（2026-07-21）
- 新增 pattern.circular OCCT 特征，支持实例数量、旋转角度、旋转中心和旋转轴方向。
- 复用 Pattern 动态 Body 事务：首个实例复用源 Body，新增实例独立显示；编辑数量可扩展/收缩 OutputBodies。
- Circular Pattern 已接入 FeatureGraph、参数重算、Body 元数据、抑制/恢复/删除生命周期和几何树标签。
- Web 端新增“环形阵列”命令及 Body 选择弹窗，支持角度/坐标/轴向表达式输入。
- 验证：npm run build:worker、npm run typecheck、npm run lint、npm test 全部通过；完整测试 65/65。

下一步：实现 Rectangular Pattern，并抽取线性/环形阵列的公共参数校验、实例元数据继承和拓扑映射组件。


## 12. Rectangular Pattern 矩形阵列完成记录（2026-07-22）
- 新增 pattern.rectangular OCCT 特征，支持 X/Y 实例数量、X/Y 间距以及两条方向向量。
- 阵列按二维网格生成最多 100 个 Body，首实例复用源 Body，其他实例使用独立 Body ID。
- Rectangular Pattern 已接入参数重算、动态 OutputBodies、Body 元数据继承、抑制/恢复/删除生命周期和几何树。
- Web 端新增“矩形阵列”菜单和 Body 选择弹窗。
- 验证：worker 编译、TypeScript、lint、完整回归均通过；测试总数 67/67。

下一步：抽取三类 Pattern 的公共参数/实例事务代码，并实现 Mirror Pattern。


## 13. 阶段 F1-F5 与 G 第一批完成记录（2026-07-22）
### F1 Pattern 公共事务
- 统一 Linear/Circular/Rectangular/Mirror Pattern 的 Body 输出、实例元数据和动态 OutputBodies 处理。
- 统一参数重算、实例数量编辑、生命周期和错误回滚逻辑。

### F2 Mirror Pattern
- 新增 pattern.mirror，支持镜像平面原点与法向。
- 支持 Body 创建、编辑、抑制、恢复、删除和几何树展示。

### F3 属性与拓扑映射
- Pattern 新实例继承 Body 用户属性。
- Face/Edge 属性通过拓扑索引映射复制，冲突保留 conflict 状态。

### F4 编辑体验
- Pattern 类型统一进入特征编辑器。
- 支持表达式参数、变量引用和编辑后重算。
- 前端新增 Linear/Circular/Rectangular/Mirror 四类操作弹窗。

### F5 稳定性
- 新增 Mirror Pattern Undo/Redo 回归。
- Pattern 动态 Body、Shape Check、属性继承均有 API 测试。
- XBF、Undo/Redo、旧 revision 和异常回滚复用现有文档事务机制。

### G 第一批：Shape Check
- 新增 geometry.check 只读命令，返回 Body 有效性、Face/Edge/Solid 统计。
- 前端新增 Shape Check 分析窗口。
- 验证：worker 编译、TypeScript、lint、完整测试 73/73 通过。

G 阶段后续仍需实现 Revolve、Sweep/Pipe、Loft、Measure 等生成式高级建模能力。

## 14. G1 Measure、G2 Revolve 完成记录（2026-07-22）

### G1 Measure
- 新增只读命令 geometry.measure，返回 Body 的体积、面积、边界长度和包围盒。
- Measure 接入命令注册、分析菜单、操作窗口和回归测试；不会修改模型 revision。

### G2 Revolve
- 新增 detail.revolve OCCT 特征：从选中的 Face 按角度、轴原点和轴方向生成新的 Body。
- Revolve 的输入 Face、角度、坐标和轴向量保存到 FeatureGraph，支持单位/标量变量表达式。
- 支持参数编辑、重算、抑制、恢复、删除、Body 属性继承和几何树显示。
- 前端新增 Face 选择模式、Revolve 操作窗口、特征菜单入口和编辑历史入口。

### 验证
- npm run build:worker、npm run typecheck、npm run lint、npm test 均通过。
- 全量回归测试：77/77 通过。

下一步：G3 Sweep/Pipe 与 Loft，沿用相同的 FeatureGraph、参数表达式、Body 生命周期和回归测试闭环。
## 15. Face/Edge Measure 扩展记录（2026-07-22）

- geometry.measure 统一支持 Body、Face、Edge 三类选择对象。
- Body 返回体积、表面积、边界长度和包围盒。
- Face 返回面积、周长、重心和包围盒。
- Edge 返回长度、曲线类型、重心、端点和圆弧半径/圆心（适用时）。
- 前端 Measure 窗口根据当前拾取对象展示对应字段；Face/Edge 测量不会修改模型 revision。
- 新增 API 与 UI 回归测试，覆盖 Face/Edge 选择和结果字段。
## 16. 材料自定义属性完成记录（2026-07-22）

- MaterialRecord 新增 customProperties，Key 为字符串，支持 bool、int、double、expression。
- expression 属性保存原始表达式、量纲和 resolvedValue，并复用 ScalarVariableStore 求值。
- material.set 支持批量保存；新增 material.property.set / material.property.delete 单项 API。
- 自定义属性随材料 JSON/XBF 持久化，内置材料保持只读。
- 前端材料管理窗口新增 Key/Type/Value/Dimension 编辑表格。
- 全量回归测试：80/80 通过。
## 17. 对象自定义属性完成记录（2026-07-23）

- Body、Face、Edge 均支持用户自定义 `key/value` 属性，属性名称为字符串，最长 128 个可打印字符。
- 对象属性仅支持 `bool`、`int`、`double`、`expression` 四类规范类型，已移除 `boolean`、`integer`、`real` legacy 类型。历史工程如包含旧类型，需要先迁移。
- 新增/复用 `property.set`、`property.delete`、`property.list` API；属性随文档 JSON/XBF 持久化，并遵循 revision 并发校验及拓扑失效规则。
- Web 属性编辑器按对象类型显示，支持类型下拉、值编辑、保存和删除；表达式以原始表达式保存，后续可接入变量求值与单位校验。
- 材料对象同步支持相同的自定义属性模型，材料属性由项目数据面板管理。
- 验证：`npm run typecheck`、`npm run lint`、`npm run build` 及全量回归测试通过；测试总数 82/82。
## 18. 建模控制层第一阶段完成记录（2026-07-23）

- 新增 `app/modeling/command-contract.ts`，统一建模请求协议：`protocolVersion`、`requestId`、`documentId`、`operation`、`baseRevision`、`inputs`、`parameters` 和 `options.idempotencyKey`。
- 新增 `app/modeling/modeling-controller.ts`，集中管理命令传输、revision、模型快照、Body/Face/Edge 选择、活动操作、pending 状态和结构化错误。
- `CadDemo` 的 `/commands` 调用和模型刷新已接入 ModelingController；现有建模面板保持兼容，后续可按面板逐步迁移。
- `command-registry.ts` 增加命令元数据：是否修改文档、是否可撤销、是否支持预览、选择前置条件和对应 Worker operation。
- 新增 `tests/modeling-control.test.mjs`，覆盖命令契约、控制器状态和 CadDemo 接入。
- 验证：TypeScript、ESLint、前端生产构建通过；全量回归测试 85/85 通过。

下一阶段：迁移建模面板到统一 CommandBus，并建立后端统一事务包装和失败回滚机制。
## 19. 建模控制层第二阶段完成记录（2026-07-23）

- 新增 `app/modeling/runtime.ts`，所有建模面板共享同一个 ModelingController 实例和 CommandBus。
- 已迁移基础体/基础面/变换、Boolean、旧版 Direct Modeling、Feature History、变量/坐标系/材料、Body/Face/Edge 属性面板。
- 面板不再直接请求 `/commands`，统一注入 `protocolVersion`、`requestId`、`documentId` 并使用统一错误处理。
- AdvancedProjectDataPanel 保留 stale revision 自动刷新后重试逻辑，并改用 ModelingCommandError 错误码。
- 新增共享命令通道回归测试，验证所有建模面板不再绕过 runtime。
- 验证：TypeScript、ESLint、前端生产构建通过；全量回归测试 86/86 通过。

下一阶段：建立 Worker 端统一事务包装，统一成功提交、失败回滚、revision 递增和历史事件记录。
## 20. Worker 事务层第一版完成记录（2026-07-23）

- `geometry-worker/src/main.cxx` 增加统一 mutation operation 分类和 `dispatchTransactional` 包装。
- 所有基础体、基础面、变换、Feature、Boolean、Pattern、Body、变量、坐标系、材料、对象属性和 STEP 导入命令，执行前保存临时 XBF 检查点。
- 命令成功返回 `transaction.state=committed`、`beforeRevision` 和 `afterRevision`；命令异常时自动恢复检查点并保持原模型与 revision。
- 事务检查点文件包含 Worker 进程 ID，避免多 Worker 并发测试或多会话之间发生文件名冲突。
- 修复 `CadDocument::initializeDocument()` 未显式关闭旧 XCAF 文档的问题，保证 reset 失败后可以恢复检查点。
- `property.list` 明确保持只读，不创建事务检查点。
- 新增 geometry API 集成测试，验证 reset 建模失败后的 Body、revision 和模型状态保持不变。
- 验证：Worker 编译、TypeScript、前端构建通过；全量回归测试 87/87 通过。

下一阶段：补充事务事件持久化、请求幂等键、Worker 命令 schema 校验，以及统一历史事件与 Undo/Redo 状态。
## 21. Gateway 历史事件、幂等与命令校验完成记录（2026-07-23）

- `gateway/history-store.mjs` 的 manifest 增加有界 `events` 日志，随当前检查点、Undo/Redo 栈一起持久化，并在加载、修复和清理时保持一致。
- `gateway/server.mjs` 为每次成功 mutation、Undo 和 Redo 生成事件，记录 `eventId`、请求 ID、操作名、前后 revision、状态和时间戳；响应通过 `history.lastEvent` 暴露最近事件。
- `/api/commands` 支持 `requestId`、`idempotencyKey` 或 `options.idempotencyKey` 作为客户端幂等键；同一文档、同一操作和同一键在当前 Gateway 进程内重放原响应，不重复修改模型。
- 增加命令包基础校验：限定 operation 命名格式、protocolVersion、inputs/parameters 对象类型和非负 baseRevision，并返回结构化错误码 `INVALID_OPERATION`、`UNSUPPORTED_PROTOCOL`、`INVALID_INPUTS`、`INVALID_PARAMETERS`、`INVALID_REVISION`。
- Undo/Redo 也使用同一历史事件模型和幂等处理；只读命令继续返回当前历史能力和最近事件，但不产生新事件。
- 新增 Gateway 集成测试，覆盖事件字段、重复请求重放、Undo 事件及无效命令包；全量验证 `npm test` 通过，测试总数 88/88。

当前边界：幂等响应缓存是单 Gateway 进程内存缓存；历史事件和检查点可跨重启恢复。后续可在多实例部署阶段将幂等结果迁移到共享持久化存储，并补充更完整的 operation schema/权限校验。
## 22. Gateway 安全与可观测性阶段完成记录（2026-07-23）

- 历史 manifest 增加有界文档级 `idempotency` 记录，保存请求指纹和成功响应；Gateway 重启后仍可对相同文档、操作和幂等键进行安全重放。
- 幂等键绑定稳定请求指纹；同键不同负载返回 `IDEMPOTENCY_CONFLICT`，不会再次修改模型。Undo/Redo 使用相同机制。
- `/api/commands` 增加 Worker 已注册操作白名单，未启用操作返回 `UNSUPPORTED_OPERATION`；基础体、平移和 Boolean Cut/Fuse/Common 增加必填参数 schema 校验，缺失字段返回 `SCHEMA_VALIDATION_FAILED`。
- 增加 `GEOMETRY_REQUEST_TIMEOUT_MS`、`GEOMETRY_JSON_LIMIT_BYTES` 和 `GEOMETRY_STEP_LIMIT_BYTES` 配置，分别约束请求超时、JSON 请求体和 STEP 上传大小。
- Gateway 输出结构化 `cad.command` 日志，包含 requestId、documentId、operation、耗时、结果码、revision 以及 Body/Feature 影响对象。
- 新增跨重启幂等重放、冲突检测、操作白名单和参数 schema 集成测试；全量验证 `npm test` 通过，测试总数 89/89，ESLint 无错误。

下一阶段进入 Modeling Agent 规划层：增加自然语言到安全命令计划的解析、选择对象需求识别、缺参询问以及高风险操作确认，并通过 Preview/Commit/Cancel 执行层接入现有 ModelingController。
## 23. Modeling Agent 规划层第一版完成记录（2026-07-23）

- 新增 `app/modeling/modeling-agent.ts`，提供确定性的自然语言到建模计划转换器，当前覆盖长方体、圆柱体、球体、Boolean Fuse/Cut/Common、Fillet、Measure、Undo/Redo 和 Body 删除意图。
- Agent 只允许输出安全命令集合中的 operation，不直接访问 `/api/commands`；计划通过 `ModelingController.plan()` 进入统一状态，保留当前 revision 和选择对象上下文。
- 计划会识别 Body/Face/Edge 选择需求，缺少尺寸、半径或选择对象时生成结构化问题；Boolean、删除等高风险操作生成确认状态 `HIGH_RISK_OPERATION`。
- 工作台新增“建模助手”操作窗口，用户可以输入自然语言并查看 operation、参数计划、缺参提示和风险确认状态；本阶段只生成计划，不修改模型。
- 新增 `tests/modeling-agent.test.mjs`，覆盖安全命令、缺参/选择识别、风险确认、Controller 状态和 UI 入口；全量回归测试通过，测试总数 93/93。

下一阶段：为计划增加 Preview/Commit/Cancel 执行协议，支持多步计划、逐步确认、失败恢复和重试，并将计划步骤映射到现有统一 CommandBus。
## 24. Preview/Commit/Cancel 第一版完成记录（2026-07-23）

- Gateway 新增预览事务：先保存临时 XBF 检查点，执行建模命令，再自动恢复；预览响应标记 `preview.state=preview` 和 `transaction.state=preview`，`revision` 保持原值，不写入 Feature 历史和 Undo 栈。
- `ModelingController.executePlan(plan, mode)` 统一处理 `preview`、`commit`、`cancel`；高风险计划必须先调用 `confirmPlan()`，缺少参数或选择时禁止 Commit。
- 建模助手窗口新增 Preview、Commit、Cancel 和高风险确认按钮；Commit 后刷新当前模型快照，Preview 只展示结果状态，不改变工作台模型。
- 新增预览事务集成测试，验证预览后 Body 数量、revision、Undo 状态均保持不变；全量构建和回归测试通过，测试总数 94/94。

当前边界：Preview 目前以单步计划为主，复杂多步计划、预览几何叠加显示和跨步骤失败恢复将在下一阶段扩展。
## 25. 多步 Modeling Agent 执行与失败恢复（2026-07-24）

- `createModelingPlan` 支持按“然后/之后/再/并且/then/after”拆分多步自然语言请求，合并步骤、问题和确认状态；每一步仍必须落在安全命令白名单内。
- `ModelingController.executePlan(plan, mode)` 按步骤串行执行，持续更新 `planExecution`（当前步骤、总步骤、尝试次数、运行/完成/失败/取消状态），并把上一步 revision 传给下一步。
- Commit 过程中任一步失败时，控制器自动对已完成步骤发起 Undo，回到执行前的可恢复状态；失败信息保留在状态中，界面提供 Retry。Cancel 会清理当前计划且不提交模型变更。
- Modeling Agent 面板展示步骤序号和执行结果，支持 Preview、Commit、Cancel、风险确认及失败重试；Preview 当前按步骤独立回滚，尚未提供跨步骤组合几何预览，后续可增加临时事务上下文。
- Node 原生 TypeScript 回归测试覆盖两步计划解析，以及第二步失败时第一步自动回滚；控制器依赖改为显式 `.ts` 扩展名以支持测试运行时加载。
- 验证：`npm run typecheck`、`npm run lint`、`npm run build`、`npm test` 全部通过。

## 26. 完整命令状态与 Worker 恢复补强（2026-07-24）

- ModelingController 状态现在包含模型快照、`currentBodyId`、`selection`、`activeOperation/operationWindow`、`pendingOperation`、`busy`、错误和 Agent 执行状态；命令返回完整视图时自动同步快照。
- `normalizeCommandRequest` 固定补齐 `protocolVersion`、`requestId`、`documentId`、`inputs` 和 `parameters`，所有建模面板通过统一控制器提交 intent。
- STEP 导入/导出已从面板直连 API 迁移到控制器，使用 `X-Request-Id`、统一忙状态和结构化错误；Gateway 专用路由返回历史状态。
- Gateway 对 Worker 命令增加超时保护；Worker 退出后自动延迟重启并清空已加载文档，下一条请求会通过持久化检查点恢复模型。
- 失败计划重试会累加 `planExecution.attempts`，取消会清理计划、pending 状态和 busy 状态。

## 27. 命令映射、错误契约与可观测性收口（2026-07-24）

- `app/commands/command-registry.ts` 新增 `CAD_WORKER_OPERATION_MAP`，完整盘点文件交换、撤销重做、工程数据、基础体/面、变换、Boolean、Pattern、Feature、分析和 Body 生命周期到 Worker operation 的映射。
- Modeling Agent 使用同一注册表生成 `CAD_SAFE_WORKER_OPERATIONS`，不再维护独立的可执行白名单。
- Gateway 的命令异常、路由异常和下载异常统一返回 `protocolVersion/requestId/documentId/code/error/recoverable`；命令超时使用 HTTP 504。
- `cad.command` 日志除耗时、revision、结果码外，增加 `bodyIds` 和 `featureIds` 影响集合，便于链路追踪和故障定位。

## 28. G3 Sweep/Pipe/Loft 第一版（2026-07-24）

- Geometry Worker 新增 `detail.sweep` 与 `detail.pipe`：从选中 Body/Face 沿参数化路径向量生成新的 Body，路径参数支持 `pathX/pathY/pathZ`（兼容 `dx/dy/dz`），结果写入 FeatureGraph、Body 属性继承和拓扑失效记录。
- 新增 `detail.loft`：接收逗号分隔的 `sectionBodies`（2~32 个截面 Body），基于截面包围盒生成 OCCT `BRepOffsetAPI_ThruSections` 实体，并保存截面依赖、间距参数和输出 Body 元数据。
- Sweep/Pipe/Loft 接入 Worker 分发、Gateway 白名单、命令映射、Feature 类型标签及历史重算；支持 `feature.update` 修改路径/截面间距并按 revision 原子重算。
- 新增 `tests/sweep-loft.test.mjs`，覆盖 Sweep 创建、参数编辑重算和多截面 Loft；本阶段通过 Geometry Worker 编译及端到端测试。

下一阶段：补充 Sweep 的真实曲线/路径引用、Loft 的 Face/Wire 截面选择、预览几何和更完整的拓扑属性映射。

## 29. OpenAI-compatible Modeling Agent 第一版（2026-07-24）

- 新增 `gateway/llm/provider-config.mjs`：Provider 配置、URL 校验、API Key 加密存储和掩码返回；配置通过 `GEOMETRY_DATA_DIR` 持久化，`AGENT_CONFIG_SECRET` 作为加密主密钥。
- 新增 `gateway/llm/openai-compatible-client.mjs`：支持 Responses API、Chat Completions、结构化 ModelingPlan JSON、自动协议回退和 SSE 流式输出。
- 新增 `gateway/llm/plan-validator.mjs`：大模型输出必须通过 JSON、operation 白名单、选择类型、风险确认和步数限制校验；大模型不能直接调用 Geometry Worker。
- Gateway 新增 Provider 管理、连接测试、普通规划和 SSE 规划接口：`/api/agent/providers`、`/api/agent/plan`、`/api/agent/plan/stream`。
- `ModelingController` 新增 Provider 管理、普通规划和流式规划方法；`ModelingAgentPanel` 优先使用配置的大模型，未配置时保留本地规则规划器作为 fallback。
- 新增 Provider 设置界面，支持 URL、API Key、模型、协议和连接测试；API Key 不返回浏览器、不写入日志。
- 新增 Provider 加密、Responses/Chat Completions、SSE、计划安全校验和 Gateway 端到端测试。

安全边界：默认禁止私有 Provider URL；本地开发可设置 `AGENT_ALLOW_PRIVATE_URL=true`。规划结果必须经过本地校验和 Preview/Commit/Cancel，模型服务不可直接修改 OCCT 文档。

## 30. Modeling Agent 规划层增强（2026-07-25）

- 计划管线拆分为 Planner、Resolver、Safety Gate 和 Reporter，入口为 `gateway/llm/agent-plan-pipeline.mjs`。
- Provider 路由支持显式选择、环境变量默认 Provider 和优先级；不再固定依赖 Provider 列表第一个元素。
- 新增 Agent 审计事件持久化和查询接口；计划 ID/会话 ID 贯穿 CAD 命令日志，便于定位 Agent 造成的几何变化。
- 新增 Provider 路由、审计脱敏、Gateway 审计接口回归测试。

下一阶段：在 JSON 计划稳定后，再增加受限的结构化工具描述，并继续保持 Safety Gate 和 CommandBus 不可绕过。
## 31. ## 31. 当前 Agent Tool Calling 实现（权威状态）

- Local 规则解析已禁用；`createModelingPlan()` 只保留阻断错误，运行时不会 fallback 到本地解析。
- Provider 的 CAD Tool Calling 强制开启，模型不能返回 `modeling_plan` JSON 作为执行协议。
- Web UI 的 Agent 请求统一走 `POST /api/agent/run/stream`。
- Gateway 的 `runAgentLoop()` 每轮重新加载会话、上下文和工具，执行 Tool Call，将 `role: tool` 结果写回会话，再进入下一轮模型调用。
- Chat Completions 使用结构化 assistant/tool 消息；Responses 使用 function_call/function_call_output 输入项。
- Plan 模式只提供查询/测量工具；Edit 模式才允许修改工具。高风险操作保存原始 Tool Call，确认后恢复执行。
- Tool 参数、Schema、CAD 执行错误都会作为 Tool Result 回传给模型；不会切换 JSON 或 Local fallback。
- 详细说明见 `docs/AGENT_TOOL_CALLING_LOOP_zh.md`。

## 32. 本轮验证

- 全量回归测试：147 项通过（包含 Agent 外层循环、Tool 结果修正、确认恢复、结构化会话历史）。
- TypeScript 类型检查和生产构建通过。