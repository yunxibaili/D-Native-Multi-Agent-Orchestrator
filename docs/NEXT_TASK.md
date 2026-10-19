# 唯一下一任务 — P0-4.5 最多一次非推理补观测（待Owner新增授权）

见PROJECT_BASELINE.md §7.58。已有原生debug config实际执行一次，目标exit0且control支持Job已停；有效配置stdout随观察宿主崩溃丢失。原单次额度已消耗，剩余0，不能自动重跑。本提示词仅在Owner批准转交后生效。

## 最小调整与来源

不改产品、配置或新建脚本/执行框架，只修原观察命令。复用§7.58微软官方.NET流与等待契约：禁止OutputDataReceived/ErrorDataReceived的PowerShell scriptblock回调及BeginOutputReadLine；同时启动stdout/stderr的ReadToEndAsync Task，均在原runspace等待/解析，避免双管道阻塞。不得无界等待Task结果。

30秒共用一个从启动开始的观察截止：进程等待和两路读取都只能使用剩余时间，不能先WaitForExit(30000)再另等30秒。到期沿用已审核owned stop marker/Job的有界清理，不改变原生执行deadline、不使用裸PID/名称强杀；进程已退出但读流未完成也算证据失败。

## 待批准的一次性范围

最多新增1次同一debug config，失败不重试，无prompt/session/模型；沿用原生自身db/log/cache必要状态及已有配置元数据读取边界，不手工读凭据、不安装/升级/改全局或父目录。新建独立owned control/stop路径，不覆盖上次证据。启动前复核配置哈希371821341868CAC8CA7B9E6D5902AAAD88313B7C2267D08A7CB57B2BCEC16599与当前无安装条件；cwd仍为原workspace，OPENCODE_CONFIG为control/opencode-demo.json。

原始stdout/stderr仅在内存处理；只落盘批准的非敏感模型/provider/Agent/permission字段、命令、哈希与Job事实。解析错误只输出类型/阶段，不打印原始JSON或完整异常。区分launcher退出与target root退出、精确耗时与估计值；校验control才能声称树停止。若原命令不存在或无法满足边界，启动前BLOCKED，不另造工具。

不编写/运行测试、typecheck、node -e/python -c，不改仓库源码/测试/Demo配置/workspace/pool/stage/plans；不运行stage-check/LAYA/Worker/Review/Round，不刷新池，不commit/push/reset/clean/stash。完成返回READY FOR CODEX REVIEW或BLOCKED后立即停止，不追加第三次诊断。真实E2E仍需单独授权。
