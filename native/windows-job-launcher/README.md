# Windows Job Launcher

更新日期：2026-10-12
状态：已有生产 Runtime containment 集成；阶段封板与授权只见唯一 [项目基线](../../docs/PROJECT_BASELINE.md)。
当前 W5 已 SEALED WITH P2，不沿用旧“未完成独立验收”描述。
本次更新是文档整理，没有重新运行 native 测试或更改 launcher。

## 作用与不变量

launcher 创建不可 breakaway 的 Job：
CreateProcessW(CREATE_SUSPENDED) → AssignProcessToJobObject → ResumeThread。
KILL_ON_JOB_CLOSE 开启，BREAKAWAY_OK/SILENT_BREAKAWAY_OK 关闭。
setup/assign 失败不 Resume target，走 fail-closed 清理。

root 自然退出后，只要 Job 仍有 descendant，launcher 就继续等待。
正常 success 要求 root termination 得到正面确认、退出码读取成功，
且 Job ActiveProcesses==0。launcherPid 与 target rootProcessPid 是不同事实。
取消/超时和保护释放还受生产运行时协议约束；不能只依靠 root PID 消失。

## 源码与构建

- src/w1joblauncher.c：Job、启动顺序、控制通道、停止和记账。
- src/winquote.h：Windows target argv 编码。
- src/w1fixture.c：受控 native 测试 fixture 与进程观测。
- build.ps1：使用已安装的 gcc/MSYS2 UCRT64 编译，输出 build/。
- ../../src/runtime/containment.ts：生产 launcher 解析、封装和 control 校验。
- ../../src/runtime/spawn.ts：生产 ManagedProcess 与停止/事实投影。

在仓库根目录构建：

    powershell -File native/windows-job-launcher/build.ps1

build/ 二进制为 Git 忽略内容，备份标签保留源码而非编译产物。
本机部署位置和覆盖变量以 containment.ts 为准；环境路径不能当通用 Windows 规律。

## argv 边界

    w1joblauncher.exe [--diag <control>] [--stop <marker>] [--log-argv] [--debug] -- <exe> [args...]

第一个独立 -- 前是 launcher 参数，之后所有 token 均为 opaque target argv。
target 的 --debug/--diag/--log-argv/-- 不得改变 launcher 状态。
生产使用受验证的 argv/raw 封装；--raw 是内部 Windows 命令行接口，
不是新的 shell 执行入口，不应手工拼接不可信参数。

默认 launcher 控制信息不写 Agent transport stdout/stderr；调试必须显式启用。
control 走 --diag，stop marker 走 --stop，stdin/stdout/stderr 属于目标传输。

## control 与 PID

control 是 UTF-16LE key=value 记录，只有 complete=1 且完整校验通过才接受最终事实。
生产包含 launcherStatus、phase、rootPid、assignedBeforeResume、resumed、
Job flags、rootExitObserved/rootExitCode、treeStopped、activeProcessesFinal 等事实；
准确字段和状态矩阵以生产 producer/consumer 源码为准，不复用旧版本矩阵。

rootExitObserved 与 rootExitCode 必须一致成对；INVALID/partial control 不得认证
rootTerminalObserved、rootExitCode 或 treeStopConfirmed。
运行中只允许从换行终止、严格十进制、正且安全整数的 rootPid 行读取早期 PID。
launcher 退出不能替代可信 control，更不能误作 target 成功或整树已停。

GetExitCodeProcess 的 259 只有在 process handle 非 signaled 时才表达 STILL_ACTIVE。
WaitForSingleObject==WAIT_OBJECT_0 后读到的 259 是合法实际 DWORD 退出码。
poll 和最终 reconciliation 都需要 termination evidence；
超时/失败或 exit unavailable 不能写 success。

launcher 自身 exit status 与 target rootExitCode 分开，
不能使用 target 的 103/259 等具体数值识别 launcher 错误。

## 停止与未确认状态

协作停止通过现有 stop marker/Job 停止和 accounting 确认。
hardkill 的物理清理与最终可信 control 是不同证据；
没有被验证的最终 control，不能仅因观察到死亡就伪造 treeStopConfirmed。
停止未确认时，生产保护按既有 retention/quarantine 处理，不提前放行下一写者。

## 定向测试与权限

    node tests/windows-job-launcher/containment.test.ts
    node tests/containment-production.test.ts
    node tests/execution-lifecycle.test.ts
    npm run test:w51-evidence

命令从仓库根目录执行，需满足对应 opt-in、Windows 和构建前提。
真实 Agent 测试另行授权；本次未运行上述测试。
多模型、异构工作流和协作组继续复用该生产 containment，不另建 launcher 或进程管理器。
模型流失联、root 终止与 tree stopped 是不同事实；后续掉线接力仍先要求可信停止/保护事实。
任何一次通过都不自动打开 PARALLEL_WRITE；不重开已关闭的 W5.1a 历史 finding。
历史 W0/W1 设计及增量报告见 [Git 备份](../../docs/STAGE_ANALYSIS.md#历史备份)。
