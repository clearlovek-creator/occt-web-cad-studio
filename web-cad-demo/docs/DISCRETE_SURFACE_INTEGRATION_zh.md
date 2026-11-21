# 离散表面重构开源集成

已按用户选择采用 CGAL 6.1.2 的 GPL-3.0-or-later 路线，完成正式原生进程、共享算法核心、CAD 表面来源绑定、持久表面任务和来源诊断界面。[体域分区组件](VOLUME_PARTITION_WORKER_zh.md)另已进入同一正式进程，尚未接入工程体域任务。独立候选后台已封存引擎及许可材料；重构结果可视化、体网格工程链路和完整开源分发材料尚未完成，日常版本没有更新。表面操作、任务接口和恢复规则见 [工程表面重构任务](DISCRETE_SURFACE_TASKS_zh.md)。

## 许可和分发边界

自动细分算法的官方头文件声明 `GPL-3.0-or-later OR LicenseRef-Commercial`，本组件选择前者，不购买商业授权。组件目录保存完整 GPL 文本，新算法核心带有相应标识。CGAL 按包采用不同许可，产品分发需要遵守实际采用代码的条款，不能把单独进程当作 GPL 豁免依据。[官方算法声明](https://raw.githubusercontent.com/CGAL/cgal/v6.1.2/Polygon_mesh_processing/include/CGAL/Polygon_mesh_processing/autorefinement.h)、[CGAL 许可说明](https://www.cgal.org/license.html)

本次没有公开发布、改变整个仓库的许可或授权外部服务。当前许可材料记录了 CGAL、Boost、实际 GMP、MPFR、GCC 运行库与 winpthreads 包版本和字节摘要，并捕获可取得的许可文本及包清单。GCC 静态运行库也纳入待核对范围，不只检查 DLL；其附加许可需按实际使用条件判断。[GCC 运行库许可](https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html)

公开分发资格仍为阻止状态。实际依赖的对应源码、MSYS2 构建配方及补丁、完整通知材料和组合产品的许可兼容性核对尚未齐备。保留源码网址或安装包元数据不等于已经提供完整对应源码。

## 正式进程与算法核心

`discrete-surface-worker` 提供独立可执行进程，原实验入口改为同一核心的兼容测试程序，避免两套算法各自演变。核心继续采用精确交叉拆分、全局点面去重、双精度迭代舍入和最终交叉检查。共面区域保留多个来源；顶点偏差、来源面积覆盖或来源引用不合格时拒绝结果。

进程先处理一次 `health.ping`，再处理一次 `surface.refine` 或 `volume.partition` 并退出，不在同一进程中连续执行两者。握手分别限定表面与体域能力、CGAL 版本、算法依据、许可选项、各自输入输出额度和 Windows 提交内存硬限制。下表为表面操作预算，体域预算见[正式体域分区组件](VOLUME_PARTITION_WORKER_zh.md)。重复握手、复用请求编号、未知请求字段、无握手执行或非法来源标识均拒绝。

| 项目 | 当前上限或默认值 |
| --- | --- |
| 输入三角面 | 20000 |
| 输出三角面 | 200000 |
| 点数 | 600000 |
| 来源引用 | 1000000 |
| 单行请求 | 8 MiB |
| 单行回复 | 64 MiB |
| 诊断输出总量 | 64 KiB |
| Windows 进程及作业提交内存 | 默认 2 GiB，可设 128 MiB 至 8 GiB，不能关闭 |
| 握手时限 | 默认 10 秒 |
| 算法请求时限 | 默认 120 秒 |
| 单次退出确认等待 | 默认 5 秒 |

这些是当前组件预算，不是工业规模通过认证，也不是所有后台进程合计的机器内存上限。

## 调用与结果接纳

`gateway/discrete-surface-client.mjs` 每次任务创建专属进程，不复用已执行过算法的进程。发出几何之前检查实际握手和内存保护；请求采用固定快照，不受后续对象改动影响。原生进程只继承必要的 Windows 环境与专属运行库路径，不继承大模型密钥或其他内核的 DLL 搜索路径。

收到结果后继续检查来源、点和三角面索引、覆盖清单、报告计数与几何容差，并等待同一实际进程正常退出。取消、超时、协议损坏或异常退出不会接纳迟到结果，也不会自动重发。退出未确认时保留占用，阻止下一任务；失败启动已经确认关闭时则报告不可用，不误报仍有活进程。

裸算法的 `sourceTriangleIds` 只追溯到输入三角面，`sources` 中的 Body、Face、Solid 是调用方离散标签。工程调用层现通过专用原生导出和独立 `projectBinding` 绑定实际 CAD 身份、几何摘要及完整清单，不改写裸算法报告。后者始终保留：

```json
{
  "volumeDomainReconstruction": "not-performed",
  "tetrahedralReady": false,
  "sourceIdentityAuthority": "caller-supplied-discrete-labels-not-cad-certificates"
}
```

没有交叉不代表存在封闭体域。该结果目前不能替代已验证的工程 BREP 清单，也不能直接进入现有共形四面体和正常网格显示流程。

## 构建和验证

构建固定 CGAL 6.1.2 和 Boost 1.88.0 源包摘要，并在编译前后核对项目源文件与实际依赖头文件。依赖头文件使用独立且有上限的清单，不放宽前端发布预算。运行库沿用现有 PE 静态和延迟导入检查，递归收集实际依赖，不从任意 PATH 猜测。

正式构建捕获 19671 份头文件及 5 个运行文件，其中包含间接导入的 GCC DLL。28 项算法回归和 19 项正式进程检查通过，工程来源另覆盖全部基础体和基础面。当前工程任务与发布运行库的最终版本和分层回归见 `.artifacts/discrete-task-result.json`，此前组件阶段的结果保留在 `.artifacts/discrete-integration-result.json`。

每次使用新输出目录，保留失败及既有证据：

```powershell
node scripts/prepare-discrete-dependencies.mjs
node scripts/build-discrete-surface-worker.mjs .artifacts/discrete-local-build
node scripts/verify-discrete-surface-worker.mjs .artifacts/discrete-local-protocol .artifacts/discrete-local-build
node scripts/verify-discrete-surface-research.mjs .artifacts/discrete-local-algorithm .artifacts/discrete-local-build/build/cad_discrete_surface_research.exe
node scripts/capture-discrete-license-inputs.mjs .artifacts/discrete-local-build .artifacts/discrete-local-licenses
```

后台原生清单第二版增加独立离散引擎及许可文件，旧版两套内核格式保持支持。实际任务通过同一进程正常退出和完整保存校验后才发布；没有替换默认 OCCT/Gmsh 程序、新增页面入口或更新日常服务。

## 后续接入顺序

1. 专用工程离散导出和 CAD 身份绑定已验证，后续任务应复用完整来源快照，继续明确区分构建参数、估计偏差与独立距离界认证。不可拿截断的显示三角面或任意调用方标签冒充工程来源。
2. 持久工程任务已复用排队、容量、取消、退出观察、保存和重启恢复，独立候选后台封存了完整运行库，候选界面可执行并读取分页来源报告。继续补齐重构表面的只读可视化、对应源码及分发材料；封存运行库不等于已取得公开分发资格。
3. 重建封闭区域、定向边界、共享界面和多材料体域。开放面、非流形或歧义归属应给出可定位诊断，不能填一个成功标志继续剖分。
4. 验证真实共形四面体、Body/Face 归属、质量准入、保存重开及故障恢复，再增加界面入口；默认网格隐藏和按 Body/Face 显示规则保持。

行业脏几何样本、规模和多进程总资源验证仍需独立完成。
