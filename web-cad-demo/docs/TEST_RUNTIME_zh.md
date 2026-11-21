# 测试内核版本与标准测试入口

## 解决的问题

保留旧默认构建是上线回退保护的一部分。测试不能因为没有设置环境变量，就悄悄调用它并将新源码和旧几何/网格程序混在一起。2026-11-16 的一轮完整测试曾因此出现 12 项失败，而成套新版运行正常；不能把每次手工设置路径当作长期保障。

标准 npm 测试入口现在使用独立、明确登记的测试内核对。此选择与生产 `.releases` / `.backend-releases` 的 selected 指针无关，不自动跟随线上版本、目录修改时间或“最新 exe”。

## 准备与运行

当前准备器针对已记录的 Windows/MinGW/CMake/OCCT/Gmsh 工具链，不自动安装外部依赖。

```powershell
npm run test:prepare
npm run test:runtime
npm run test:unit
npm run test:native
npm run test:services
```

默认准备目录为 `.artifacts/native-test-build/geometry` 和 `.artifacts/native-test-build/mesh`。准备过程实际调用两组原生配置/构建，明确开启 `BUILD_TESTING` / `MESH_NATIVE_TESTS`。失败保留日志且不替换旧测试选择，不运行/停止日常服务，不改 `.env`。

使用已有独立构建可显式指定：

```powershell
npm run test:prepare -- --geometry-build geometry-worker/build-loft-holes --mesh-build mesh-worker/build-artifacts
npm run test:unit -- tests/geometry-api.test.mjs tests/loft-holes-api.test.mjs
```

即使目录已有程序，也会实际执行配置/增量构建，不能仅凭文件存在登记“已编译”。源码构建前后清单不同则拒绝。两个目录必须分开、在工程工作区内；拒绝旧默认构建、源代码目录、用户工程/运行日志、生产发布、node_modules、保护配置目录以及目录链接。准备不会删除旧构建或在线版本。

## 登记与核对

`.artifacts/native-test-runtime/selected.json` 指向唯一命名的清单并记录其 SHA256。清单包含：

- 工作区、系统架构、精确 Node 版本和范围声明。
- 两个原生项目的 `CMakeLists.txt`、完整 `src` / `tests` 文件清单、字节数及 SHA256，当前为 91 个文件。目录/文件链接、硬链接、超限文件拒绝。
- 两组 CMakeCache、CTest 配置及构建目录中的全部 exe（包括 Worker、来源检查/目录锁/来源替换辅助程序和原生测试程序）。CMake 缓存必须属于正确项目、Release 配置且测试目标开启。
- CMake 配置的解析与摘要来自同一份经过身份/长度/时间前后检查的 Buffer，避免先解析旧配置、后给另一份配置做摘要。

运行前和整个测试命令结束后都重做核对。原生源码新增/修改、输出或配置改变、选择摘要不匹配、Node 变更都会拒绝；通过测试但输入期间变化也不能得到成功结果。`GEOMETRY_WORKER_PATH` / `MESH_WORKER_PATH` 若显式设置，必须与登记对一致，冲突时应确认意图后清除或重新准备，不自动覆盖用户选择。

测试子进程使用登记的两个 Worker 及同目录三个辅助程序。单元/接口子集、两组 CTest、服务和 UI 的标准 npm 入口均复用同一门禁。`test:native` 现在顺序执行 geometry 与 mesh 的 CTest，不再只测默认几何目录。完整单元/接口保持最多四个测试文件并行；服务/打包等重型验收应顺序运行。

显式设置 `CAD_TEST_BACKEND_RELEASE_ROOT` 或 Pi 传输伴随后台目录时，脚本入口还核对冻结后台的五个原生程序与登记对字节一致；不只比较两个 Worker。匹配失败在验证脚本启动前拒绝，不忽略冻结后台的版本选择、也不把它换成源码运行。冻结包内的 DLL 按原发布清单校验，但它们与外部测试 SDK/DLL 的逐字节等价不在本门禁范围。

原生 CTest 使用分离的 DLL 搜索顺序：geometry 采用 OCCT 运行目录，mesh 采用 `GMSH_BIN` 或已登记 CMakeCache 中 `GMSH_ROOT/bin`，再接 MinGW 运行目录；不能把几何 OCCT 路径统一前置。两组同名 DLL 可能并不兼容。独立路径顺序测试会验证两种配置；实际原生统计测试曾因旧 geometry-first 顺序出现 `0xc0000139`，失败日志保留，分离后才通过。

低层 `node --test ...` / 直接执行 verify 脚本仍可供诊断，但绕过登记门禁，结果必须说明实际输入，不能替代标准发布证据。测试选择不是生产发布动作；测试通过后如需上线，仍要构建和验收成套固定版本并安排获准更新。

## 范围限制

这是可信本地工作区中的构建与测试一致性机制，不是隔离恶意编译器/用户的认证系统。CMake 的成功依赖扫描是构建依据，未另行证明编译器输出的数学正确性。外部编译器、OCCT/Gmsh SDK、DLL、系统库没有在此测试清单中封存；发布用的独立原生 PE 闭包仍遵循 `BACKEND_RELEASE_zh.md`。

检查不是运行时 OS 写锁或持续扫描，不能证明恶意程序曾换入又恢复输入。源码扫描有限额且不处理任意外部 CMake 工程布局。跨操作系统、全新机器安装和完整供应链验证仍需单独工作。不会因为此登记通过就宣称任意工业 STEP、百万网格或全部 GPU 场景已验收。

## 证据

原生输入专项 11 项，覆盖正常对、修改/新增源码、修改输出、缺辅助程序、错误 CMake 项目/关闭测试目标、路径冲突、保护目录、链接、选择摘要、配置读取竞态及冻结角色匹配；另有两项真实 CTest 路径顺序测试。后台启动生命周期由本机五条独立进程路径和 27 项真实服务验收覆盖，详见 `RUNTIME_SHUTDOWN_zh.md`。

本批日志前缀为 `.artifacts/runtime-governance-*`；准备记录和测试清单在 `.artifacts/native-test-runtime`。原生编译失败与受限环境中目录链接创建被拒的最初日志保留，不把环境准备失败当成产品行为反例。

最终标准入口完整 1174 项通过、无跳过；原生 12 + 1 项、实际服务 27 项通过，类型及修改文件检查通过。真实 CLI 的缺失选择、旧 Worker override 和不匹配冻结后台三个反例均在测试执行前拒绝。`runtime-governance-result.json` 记录输入/证据摘要与在线工程、上下文和服务未变的最后核对。本轮没有切换日常产品发布或重启健康服务。
