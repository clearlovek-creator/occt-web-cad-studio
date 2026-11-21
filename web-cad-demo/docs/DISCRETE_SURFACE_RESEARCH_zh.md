# 离散表面交叉拆分实验

原型已在受控小样本上实现交叉三角面的实际拆分，并保留输入三角面的多来源归属。用户已选择开源许可路线，算法现提升为正式 Worker 的共享核心，实验入口保留作兼容回归；工程 API、体域重建、界面和日常服务尚未接入。当前开发状态见 [离散表面重构开源集成](DISCRETE_SURFACE_INTEGRATION_zh.md)。交叉拆分不等于封闭体重建，输出始终标记 `tetrahedralReady: false`。

## 算法与来源归属

第一阶段使用精确构造完成交叉拆分，相同位置的点和三角面统一编号。完全重复或共面重叠的输出三角面合并来源集合，而不是只保留其中一个 Body。第二阶段转为双精度表示，使用迭代舍入消除可能由数值转换引入的交叉，再检查结果是否仍有相交。

算法回调将每个新三角面追溯到阶段输入，再复合到原始三角面编号。每个原始三角面都携带 `bodyId`、`faceId` 和可选的 `solidId`。这些是调用方提供的离散标签，不是 CAD 持久拓扑身份证明；当前实验尚未将标签绑定到工程 BREP 导出清单。

输出发布前，逐个检查新顶点是否仍在各自来源三角面的容差范围内，并核对每个非退化来源三角面的覆盖面积。超差、来源丢失、剩余交叉、舍入未收敛或资源额度不足都不返回成功网格。原始退化三角面可以移除，但必须在报告中列明。

所用算法为 [CGAL 6.1.2 三角面自动细分](https://doc.cgal.org/6.1.2/Polygon_mesh_processing/group__PMP__corefinement__grp.html)，来源追踪使用其[细分访问器](https://doc.cgal.org/6.1.2/Polygon_mesh_processing/classPMPAutorefinementVisitor.html)。自动细分头文件声明 `GPL-3.0-or-later OR LicenseRef-Commercial`，当前选择 GPL-3.0-or-later 路线；实际对应源码、通知和产品组合许可仍需核对，隔离验证不构成完整分发资格。[官方源码声明](https://raw.githubusercontent.com/CGAL/cgal/v6.1.2/Polygon_mesh_processing/include/CGAL/Polygon_mesh_processing/autorefinement.h)

## 已验证案例

最终原型回归为 28 项，全部通过。其中 13 项正常几何案例、14 项明确拒绝案例及 1 项重复运行一致性检查。测试不仅检查程序返回值，还独立核对来源覆盖面积、顶点支持面、全局三角面去重、共面区域的多来源，以及非共面交叉处的共用顶点和边。

| 案例 | 实际结果 |
| --- | --- |
| 两个交叉三角面 | 拆成 7 个三角面，交线使用同一组全局点编号，共用边总长 2 mm |
| 三平面交汇 | 拆成 26 个三角面，来源覆盖保持 |
| 两个共面部分重叠三角面 | 合并为 5 个全局三角面，2 mm² 重叠区域同时保留两个来源 |
| 反向重复三角面 | 合并为 1 个三角面，保留两个 Body 来源 |
| 两个交叠 Box 的表面 | 24 个输入三角面拆成 68 个，来源覆盖保持；没有重建体域 |
| 倾斜交叉面的大坐标严格容差 | 超过 1e-12 mm 容差时返回 `GEOMETRY_DRIFT`，不发布三角面结果 |

另覆盖干净面、分离面、共边、顶点接触、退化面移除、平移和小数坐标，以及缺失单位、来源不全、非法索引、坐标越界和错误选项。最终证据为 `.artifacts/discrete-surface-research-final/result.json`，每个案例的请求、标准输出和诊断输出都独立保留。

## 复现步骤

当前构建在 Windows x64、GCC 16.1.0、CMake 3.31 和 Ninja 环境验证。CGAL 6.1.2、Boost 1.88.0 源包先按官方 SHA256 检查，仅在 `.artifacts/discrete-dependencies` 解包；不安装系统包。GMP、MPFR 和 pthread 使用本机现有运行库，实际导入名及摘要记录在构建凭据中。Boost 适配器只提供真实版本的头文件，不提供或伪装任何编译库组件。

在项目根目录依次执行以下命令。每次验收使用新目录，以保留已有证据；脚本不购买授权、不选择发布版，也不连接日常工程。

```powershell
node scripts/prepare-discrete-dependencies.mjs
node scripts/build-discrete-surface-research.mjs .artifacts/discrete-build-local
node scripts/verify-discrete-surface-research.mjs .artifacts/discrete-check-local .artifacts/discrete-build-local/cad_discrete_surface_research.exe
```

最终构建凭据为 `.artifacts/discrete-surface-build-final/build.json`，实验程序 SHA256 为 `4c29e1ef209abe2b70c4f87b13e516a1b064643c6b11ff81659dfbd711d82098`。它记录项目输入、编译参数、官方源包、工具和直接导入运行库的字节摘要，不构成完整编译器、系统或许可依赖闭包认证。

研究额度为输入最多 20000 个三角面、输出最多 200000 个三角面、600000 个点、1000000 条来源引用及 8 MiB 单行请求。测试监督程序限定每次 30 秒并等待实际进程退出，原生程序使用 2 GiB Windows 提交内存额度。这些小样本不是工业规模、任意脏模型或全部失败路径认证。

## 正式集成前的剩余工作

算法许可路线已确定为 GPL-3.0-or-later，正式进程及其调用监督已建立。仍需将来源标签绑定到受验证的当前工程离散导出，将修复任务纳入现有持久任务、资源和发布事务边界，不能直接把实验程序放入默认 PATH。

表面拆分之后还需识别封闭区域、定向边界、共享界面和多材料体域；相交或非流形三角面集合不能直接当作 Gmsh 的封闭体输入。通过真实共形四面体、Body 与 Face 归属、质量准入和保存重开验证后，才可将结果接入现有网格显示流程。真实行业脏几何、规模与失败样本仍需另行验收。

首次构建的参数类型错误及依赖配置错误日志均保留。早期构建凭据曾因只保留诊断末段而遗漏 PE 导入表；最终工具改为有界保留完整检查输出，并在导入列表为空时拒绝认证。以 `discrete-surface-build-final` 和 `discrete-surface-research-final` 为最终凭据，不使用早期空运行库清单作为依赖证明。
