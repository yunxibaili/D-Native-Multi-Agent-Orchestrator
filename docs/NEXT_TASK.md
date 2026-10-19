# 唯一下一任务 — P0-4.6 一次真实Round（待Owner新授权，不自动执行）

P0-4.5有界无推理配置核验PASS，见PROJECT_BASELINE.md §7.59。配置中没有显式build不阻断内置primary；不改配置、不追加第三次诊断，不重审历史B阶段。当前真实调用授权仍关闭，旧池过期、旧digest失效。

## 执行前必须由Owner明确的最少信息

1. 新授权一次真实Round：Worker opencode/space-bunny-free最多2原生会话；Reviewer codex/gpt-6.1-sol最多1独立原生会话；真实LAYA POST最多3（--laya-post-max 3）。不得继承旧额度。
2. 以当前账户事实确认Worker零新增收费可用，Reviewer有足够订阅包含额度，不用额外credits/API按量余额/自动充值/收费fallback。原生辅助调用也须在该费用边界内；未经确认不能改时间戳刷新声明。
3. 接受每Worker/Reviewer实际deadline90秒、LAYA启动/请求各90秒、批准测试每条默认120秒；并发1、任务重试0、无接力/换模型；OpenCode 1.19.3原生同会话有限重试须明确允许且仍受deadline/费用限制。接受现有原生工具权限与协作式Demo范围，cwd/allowedScope/Job不是OS读取或网络沙箱；不放宽权限/自动批准。中间机器验证自动推进，最终Human Gate由Owner决定，自动后续NONE。

上面仅是待批准范围，不是已获批准。缺任何必要事实时，报告缺项并停止，不启动服务、推理、Agent或补救Round。

## 获批后的唯一执行

沿用D:/workbench-demo/p04-20261019T035918Z/control和空workspace。只做会变化的最小前置：核对文件哈希、费用声明有效期、原生配置及工具安装状态无变化；无安装/权限放宽。只发送Demo及必要执行证据，不发送编排器仓库、凭据和无关数据。

取得新的Owner费用声明后才更新池，记录原文/来源/有效期；运行一次无推理stage-check取得当前digest。OPENCODE_CONFIG进程局部指control/opencode-demo.json，保存哈希371821341868CAC8CA7B9E6D5902AAAD88313B7C2267D08A7CB57B2BCEC16599及环境引用；digest不覆盖该原生文件，不能仅凭digest假设它冻结。

复用已有LAYA owned contained固定离线缓存启停与round CLI，仅一次sequential、fixed、p04-demo、maxChildren3、maxConcurrent1、retryMax0、no-handoff、laya-post-max3；execution/laya/review-timeout90000，review-agent codex，确认新的digest后执行。无需再运行debug config或模型资格试调用。

目标仍为Worker创建根目录add.js，第二Worker独立创建/运行add.test.js，真实批准测试通过后Native Codex Review→Human Gate。两个任务使用既有完成契约，不预置/搬移产物，不手工完成任务，不改写LAYA wait。首任务失败/越界/费用异常/身份不符/预算耗尽即停，不重跑或追加模型。最终记录实际身份、Session/Attempt、POST、产物、真实退出码、Review verdict及Human Gate；不足则PARTIAL/BLOCKED。

无论成败执行既有owned stop及可信Job清理，不按PID/名称强杀，不影响桌面已有会话。不得改生产源码、原生安装或全局配置，不commit/push/merge/reset/clean/stash；归档由Codex审核后处理。完成或停止后立即交回Codex，不进入下一阶段。
