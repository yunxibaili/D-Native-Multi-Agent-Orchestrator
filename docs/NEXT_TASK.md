# 唯一下一任务 — P0-4.4 Demo原生固定配置（先等Gemini版本依据，待Owner转交）

当前P0-4.3本地调查已接受，真实准入BLOCKED，见PROJECT_BASELINE.md §7.53。npm包元数据1.19.3，不是本轮native --version实测；B47仅1.18.35接口证据不能扩大。

## 前置条件

先取得Owner转交的Gemini对应1.19.3官方源码/文档，明确：非Git项目配置搜索及合并/OPENCODE_CONFIG优先级、small_model与辅助调用、无TTY ask及默认agent语义。无法确认的仍写unknown，不开始改文件，不用最新主分支猜安装版。

当前未授权实施。以下是取得资料后拟批准的最小配置任务，Owner须明确转交批准后执行；本任务不包含模型或预检运行。

## 拟允许范围

仅D:/workbench-demo/p04-20261019T035918Z/control内新增一份专用OpenCode配置，更新README；如确有必要，仅将orchestrator.json中agents.opencode.role显式设build（复用现有cfg.role→req.role→--agent，不改生产）。不改其他Agent、模型pair、timeout、池、stage、plans或workspace。

主模型和small_model都固定opencode/space-bunny-free，provider限定及白名单只用已证实支持的最小字段，不加凭据、Go/收费fallback、plugins或权限放宽。不能把配置放在p04根就称加载问题已解决，因为该位置仍需要祖先发现。优先复用现有逐进程OPENCODE_CONFIG绝对路径接口，但必须依据版本资料说明它与祖先/全局配置的合并和覆盖，不能宣称是完全隔离profile。

## 仅静态交付

提供资料采纳/拒绝表、精确配置diff、配置哈希、拟设置的进程局部环境和最终argv（均不执行），说明主/辅助模型/Agent/permission哪些字段已确定，哪些仍未知。原生工具权限与OS沙箱分开，不发明新权限框架，不因追求强隔离扩大工程。

读取费用/资格声明只作历史来源，当前池已过期；不刷新、不再问同一声明、不生成digest。临近最终授权时再统一更新池和预检。

不运行debug config/版本/模型目录探针、stage-check、测试、typecheck、服务或模型。没有必要的配置改动就直接报告，不为完成任务制造文件。受阻一次就报告，不盲试不同配置。

完成后返回READY FOR CODEX REVIEW或BLOCKED并停止；不报告真实E2E READY。Git提交/推送仅由Codex负责。
