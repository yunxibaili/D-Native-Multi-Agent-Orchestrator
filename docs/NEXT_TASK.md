# 唯一下一任务 — P0-4.22 单次 packet 原生审核既有真实成果（待新授权）

当前P0-4.21有限离线PASS，唯一基线§7.84：OpenCode Go实现+一次定向返工，typecheck各一次0；Codex单文件一次216/0，5个owned Job final0。src/cli/index.ts的显式packet分支复用runReviewPacket→runUnifiedReview→既有runtime.review；原始review兼容，入口缺口已关闭。无产品原生Reviewer/Worker/LAYA/Round，本机/远端代码准备不等于真实Review成功。

## 唯一最小建议与先后顺序

Owner新批准后，只核对当前代码与已有真实Round的材料、产物身份及哈希，并在已有ignored取证目录准备显式ReviewPacket JSON，记录字段来源，不能从损坏stdout猜字段、补造批准测试或将历史未知变为pass。输入文件只是调用者提交的历史材料，CLI报告path/SHA256/roundId及NOT independently authenticated，不替代TaskStore/Attempt/真实测试权威。无法可靠映射时停止，不为此扩改生产代码或重跑Round。

随后仅一次受控codex/gpt-6.1-sol独立Reviewer，实际deadline90000ms，失败不重试、不换模型、不额外探针。使用现有生产命令：

`node src/cli/index.ts review codex --packet <来源已核对的绝对packet路径> --cwd <既有真实workspace> --config <固定Codex路径/模型的既有配置> --model gpt-6.1-sol --timeout 90000 --json --live-agent`

通过既有owned containment启动CLI，按字节保存原始输出与实际退出/Job控制，不读取凭据，不改全局配置。不能传prompt/extra/role/sandbox覆盖packet分支；唯一schema/-o/read-only/analytics与身份/退出/Job/final文件/清理由runUnifiedReview负责。运行只产生独立packet审核报告，不覆写旧Round结果、Human Gate或主latest round-result.json，不把独立Review通过倒写为历史完整E2E PASS。

## 待Owner确认的准确范围

仅1个codex/gpt-6.1-sol独立原生会话、90s、只读既有真实成果与必要证据、无重试/替换/接力；本轮Worker/LAYA/Round均0。须当前Codex订阅包含额度足额，主辅助无额外credits/API按量余额/自动充值/付费fallback，固定30分钟非滚动窗口。Go开发费用声明不覆盖Reviewer；P0-4.20旧未用调用不自动结转。当前不启动模型/服务、不新增测试、不追加生产开发。

按实际verdict、原生模型/身份、退出和Job停止事实裁定，只验证该独立Review，不替Owner Human Gate；缺少可信verdict或停止事实则BLOCKED/PARTIAL，不补救调用。

主HEAD/index/范围外dirty保留；阶段归档沿用仓库外隔离索引与独立codex分支、精确文件、远端SHA/manifest及清理核对，不合并main/强推，不上传project-progress/audit/凭据。正式前端/P0-2新功能/接力不启动。
