# 唯一下一任务 — P0-4.23 一次全新最小Round整链验收（待Owner人工裁定与新授权）

P0-4.22真实Reviewer-only PASS，唯一基线§7.85：已有真实产物经指定gpt-6.1-sol独立原生Session审核，68417ms、succeeded/exit0/signalnull、严格合法verdict=pass、2个owned Job final0。本轮Worker/LAYA/新Round/测试均0。旧round-mvgba79g仍PARTIAL/Human Gate waiting_for_user；当前独立报告不倒写旧Round、也不替Owner作最终接受。

## 唯一最小下一步

Owner先人工裁定现有add.js/add.test.js及本次独立Review；若要验证现有产品能在同一Round完成全链，只另行授权一次全新隔离Demo的最小串行Round，不再开发新设施、不追加独立探针。继续复用现有Round CLI/owned LAYA/TaskStore/Attempt/机器完成门禁/runUnifiedReview/Human Gate，禁止用本次历史packet审核冒充新Round成功。

待批准范围：Worker固定opencode-go/deepseek-v4.1-flash、最多2个原生会话；Reviewer固定codex/gpt-6.1-sol、最多1个独立原生会话；LAYA真实POST总计≤3（--laya-post-max 3）；Worker/Reviewer/单次LAYA请求/服务启动各90000ms，现有批准测试每条默认120000ms须Owner明确接受；并发1、编排器重试0、无handoff/换模型/付费fallback，同会话OpenCode既有有界重试仅按Owner明确准许；自动后续动作none。

任务仍为根目录add.js CommonJS add(a,b)，然后独立任务创建add.test.js并验证。新Demo只含必要原生项目配置和空缺的目标文件；主/small_model/provider白名单在实际项目层固定Go，不能被祖先Free配置覆盖，不改父/全局配置或生产源码。产物/allowedScope/可信批准命令均由原有门禁验收，初始批准和最终Human Gate由Owner操作，中间机器条件满足才自动流转。失败/费用不明/身份异常即停，不补救Round。

## 准入与证据

需新的明确调用/数据/时限授权和当时Go订阅足额、Use balance关闭、Codex订阅包含额度足额，主辅助均无额外credits/API按量余额/自动充值/收费fallback，固定30分钟非滚动费用窗口。今日只覆盖一个Reviewer的声明不授权新Worker/新Round，旧窗口/未用额度不结转。当前不创建新Demo、不stage-check、不启动任何模型/服务。

获批后仅做可能变化的最小核对：当前原生配置/身份/费用及固定缓存/owned入口、已有材料与完成契约；刷新真实Owner pool声明，单次无推理stage-check取得新digest后执行唯一Round。依托既有证据入口，以字节保存CLI报告、按roundId保留正式RoundResult及哈希、记录实际测试/原生verdict/Job清理；不污染旧Demo/旧Human Gate。不能可靠完成即报告PARTIAL/BLOCKED，不自动开发或换模型。

最终只裁定新Round是否实际满足完整闭环与Human Gate，不把已有离线216/0或本次独立历史审核pass算作新Round证据。现有本地实现与已核对固定来源足够，暂不需Gemini检索；没有授权P0-2新功能、正式前端或接力开发。

保留主HEAD/index/范围外dirty；阶段精确归档至独立codex分支，仓库外隔离索引，核对远端SHA/manifest并清理自有临时资源，不合并main/强推、不上传本机project-progress/audit/凭据。
