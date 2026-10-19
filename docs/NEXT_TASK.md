# 唯一下一任务 — P0-4.5 一次有效配置核验（新增非推理边界待Owner转交批准）

缺schema返工已独立PASS，见PROJECT_BASELINE.md §7.57；不重做配置，不追加元数据，不刷新过期池。P0-4.5运行核验尚未发生，真实E2E未授权。

## 拟一次性批准的边界（当前未批准执行）

只运行一次现有OpenCode debug config，无prompt/Session/模型请求；30秒硬deadline，失败不重试。允许原生工具正常产生自身db/log/cache必要状态，并按已有登录态读取现有配置元数据；这些不等于开发者可以手工读取auth.json/API Key/token/密码，不得打印或保存秘密或完整配置。禁止安装/升级、修改全局/父目录/显式配置、仓库及Demo任务产物；不执行模型探测、stage-check、LAYA或Review。

此边界须Owner明确转交批准后才生效；本文件不是执行授权。不把静态准备PASS当费用/账户或真实模型批准。

## 执行前及单次核验

读取§7.54–7.57来源与已有Job/进程入口，复用已有能力，不建脚本/执行框架。先确认当前安装依赖状态不会触发reify，各适用path配置都有schema，并明确30秒stop触发、最终control严格验证及清理方式。只展示无凭据字段/路径/哈希；无法满足则在启动前BLOCKED，不裸跑，不放宽权限。不能只凭launcher退出0认证树停止。

cwd固定D:/workbench-demo/p04-20261019T035918Z/workspace；OPENCODE_CONFIG仅进程局部指向control/opencode-demo.json。启动前校验新哈希371821341868CAC8CA7B9E6D5902AAAD88313B7C2267D08A7CB57B2BCEC16599。原生debug config参数按v1.19.3已有源码确认，不猜run参数通用。只持久化model、small_model、provider限定/白名单、build Agent及permission的非敏感有效字段；原始输出只在内存做字段白名单筛选，不能先落盘完整配置再脱敏。

交付实际命令/cwd/配置哈希、单次退出码/耗时、必要有效字段及来源、validated control停止事实与cleanupFailures、允许状态写入的观察结果及仍未知项。元数据中若出现未批准模型/provider/权限冲突立即停止，不改配置再试。未启动则所有运行/Job结果写不适用，不能写ActiveProcessesFinal=0冒充实际清理证据。

## 停止

不改源码/测试/Demo配置，不跑测试/typecheck，不创建任务或模型会话，不联网试模型、不滚动刷新池，不commit/push/reset/clean/stash。Git由Codex负责。完成返回READY FOR CODEX REVIEW或BLOCKED并停止，不继续真实Round。
