# 下一单点 — B4.5a 审核前运行期资源保护收口

更新日期：2026-10-14
当前B4.5在首次实现+唯一返工后独立BLOCKED；不是整体完成，未进入B3.1/B2/B5。
本轮停止，后续任务待用户下发。唯一状态和实际证据见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 不重做

组root拥有单隔离Git worktree、成员独立Task/Session/pair、集成消费真实字节、顺序写、脏文件HEAD/index/内容保护均已验证。
最终review改用组worktree、Git子目录写前明确拒绝亦已独立确认；原非Git/sequential/fixed/stage gate保持。

## 唯一目标

最后集成者的RunResult.cleanup.treeStopConfirmed=false后，既有ResourceClaim保留；
当前CLI只检查workspace.unconfirmedProtections（Git创建期），漏workspace.retainedResourceProtections（运行期）。
独立真实CLI/临时Git受控注入仍得到reviews=1、review completed/pass、ok=true、exit0。
这不是OS真实存活/逃逸证明，但已证明保护没有接到最终审核。

复用既有ResourceClaim/WorkspaceManager与当前withheld review分支，按实际物理workspaceId/scope匹配组内保留声明。
保留声明的taskId是成员/集成者，不一定是group root owner，不能只按owner taskId匹配。
保护未释放时不调用review、不报告成功；不同组不互相误阻断。不得新建manager、权威、冻结/恢复框架。

## 建议范围与验收

优先只改src/cli/round-cli.ts和tests/b45-git-collaboration.test.ts。
新回归必须经真实runRoundCli，最后集成者逻辑成功但stop-unconfirmed，真实保留Claim，reviews=0、无pass、ok=false、非零退出。
同时保留正常duo/trio成功、创建失败、nested拒绝、同组后续读写阻断与不同组隔离。
必要负控：删除运行期保护检查时，新回归真实非零失败；不修改工作树做负控。
运行typecheck、b45、b41、b43、b40a、resource-claim、unified-review、diff check，不跑full suite或产品真实模型。
每个owned临时目录清理失败影响suite退出码，不操作foreign/历史目录。

## 边界

OpenCode开发，Codex独立审核；实际worker仍opencode-go/deepseek-v4.1-flash。
此后续任务最多首次实现+一次有界返工，仍有实质问题则停止BLOCKED。
PARALLEL_WRITE=CLOSED，保持用户dirty树和共享暂存区；文档/进度页由Codex维护，project-progress/全目录不入Git。
用户产品前端需求尚未确认，不在此处开启。
