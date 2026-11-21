# 后台安全停机与恢复

适用范围：本机 Windows 受管 Gateway、OCCT、Gmsh 和 Pi RPC。它是运行可靠性协议，不是多机调度器，也不保证外部脚本强制结束进程后仍完成所有操作。

## 正常操作

使用 `npm run services:stop` 停止服务，`npm run services:start` 重新启动。只操作已登记且进程身份核对一致的服务；不要按端口批量结束进程，不要手动删除所有权标记或事务日志。

受管前后端默认使用已校验的发布目录；首次启动前运行 `npm run build:release` 和 `npm run build:backend`，后者默认 V3 包含分离的 OCCT/Gmsh 原生 PE 依赖闭包与固定 Pi SDK 源码/已安装运行依赖。开发模式需显式 `npm run services:dev`，其前后端均读取工作区源码。构建不会更新运行中的版本，切换前端或后台的版本/模式前，分别用 `-Action Stop -Service Frontend` / `Gateway` 显式停止；`-FrontendReleaseId` / `-GatewayReleaseId` 可指定已有版本回退。旧源码 Gateway 显示 `WorkspaceSource`，不能不经停机就被当作生产快照；旧 V1 只有项目代码，V2 的 Pi SDK 仍在外部。动态插件/资源、Node/系统运行库、用户扩展和前端工作区运行器尚未完全打包；完整流程及范围见 README“启动”和[后台代码、原生运行库与 Pi SDK 版本固定](BACKEND_RELEASE_zh.md)。

Windows 启动器会核对 PID、进程创建时间、可执行文件与脚本路径，再通过本机私有控制通道请求 Gateway 收尾。旧版本没有该通道时，仍会按身份核对后的受管进程树停止；前端目前也采用进程树停止，不宣称有 Gateway 同等的事务收尾机制。

默认隐藏后台启动使用 Windows `STARTUPINFOEX` 的句柄继承白名单，仅传入输入空设备和两个日志文件。原先仅重定向 stdio 的 Node 启动方式仍会继承调用链中的其他可继承句柄，出现“管理进程已退出、输出管道却被长期后台占住”的现象；不能靠强行关闭观察管道或结束健康服务解决。现在使用受控 PowerShell 5 辅助进程调用 Win32 API，参数由 UTF-8 JSON 作为数据传递、Windows argv 规则单独引用；不通过拼接 PowerShell 命令执行目标参数。后台独立于管理命令存活，服务身份/就绪判定仍由原受管入口负责。

该辅助程序在本机 .NET 中编译固定 P/Invoke 类型，不新增常驻管理服务。需要允许 PowerShell `Add-Type` 与对应 Win32 API；企业策略禁止时会明确启动失败，不回退到不安全的继承方式。失败只输出阶段/错误类型等脱敏代码，不打印环境或请求正文。`-Visible` 是显式 opt-in，仍保留新控制台路径；当前自动实测覆盖默认隐藏路径，未擅自为用户打开可见窗口。它不保证外部进程管理器强制结束整个 Job 时后台仍存活。

## 状态与顺序

1. **停止接收**：新的请求返回 `SERVICE_STOPPING`。已接收但尚未上传完整的请求，上传结束后也不能启动新的操作。
2. **取消排队**：未开始的工程操作立即返回 503，不等待队首结束，不执行其几何命令。
3. **收尾在途事务**：已开始的工程操作获得有界收尾时间。成功完成的事务继续持久提交并返回结果；这是完成已有操作，不是重试或自动执行新请求。
4. **停止附属任务**：Pi 事件流关闭，当前会话停止；工程网格进入“正在停止”，等待准备工作或所属 Gmsh 进程真实退出。不会因发送了 kill 请求就提前标为已取消/已中断。
5. **核验进程退出**：停止所属 OCCT、Gmsh、Pi 进程并等待真实退出。旧代进程的退出屏障仍保留；永久关闭后，迟到重连不能重新启动旧会话或 Worker。
6. **退出 Gateway**：写入停机结果，移除属于自身实例的私有控制记录，再退出。数据目录的原生所有权句柄由实际 Gateway 的操作系统进程退出释放，不能提前解锁让第二个写入者接管。

几何收尾超过时限时，禁止为回滚启动一个新的 OCCT 进程。已经落盘的未完成事务日志保留，下次启动按事务协议恢复到完整的提交前或已提交状态，不自动重放用户命令。客户端如果没收到最终结果，应在恢复后查询工程，不能推断为“未执行”。

服务停机正常，不代表每个网格或 Agent 任务成功：被停机打断的任务仍是“已中断”。正常停机表示所属资源已核验收尾；超时、退出未确认或必要记录失败会作为中断退出，不能报告正常完成。

## 时间配置

`.env.example` 提供：

| 设置 | 默认 | 限制与含义 |
| --- | --- | --- |
| `GEOMETRY_SHUTDOWN_GRACE_MS` | 10000 | 已开始的工程队列收尾窗口，最多 30000 ms |
| `GEOMETRY_SHUTDOWN_STOP_MS` | 5000 | OCCT 进程退出观察窗口，最多 10000 ms |

Gateway 总预算为上述两项加 2000 ms。Pi/Gmsh 同时使用各自的退出观察与取消协议。Gateway 定时器不是操作系统级抢占：若主线程/文件系统长时间卡住，独立启动器在所公布预算加观察余量后会再次核对进程身份，再强制停止受管进程树。

增加等待时间不能替代修复挂起的 Worker。业务操作本身的超时、网格取消与停机预算是不同约束。

## 诊断与恢复

- 优先运行 `npm run diagnostics:export` 获取只读脱敏报告；它只查询固定本机健康端点并核对默认安装文件，不读取控制文件、原始日志或 `.env`，不会停止、重启服务或重发请求。服务不可达时仍可导出诊断状态，完全离线可加 `-- --offline`。报告生成成功不代表服务健康；未知或缺失状态不能当作操作未执行。完整边界见 README“脱敏诊断导出”。
- `runtime-logs/services/` 保存受管服务日志。`cad.shutdown` 事件记录 draining、超时、退出未确认及 complete/interrupted，不含控制凭据。
- 数据目录根的 `.gateway-last-shutdown.json` 是本次实例的停机诊断，包含原因和未完成计数；不是工程检查点，也不替代检查具体操作结果。
- 启动器状态中的 `LastStopMode` 可为 `graceful`、`interrupted`、`cooperative-exit` 或 `forced`。`cooperative-exit` 表示已观察退出但没有匹配的完整停机报告，不能等同于已证实正常收尾。
- 前端生产健康另核对发布 ID、进程归属及资源状态。已就绪进程失去页面/资源可用性时状态为 `unhealthy`，不会自动重启或转为开发服务。前端停止仍可能切断尚在返回的上传/命令/SSE 响应，后台任务是否执行须查询工程/任务状态；不能将断线当作“没有执行”。
- 启动失败或事务恢复失败时保留原始证据。不要删除日志“修好启动”；应先备份工程数据，并根据工程加载错误定位损坏记录。
- 重新连接 Pi 会恢复原生历史并只读核对当前工程，不自动重发上一条提示或工具调用。历史未完成的旧 Agent 记录显示为已中断，不自动继续。

私有 `.gateway-control.json` 含本机控制凭据，只允许持有当前实例令牌、没有浏览器 Origin 且来自回环地址的请求。该路由不进入 CAD/MCP 工具目录；健康响应、普通日志和诊断包不得携带令牌。Windows 文件权限继承数据目录 ACL，不能据此声称可防御同一用户下的恶意本地程序；不要分享控制文件。

## 可重复验证

- `node --test tests/gateway-shutdown.test.mjs`：真实 OCCT/Gmsh，覆盖空闲 Pi SSE、私有通道鉴权、已执行的在途提交、排队取消、未完成上传、超时日志恢复及收尾期间目录独占。
- `node --test tests/pi-rpc-runtime.test.mjs tests/child-exit.test.mjs tests/mesh-worker-client.test.mjs tests/mesh-job-lifecycle.test.mjs tests/agent-run-store.test.mjs`：重复停止、退出屏障、删除/重连并发、准备阶段取消、旧账本只读恢复。
- `npm run test:services`：真实 Windows 受管启动/正常停止/重启、双写保护、端口冲突和伪造进程身份拒绝。
- `npm run test:unit -- tests/background-launcher.test.mjs`：短生命周期独立样例，要求启动命令退出、调用方管道自然关闭后后台仍活着；覆盖直接 Node、Windows PowerShell 5 直接/嵌套，以及本机安装了 PowerShell 7 时的两条对应路径。中文目录、空参数、空格、引号、尾反斜杠和 Unicode 参数均核对。样例自行退出，不按 PID 文件终止进程、不控制日常服务；服务验收也不再强行销毁管道来隐藏继承问题。
- `npm run test:ui:pi-recovery`：真实浏览器及 SSE，Pi 为确定性 RPC 夹具，不调用付费模型。

停机夹具可以在真实内核已经执行后暂停回复交付，或延后对真实 Gmsh 发出终止请求，以重复验证竞态。这些测试不是自然长耗时模型的性能基准；复杂 STEP、大网格及磁盘/系统级故障仍需要专门负载验证。

继承机制依据本机 Node 对应的 [libuv 1.51 Windows CreateProcess 实现](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c) 与 Microsoft 的 [PROC_THREAD_ATTRIBUTE_HANDLE_LIST](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。具体可用性以当前真实进程测试为准，不将 `detached` 或设置日志路径本身当作所有句柄均隔离的证明。
