# 唯一下一任务 — P0-4.5 一次无推理有效配置核验（待Owner转交批准）

P0-4.4静态准备已独立PASS，见PROJECT_BASELINE.md §7.55。不重做配置，不宣称真实E2E READY；当前池仍过期，真实模型授权保持关闭。

## 目标与复用

仅核对原生最终采用的主/辅助模型、provider白名单、build Agent及权限来源。复用已有OPENCODE_CONFIG、原生debug config与owned containment，不改生产或新建执行入口。

Demo为D:/workbench-demo/p04-20261019T035918Z；cwd为workspace，显式配置为control/opencode-demo.json。模型保持opencode/space-bunny-free，不切换为开发委派的DeepSeek模型。

## 先排除副作用，再执行一次

复用§7.54/§7.55固定版本来源，不重复外检或试模型。debug/config.ts读取Config.Service.get后脱敏输出；加载器可能初始化插件依赖，不能预设完全只读。先核对适用配置/.opencode目录的非敏感字段与安装触发条件，以及已有contained入口。无法排除安装/升级、全局或祖先配置写入，或需要新脚本/放宽权限才能contain时，停止并报告，不回退裸进程。

满足边界且获Owner转交批准后，只允许一次原生debug config：cwd固定workspace，进程局部OPENCODE_CONFIG为专用绝对路径；30秒deadline，失败不重试，无prompt/session/模型请求。参数须按版本源码确认，不猜run --dir适用于debug。经既有ManagedProcess/Job启动并核对可信最终停止事实。仅留存白名单非敏感字段及必要脱敏证据，不打印或保存完整原始配置、环境、auth.json/API Key/密码。

## 交付与停止

返回实际命令/cwd/配置哈希、主/小模型、provider限定、Agent及permission有效字段与来源、实际退出码/耗时、treeStopConfirmed/ActiveProcessesFinal/cleanupFailures。未观察到的写unknown；副作用无法排除则BLOCKED且不执行。配置输出不证明认证/费用资格，也不覆盖所有执行路径中的权限行为。

不改Demo/workspace/pool/stage/plans、仓库源码/测试/全局配置；不运行stage-check、测试/typecheck、LAYA、Worker、Review或Round；不读取凭据、不安装、不增加费用、不滚动刷新池；不commit/push/reset/clean/stash。Git归档由Codex负责。

完成后READY FOR CODEX REVIEW或BLOCKED即停止。真实执行仍需Owner新的次数/费用/时限/数据授权，含单独接受机器批准测试120秒默认值。
