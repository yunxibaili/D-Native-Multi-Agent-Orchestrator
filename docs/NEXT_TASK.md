# 唯一下一任务 — P0-4.5 定向返工：仅补Demo配置$schema（待Owner转交批准）

P0-4.5执行前BLOCKED，原生配置核验未发生，见PROJECT_BASELINE.md §7.56。缺少$schema时原生加载器会尝试回写，违反上一片配置不变要求。本轮不重建配置，不新开产品阶段。

## 拟允许的唯一修改

D:/workbench-demo/p04-20261019T035918Z/control/opencode-demo.json：仅新增顶层$schema=https://opencode.ai/config.json，保留model/small_model/enabled_providers/provider四项原值、编码和其余文本。

同目录README.md：仅补该元数据修订原因、新哈希、实际核验尚未执行的说明。补字段只关闭本文件缺schema回写分支；不能声称加载完全无副作用或真实准入READY。

## 静态交付

读取§7.56及已有v1.19.3来源，使用既有loadConfig行为，不重复试模型。提供单字段diff、JSON解析结果、新SHA256、README差异、其余Demo文件哈希及workspace仍空的事实。不新增验证脚本，不编写node -e/python -c，不运行任何CLI探针、测试或typecheck。

停止于READY FOR CODEX REVIEW；不附带重跑debug config。wellknown/活动账户远端配置、工具数据写入、依赖状态及受控deadline/可信停止证据仍未验证，不能隐藏为PASS。后续应合并剩余执行边界的明确授权后再核验，避免反复刷新池/预检。

禁止改orchestrator、pool、plans、stage、workspace、生产/测试/全局/父目录配置、凭据和外部安装；禁止LAYA、Worker、Native Review或Round；禁止安装/网络探测/付费、commit/push/reset/clean/stash。Git归档仍由Codex负责。
