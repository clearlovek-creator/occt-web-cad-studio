# CAD 表面来源绑定

离散交叉重构使用当前 CAD 工程的专用表面导出，并将结果绑定到真实 Body、Face 和 Solid 来源。新内核命令、后台调用库、[持久工程表面任务及来源诊断界面](DISCRETE_SURFACE_TASKS_zh.md)已接入隔离候选；重构表面可视化和体域重建尚未完成，日常服务没有更新。

## 来源捕获

`mesh.discrete.export` 对完整工程导出，不接受缩小到某个 Body 或 Face。它在几何副本上重新离散，不复用显示三角面，不先做布尔分区或修复。原有 Gmsh BREP 与历史映射流程不改。

导出保存完整 Body 集合及持久 Body 和拓扑身份、各 Body 的拓扑修订、原始面的当前编号、局部 Solid 编号，以及不含三角化的规范化 BREP 几何摘要。编号只在这份来源内有意义，不承诺改参后仍指向同一个面或 Solid。

每个三角面携带来源标签。共享面可以属于多个 Solid，导出为多个有方向的原始面使用；自由 Sheet 不会被伪造一个 Solid。各面的使用方向和连续三角面范围另存入清单，重构结果通过 `sourceTriangleIds` 回到原始三角面，再关联这份经过核对的工程清单。

后台捕获复用现有工程操作队列。发出导出前核对实际进程的能力声明，导出后再读同一工程并核对修订、完整几何身份及进程身份；捕获期间变化就拒绝混合来源。重构计算不占用 CAD 队列。计算期间的几何修改不会覆盖原来源，结果的 `freshness` 和 `sourceCurrent` 会说明是否仍属于当前几何。

## 离散参数和误差

默认采用 0.05 mm 线性偏差、0.15 rad 角度偏差和 20000 个输入三角面的预算。每个面必须具有新网格记录的实际构建参数，且与请求策略一致。缺面、缺来源、自由线点、空 Solid、非法坐标或额度不足都明确失败，不返回截断结果。

OCCT 的后处理面偏差是估计值，不是构建参数，也不是严格最大距离界。实现分别保存实际参数、每面估计值、估计超出请求值的标志及总数。例如当前截锥体构造的 4 个侧面，在请求 0.05 mm 时记录 0.09375 mm 估计值；该信息保留为警告，不被改写成 0.05 mm，也不据此错误认定构建参数未生效。

表面来源和结果均明确保留 `distanceBoundCertified: false`。当前没有给任意曲面提供独立的全局距离界认证；CGAL 的支持面偏差检查针对输入离散三角面，不是针对原始 CAD 曲面。

## 结果的含义

`projectBinding` 保存 CAD 来源、精确输入摘要、完整清单摘要、原生进程身份和离散策略。裸算法报告仍声明自己只处理调用方离散标签；工程绑定放在外层，不能通过改一个报告字段把任意输入变成 CAD 来源证明。

成功表示来源完整、表面重构完成并确认算法进程正常退出。它不修改 CAD，也不构成封闭体或正常网格准入：

```json
{
  "sourceCurrent": true,
  "approximation": {"distanceBoundCertified": false},
  "normalMeshAdmitted": false,
  "appliedToCad": false,
  "tetrahedralReady": false
}
```

工程来源导出仍在受内存和时间限制的共享几何进程内执行，使用私有几何副本。它尚未成为独立导出子进程；发生原生资源退出时需沿用现有几何进程恢复，不能宣称该阶段已具备独立故障隔离。

## 验证和复现

新增 14 项应用测试覆盖来源策略、实际能力、完整清单、捕获期间变化、取消、过期结果、输入篡改和精度语义。新增原生测试覆盖多 Body、多 Solid、共享面的双重方向归属、Sheet、缓存隔离和只读保护。

实际 OCCT 与正式 CGAL 进程通过 7 组检查，全部 9 种基础体、5 种基础面均已实际进入重构 Worker。另核对交叠 Box 的真实拆分、不同离散参数、BREP 字节不变、额度拒绝、改参后过期判定和自相交 STEP；该 STEP 的 12 个输入三角面拆成 20 个，来源保持且不宣称已重建封闭体域。

完整 2120 项应用和 94 项 Python 回归、20 项原生测试、封存后台 8 项工程链路和 76 项页面兼容检查通过。准确候选、原始失败和日常保护核对见 `.artifacts/discrete-source-result.json`。

```powershell
node scripts/prepare-test-runtime.mjs --geometry-build .artifacts/source-local/geometry --mesh-build .artifacts/source-local/mesh
node scripts/run-unit-tests.mjs --native
$env:DISCRETE_SOURCE_ARTIFACTS='.artifacts/source-local-check'
node scripts/run-unit-tests.mjs --script scripts/verify-discrete-source.mjs
```

复现还需已有通过核对的 `.artifacts/discrete-worker-native-final` CGAL 运行包。该脚本不加载付费模型、不选择日常发布版，输出目录必须是新的隔离目录。

## 剩余工作

下一步将来源快照和重构结果接入现有持久修复任务，补齐容量、取消、重启恢复和正式运行库发布。随后重建定向封闭区域、共享界面和多材料体域，验证真正共形四面体、质量准入和保存重开后，再开放界面入口。严格曲面近似误差、行业脏模型、规模与总资源验证，以及开源分发的对应源码材料仍需完成。
