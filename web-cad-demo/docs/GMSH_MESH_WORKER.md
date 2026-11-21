# libgmsh 网格 Worker

`mesh-worker` 是独立的 C++ 进程，通过 stdin/stdout 使用“一行一个 JSON 请求”，内部直接链接 Gmsh SDK 的 `libgmsh`。独立文件修复/交叉工具仍由它执行；工程剖分的 CAD 修复与联合分块由现有 OCCT Worker 在只读临时快照上执行，保留真实面/体历史。网关负责工程串行快照、任务持久化、路径隔离、来源校验、属性解析与 HTTP 映射。

## 构建与运行

```powershell
$env:GMSH_ROOT = "C:\msys64\ucrt64"
npm run build:mesh-worker
$env:GMSH_BIN = "C:\msys64\ucrt64\bin"
```

SDK 至少应包含 `include/gmsh.h`、`lib/libgmsh.dll.a`（或 `gmsh.lib`）以及运行时 DLL。

## Worker 操作

### 预检

```json
{"protocolVersion":1,"requestId":"r1","operation":"mesh.preflight","parameters":{"inputPath":"D:\\models\\part.step"}}
```

返回点、曲线、面、体数量、重复节点数量和是否存在闭合体。

### 脏几何修复

```json
{"protocolVersion":1,"requestId":"r2","operation":"mesh.repair","parameters":{"inputPath":"D:\\models\\part.step","outputPath":"D:\\models\\part-repaired.step","repairMode":"aggressive","tolerance":1e-6}}
```

- `strict`：只加载并导出，不改动拓扑。
- `conservative`：修复退化实体、缝合面，并保留小边/小面的几何细节。
- `aggressive`：在容差范围内同时修复小边、小面，适合后续网格失败的模型。
- STL 等离散输入会执行表面分类、拓扑重建和重复节点/单元清理。

### 表面交叉处理

```json
{"protocolVersion":1,"requestId":"r3","operation":"mesh.intersections","parameters":{"inputPath":"D:\\models\\part.step","outputPath":"D:\\models\\part-fragmented.step"}}
```

对 STEP/IGES/BREP 使用 OCC 的重复实体清理和交叉归一化；对 STL/离散面执行面分类和去重。任意相交三角形并不能仅靠分类自动拆分，Worker 会在 `warnings` 中明确提示，需要上层三角网格重构或人工修复。

### 四面体网格生成与质量分析

```json
{"protocolVersion":1,"requestId":"r4","operation":"mesh.create","parameters":{"inputPath":"D:\\models\\part.step","outputPath":"part.msh","dimension":3,"repairMode":"conservative","resolveIntersections":true,"qualityName":"minSICN","qualityThreshold":0.2}}
```

`mesh.create` 会在生成四面体后返回 `mesh.quality`，包含四面体数量、最小/最大/平均质量、低于阈值数量和倒置单元数量。也可以单独分析已有 `.msh`：

```json
{"protocolVersion":1,"requestId":"r5","operation":"mesh.quality","parameters":{"inputPath":"D:\\models\\part.msh","qualityName":"minSICN","qualityThreshold":0.2}}
```

质量指标支持 Gmsh 的 `minSICN`、`minDetJac`、`gamma`、`innerRadius` 等名称。

## 工程模式的独立连接验收

Gmsh 进程成功和质量指标为正，不等于工程网格已经通过验收。工程任务由 Gateway 的材料线程读取封存质量索引，按 `tetra-preprocessing-v2` 重新检查来源、数值质量及角点连接；独立文件 `mesh.quality` 的指标输出本身不宣称完成这套工程门禁。

`gateway/mesh-connectivity.mjs` 逐单元建立精确打包的四面体/三角面键，检查重复四面体、面共享次数、共享面方向，并与 Gmsh 实际外边界面单元总数核对。结果位于 `mesh.admission.topology`，依据为 `tetra-corner-connectivity-v1`，含计数、最多 8 条编号样例及逻辑缓冲资源统计。角点重复的高阶单元同样无效，但中间节点未包含在角点索引中，不能由此认证全部高阶共形。

样例新增 `cellNodeIndexes`（参与单元的四个原始角点序号）及 `cell`：后者采用现有质量定位单元结构，含 12 个世界坐标、精确字符串单元 ID、数值状态、Body 列表与持久身份。`nodeIndexes` 是此质量索引内的零基节点序号，不是 CAD Face/Edge 编号；公共面的三点必须属于参与单元。坐标与单元来自同一认证文件观察期，完成两遍摘要/身份核对后才发布，不增加另一条按路径重读的定位接口。

前端复用现有质量定位层，不显示整份未通过网格，也不加入 CAD 拾取缓存。没有可靠坐标/归属时 `cell.locatable=false` 或 `cell=null`；超过 80 字符的显示编号另带 `elementIdTruncated=true`，不能用截断 ID 作为真实标识定位。报告会保留已过期历史样例，但不会把它们高亮到当前工程。

打包表的节点编号和完整元组都进行精确比较，哈希冲突不等于相同连接。表容量、线性探测次数与分配失败有独立资源错误，不能返回部分检查的“通过”。新结果封存及旧结果读取都经过同一门禁；未通过的结果只允许显式诊断下载。详细范围与内存边界见 README 的“工程网格验收门禁”。任意不相邻单元空间交叉、完整边/顶点流形和离散脏面重构仍需另外处理。

## Gateway 接口

```text
GET  /api/mesh/health
POST /api/mesh/preflight
POST /api/mesh/repair
POST /api/mesh/intersections
POST /api/mesh/create
POST /api/mesh/quality
GET  /api/mesh/outputs/:fileName
```

Gateway 将生成文件写入受控的 `meshes` 数据目录，只允许文件名，避免任意路径写入。修复和交叉处理接口会返回 `downloadUrl`；质量分析接口不生成文件。

## 能力边界

“脏几何修复”不是无条件成功：Worker 会返回实际处理步骤和 warnings。CAD 实体的缝合、退化边/面、小实体清理由 OCC 完成；离散交叉面需要后续三角面相交检测和重构，这部分不能假设 Gmsh 的 `classifySurfaces` 会自动完成。
## 当前工程剖分与视口显示

工作台中的“网格剖分”直接读取当前工程修订版，不要求用户手动填写 STEP 路径：

POST /api/documents/:documentId/mesh/jobs
GET  /api/documents/:documentId/mesh/jobs
POST /api/mesh/jobs/:jobId/visibility
DELETE /api/mesh/jobs/:jobId

工程任务始终对全部几何联合剖分。传入 `selection` 会被明确拒绝，Body/Face 选择只用于结果检查和显示；独立文件接口仍支持二维表面剖分。请求 `background:true` 返回 202，状态依次为 preparing/queued/running，完整结果通过 `GET /api/mesh/jobs/:jobId` 读取。取消用 `POST /api/mesh/jobs/:jobId/cancel`；详情见工业化路线记录。

### 工程诊断与可复用修复快照

同一任务接口支持 `kind:"preparation"`，不新建平行任务系统，也不会为预览启动 Gmsh：

```json
{"kind":"preparation","background":true,"baseRevision":42,"repairMode":"conservative","deepCheck":true}
```

准备完成后，任务详情包含 `preparation.diagnostics` 和显示专用的 `preparation.preview`，不含 `mesh`。任务目录另保存完整 `prepared.brep`、`prepared-manifest.json` 及各自 SHA256/长度。显示数据最多 20000 个三角形、1000 条边（曲线每边最多 12 点）；截断不影响完整 BREP。只读快照不是新的工程 Body，不占用工程拾取 ID。

报告 v1 包含 `status`、当前 `stage`、修复模式/容差、深入检查开关，每 Body 的 `before` / `afterRepair`，以及 `afterPartition`。小特征阈值为 `max(包围盒对角线×1e-6, 修复容差×10)`，它用于诊断提示，不是自动删除准则。原始问题带持久身份限定的 CAD 目标；复制时通过真实 Copy 历史还原原面/边 ID，不假设复制后枚举未变。修复后及分块后问题只指快照拓扑。每阶段明细上限 128 项，保留全部严重性计数和截断标志；尚未检查的 Body 明确不可视为通过。

深入自交检查在输入与修复后的各 Body 上运行，不在联合结果上额外运行；报告区分 `complete` / `not-run` / `failed`。检查未完成显示警告，不伪造“通过”；修复或联合分块后存在已知阻断错误则拒绝发布。失败报告保留阶段、原因和已得到的明细，Sheet-only 工程因缺少闭合实体失败也可查看开放边界。

复用任务只传来源 ID，不接受客户端上传 BREP 路径：

```json
{"background":true,"preparationJobId":"mesh-00000000-0000-0000-0000-000000000000","repairMode":"conservative","qualityThreshold":0}
```

服务器在同一工程串行边界内核对来源身份、修复模式和封存文件完整性，再直接将这些 BREP 字节传给 Gmsh，不重新运行 OCCT 准备。几何变化使复用失效；纯名称/材料/显隐元数据变化不使几何来源失效，来源修订号仍保留预览时的值。报告恢复不仅检查校验和，还验证有限数值、计数一致性、来源目标、显示数组及任务设置/概要，不接受结构合法但语义不一致的报告。

准备任务使用原有取消和持久恢复机制：关闭窗口继续准备，取消等本次 OCCT 请求结束后丢弃结果，不终止活工程内核；重启标记未完成任务为中断，不自动重试。预览任务不能通过网格显隐接口展示。页面恢复分别载入最近可渲染网格和最新诊断，不能让较旧网格附带的报告覆盖较新的预览报告。

中文路径覆盖 BREP、来源清单、预览任务和 Gmsh 质量索引。质量文件使用原生文件系统路径打开；ASCII MSH 编号验证若打不开输入则明确失败，不再跳过验证。

工程中独立 Wire/点或复合体中的游离边/点尚未接入线/点约束剖分，返回 `MESH_UNSUPPORTED_FREE_TOPOLOGY` 并保留输入诊断，不在“全部几何”任务中静默忽略。Boolean Section 形成的 Wire 同样遵循此限制。

- 网格结果创建及恢复后默认隐藏。仅保留网格窗口的整体显隐和几何树每 Body 一个网格显隐按钮；Sheet Body 同样可显示其面网格。
- 来源有效性比较完整 Body 集合及 Body/拓扑状态身份，不能只比较 revision。纯材料/显示元数据变化不使网格失效，精确撤销可恢复原来源；新增 Body 或复用修订号的新分支会失效。
- 列表仅返回任务/质量概要，当前选中结果按需载入；结果文件具有 SHA256/长度校验，恢复不自动重剖分。

### CAD 面与网格面的来源协议

```text
当前工程（串行读取）
 → OCCT 深拷贝 + ShapeFix + 全量 Splitter（保留历史）
 → 临时 BREP + v2 来源清单
 → Gmsh 严格导入并核验证书
 → 共形四面体 + 面 Physical Groups + boundaryMapping
```

- 临时修复/分块不产生建模 Feature，不改动工程参数、属性、身份或原始 BRep；一个 Body 中的多个 Solid 也参与联合分块。
- `strict` 不调用 ShapeFix，但仍进行保证共形所需的联合分块；`conservative` 和 `aggressive` 分别采用 1e-8、1e-6 的修复精度/最大容差。它们不是独立文件工具中 Gmsh healShapes 参数的同义包装，也不承诺任意脏几何修复成功。
- 清单记录输出 Solid/Face 到原始 Body/Face 的实际修复/Boolean 历史，保留一对多、多对一、多来源及 removed/unresolved。独立的 `meshFaceId` 不得当成 `cadFaceId`。
- BREP 索引协议显式为 `solids-first-recursive`：先递归枚举 Solid 边界，再加入自由面。Gmsh 通过 `occ.importShapes(..., highestDimOnly=false)` 导入，不自动修复、缝合或再 Fragment；逐实体核对数量、体积/面积、质心、包围盒及邻接。协议或证书不匹配就拒绝，不按最近质心补配。SDK 升级必须重跑混合维度导入测试，不能假设索引永远兼容。
- 内部开放面记录为 embedded，而非体边界；显式设置 Gmsh 嵌入约束。界面和嵌入面都核对实际面节点 ID 是否被对应体单元引用，不能用坐标重合代替共形证明。
- `.msh` 保留 `Body/<bodyId>` 和 `CADFace/<bodyId>/<cadFaceId>` Physical Groups。属性值不写入 MSH；通过面来源接口按当前类型化实例解析，避免把可变工程属性固化成过期数据。

`GET /api/mesh/jobs/:jobId/boundary?bodyId=...&cadFaceId=...` 返回来源面、目标网格面、邻接/嵌入体、面单元数量和属性实例。`cadFaceId` 筛选必须同时提供 Body。几何来源过期时仍可读历史对应，但不关联当前属性；属性值修改不触发重新剖分，点击“刷新面属性”读取最新值。未解析或孤立实例单独列出，不静默赋给第一个网格面。

界面“面来源与属性”使用分页表格，支持按 Body 筛选、展开属性值及定位 CAD 面。定位正对该面并显示实际高亮；隐藏 Body 或过期来源禁止定位，不改变整体网格显隐。

仍未完成：任意离散三角面交叉重构、真实工程级脏几何大样本基准、全部面来源的规模门禁，以及全部几何修复行为的完备性证明。质量索引已有流式验收和分块分页，不能据此认定整个网格/面来源链路均满足工业规模。当前单元/面检查不代表所有工业输入均已支持。[Gmsh API 参考](https://gmsh.info/doc/texinfo/#gmsh_002fmodel_002focc_002fimportShapes)

### 线性四面体空间重叠验收（候选，2026-11-16）

`tetra-preprocessing-v3` 在数值质量、连接拓扑、覆盖和归属检查之外，增加 `admission.spatial`。正 Jacobian、没有重复节点/公共面异常，并不排除两个不相邻单元发生空间穿透。该检查不相信 Worker 提供的通过标志，也不只检查顶点是否在另一个单元内部。

- `basis: linear-tetra-positive-volume-sat-v1`。使用包围盒树筛选候选对，再检查双方全部面法向及 36 个边叉积方向，判定线性四面体内部是否存在正体积交集。正常共面、共边、共点接触不算体积重叠；不设一个会吞掉微小穿透的几何容差。该接触分类不证明接触双方已共享节点或完整共形。
- 几何谓词先作保守浮点过滤；符号不确定、下溢或溢出时，按输入 binary64 的精确二进制有理数做 BigInt 行列式符号计算。它证明保存的坐标所定义的线性单元关系，不证明原 CAD 曲面或高阶映射的关系。实现是本项目的过滤/二进制有理数计算，不是移植 Shewchuk 的展开算术代码。
- `checkedTetraCount` 为真正检查的非退化线性单元；`overlapPairCount` 每个无序对只计一次，最多保存 8 个样例。样例含两个完整角点坐标、实际 volumeTag 及两个展示编号；编号最多 80 字符，并独立记录截断，不能当作精确定位键。`ownersVerified` 必须来自原索引单元 bodyIds 与该体的完整归属集合相等，不能在样例生成时悄悄换成推测归属。经验证的 `cells` 只保存几何/来源身份，不伪造质量值或 invalid 标记。
- 空间样例已接入报告内“双单元定位”：A 红色、B 黄色，同时展示实际角点四面体，不仅渲染第一个单元。每一方都要有当前持久身份和至少一个可见的有效 Body 归属；隐藏任一方全部归属便暂停整对高亮，再显示时恢复。来源过期、归属矛盾、截断编号、缺损或超出 Float32 范围的坐标禁用。只清除诊断层，不修改几何/材料显隐，不把网格节点当成 CAD 选择，不自动显示整份被阻止的网格。
- 高阶曲边单元不拿角点凸包代替完整曲边单元：`status: partial`、`skippedHighOrderCount` 与明确警告同时出现。保留既有高阶网格可用性，但不宣称空间无交叉；这不是完整高阶空间验收门禁。非有限/零体积线性角点几何单独阻止使用。
- 检查在已有材料验收线程内、同一个完整文件身份/摘要观察范围中完成；不增加在线主线程重扫描或新 API。仅为真正参与检查的线性单元按 1024 条固定块分配角点、包围盒、来源体和有限展示编号；不保留全部原始单元对象。不会按全网格声明数量预申请线性缓冲区，也不翻倍复制旧大数组；全高阶网格的线性索引计费为 0。BVH 和排序索引只按实际线性单元数量分配。新增块、已有块、保留 ID 与最终树的合计均先计费，超限保持旧记录但不能封存部分结果；流未完整消费也不能返回通过。
- 内存计费仍为 128 MiB，声明单元上限 2^21（先受内存预算限制），构建比较/树访问各 2^27 次、候选对 2^25、全部谓词 2^28、精确回退 2^21 次。`accountedBytes` 与 `peakAccountedBytes` 是本空间索引的打包/ID 引用和字符预算，不等于进程峰值；连接索引、坐标、全量精确 ID 集合、对象头及 V8/原生内存另计。索引封存幂等；预算失败后不能继续追加或返回部分认证。
- 任一容量/计算预算用尽返回 `MESH_ARTIFACT_LIMIT`，不返回部分通过、不标原始材料损坏、不删除材料。独立 Worker 的取消与超时仍适用；完全重叠的大量单元不允许无限二次比较。总体资源治理和真实工业样本验证仍保留。

分离轴的完备方向依据 [Geometric Tools 的凸多面体分离轴说明](https://www.geometrictools.com/Documentation/DynamicCollisionDetection.pdf)；近零符号必须使用可靠谓词的设计依据见 [Shewchuk 的鲁棒几何谓词说明](https://www.cs.cmu.edu/~quake/robust.html)。本项目的具体实现与预算仍以测试、源码和冻结候选验收为准。

### 分块显示的读取期限与取消边界（候选，2026-11-16）

`GET /api/mesh/jobs/:jobId/render?wireKey=...&chunk=...` 返回清单指定的一块 float64 小端线坐标。前端核对 `X-CAD-Mesh-Format`、`X-CAD-Mesh-Wire`、`X-CAD-Mesh-Chunk`、可选 Content-Length、实际字节数和块 SHA256 后，才创建显示局部原点及 Float32 GPU 属性。该接口不是重新剖分或几何写入；原有来源有效性、验收和完整性门禁不变。

- 默认最多 4 条活跃读取观察，每块最多 1 MiB，视口已有的 256 MiB 预算针对保留的 CPU Float32 属性，不包含整个浏览器/GPU/网络栈。默认隐藏不读取；共享 owner 仍复用一个 wire 缓冲区。超限/校验失败的块不创建几何。
- 每次发起读取的 15 秒预算覆盖等待 HTTP、读取响应流及异步 SHA256，不在不同阶段重置；不是整个网格任务的总预算。单个异步阶段不响应 AbortSignal，仍会退出本次观察。它依赖浏览器事件循环调度，不是后台节流或主线程冻结时的硬实时保证。
- 大量立即就绪的小片段也受 CPU 协作预算控制：空片段累计最多 4096，超过后失败，正片段不清空计数；每 8192 次读取，或至少 16 次且已经过 8ms，使用可取消任务让出输入/计时调度，而非只延续 Promise 微任务。每阶段返回和转换后都核对同一单调绝对截止，计时器回调未获调度也不能继续发布超期结果。有效非空片段并无 4096 次上限，正常单字节分片仍能通过精确校验；这不是整个浏览器或第三方网络栈的 CPU 硬限制。
- 隐藏、切换工程/任务、同批其他块失败及销毁会先撤销旧请求的发布资格，清除它的计时器并释放观察槽位，再尽力取消底层读取。迟到响应只取消 body，不能取得 reader 或接回解析/渲染流水线；旧请求 finally 也不能删除同键的新请求。每次 await 后继续核对取消状态，取消后的摘要不能生成几何。
- 流清理不再 await `cancel()`：不结束或同步抛错的清理不能延长期限、覆盖真实错误。已取得的 reader 同时尝试 releaseLock；不标准 reader 拒绝释放时不继续等待。正常消费完毕的响应直接释放 reader。HTTP 错误读取最多 8 KiB，显示的服务端说明最多 512 字符。
- 超时/错误沿用消息区，停止显示，不自动重试；用户显式改变显示意图后可以重试。关闭显示不是取消原生剖分任务，也不会删除 CAD、修改属性或中断活工程内核。对任意忽略取消的第三方网络实现，只保证本层不等待、不消费和不发布迟到结果，不宣称强制停止远端处理或限制其全部外部资源。

`MeshWireLayer` 负责期望分组、缓存及发布资格；`mesh-wire-read` 负责有界流读取、可取消观察和完整性校验。`tests/mesh-wire-deadline.test.mjs` 覆盖不响应取消的 fetch/read/hash、永不结束的清理、兄弟请求失败和显式重试；`tests/mesh-wire-stream-budget.test.mjs` 另覆盖空片段洪泛、4096 边界、有效单字节片段、任务取消和单调截止。真实 SHA256 仍由既有完整性测试执行。`scripts/verify-mesh-wire-deadline.mjs` 的 6 条专项在私有真实 CAD/Gmsh 工程中注入浏览器 fetch/ReadableStream 故障，检查实际提示、显隐和恢复像素；不冒充远端故障或百万单元性能认证。上述能力已随 2026-11-16 受控更新上线；当前版本、全量门禁及剩余范围见工业化路线。
