# 唯一下一任务 — P0-4.19 P02集成假Reviewer契约迁移（待Owner授权）

P0-4.18有限离线PASS，见唯一基线§7.79。既有unified-review单文件最终185/0，两个contained Job final0；首次183/1与Owner批准补验保留。typecheck首次2，补两项假清理元数据后0；之后未再次运行suite。生产未改，真实模型/Round未运行，真实Review/E2E保持PARTIAL。

## 唯一最小建议

仅迁移tests/p02-auto-advance.test.ts的假Codex：补extraArgs/sandbox能力，按本次--output-last-message写入已有VERDICT，保留真实RuntimeOrch.review/RunResult身份及FakeTransport生命周期。保留原A–I测试、批准测试与授权撤销断言，不删/skip、不放宽生产门禁、不修改生产代码或Runner。

静态依据：CAPS未声明extraArgs/sandbox，review回调只转发runtime.review(req)，VERDICT只由frame输出，不产生-o文件。本片未运行该文件，不预报失败数量；185/0不是P02集成验收。

获Owner明确测试与实施者授权后，仅通过白名单Runner+offline bootstrap+外层Windows Job运行此单文件一次，保存原始流、suite/root退出码与final0。不direct node回退、不运行其他suite/全量，不调用真实Agent/LAYA/Review/Round。上一片Codex实施者例外和补验次数不自动延续；开发模型需有效费用事实，不绕过审批拒绝。

当前只提出建议，不自动实施。实际90s Reviewer退出与合法verdict仍待证明，旧Round/Human Gate、9/26历史项保持。真实调用以后另需当前模型/会话/费用/时限/数据授权，旧窗口不补用。不开展新功能、前端或真实E2E。

主HEAD/index及范围外dirty保持；阶段归档仅独立codex审核分支精确文件，忽略目录证据不上传，不合并main。
归档前置：本片独立索引提交/推送命令被自动审批整体拒绝（blocked by policy），未启动、未建提交/临时资源；不得称已推送。已有归档授权不等于工具审批通过，下轮先处理该阻塞，不改入口绕过。

§7.80：Owner已明确批准P0-4.18原三文件归档重试一次；具体拒绝理由仍UNKNOWN，不改安全配置、不绕过。远端SHA实际验证前不得记成功。无新测试/开发模型授权。

本轮重试结果：Owner批准的那一次精确归档重试再次被命令执行策略在创建进程前拒绝（仅blocked by policy，无具体理由）；已停止，未建提交/临时资源、未push。先处理执行环境拒绝信息，不改策略或换入口规避。P0-4.19仍待独立测试/实施者授权。

§7.81新定位：原清理if片段被固定版Windows危险命令启发式把枚举-Force与普通删除合并识别。Owner授权继续调查并推送；改为无删除的归档事务及独立owned普通清理，不改安全配置。成功与否以远端SHA及archive-source-fix.json为准。
