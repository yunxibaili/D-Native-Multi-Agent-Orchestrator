# LAYA DecisionProvider 接口

更新日期：2026-10-15
状态：当前源码参考。旧版本的本机测量和历史调研已归档，不作为本轮运行验证。
当前阶段与授权只见唯一 [项目基线](PROJECT_BASELINE.md)；已实现范围与真实验收边界分开，本文不自行裁定阶段。

## 1. 角色

LAYA 是结构化任务级决策模型。它不仅用于分类，当前已有 Agent × Model 选择、
任务级决策、工作流计划和 READ topology 等调用预设。B3.1/B3.2已有用户声明Skill/MCP候选的任务级advisory选择与有来源事件观察；真实加载/调用及限制强制仍未验收。
底层 provider 只回答问题，不启动 Agent、不选择 native thread、不直接执行工具。

DecisionRequest → DecisionProvider → 本地 laya-serve → 校验后的 DecisionResponse。

## 2. 接口与预设

| 源码 | 职责 |
|---|---|
| ../src/decision/types.ts | DecisionRequest/Response/Provider 和 typed questions |
| ../src/decision/laya.ts | 本地 HTTP、输入/输出校验、metadata |
| ../src/decision/routing.ts | 任务类型/复杂度等分类 |
| ../src/decision/initial-assignment.ts | 从给定 Agent × Model 候选中选择 |
| ../src/decision/execution-topology.ts | SOLO/PARALLEL_READ 预设 |
| ../src/decision/plan-choice.ts | 从已校验的有界计划选择 |
| ../src/decision/skill-choice.ts / mcp-choice.ts | 从用户声明且匹配Agent的工具候选选择；不认证真实执行 |
| ../src/decision/errors.ts | 输入、schema、timeout、transport、unavailable 错误 |

调用方声明答案空间，返回值必须属于该空间。不能编造模型/候选。
只有唯一候选时应由明确的既有规则处理，不能伪造一次有意义的 LAYA 选择。

## 3. 本地服务

默认地址 http://127.0.0.1:8077。provider 不自动启动 Python/CUDA 服务，
没有隐式云端 fallback。非 loopback 地址需要显式 allowRemote 授权。

本机既有环境为 `C:/Users/Admin/laya-venv`，LAYA0.3.21/Torch2.11.0+cu128。已按用户授权将英语与多语言固定权重恢复至 `D:/AI/laya-cache`，无重装或升级。本轮真实离线预加载与现有provider健康检查通过；检查后服务已停止，不是常驻配置。

已验证的进程级配置如下；在单独PowerShell终端使用，不写用户/系统环境或Agent配置：

```powershell
$env:HF_HOME = 'D:\AI\laya-cache'
$env:HF_HUB_CACHE = 'D:\AI\laya-cache\hub'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_TOKEN = ''
$env:HF_TOKEN_PATH = 'D:\AI\laya-cache\absent-token'
$env:LAYA_HOST = '127.0.0.1'
$env:LAYA_PORT = '8077'
$env:LAYA_PRELOAD = '1'
$env:LAYA_MODELS = 'english,multilingual'
$env:LAYA_THREADS = '2'
$env:LAYA_REVISION = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851'
& 'C:\Users\Admin\laya-venv\Scripts\python.exe' -I -B -m laya.serve
```

这段启动方式复用现有原生入口；本轮实际运维检查另经生产contained ManagedProcess执行并确认Job空。上游/本机裸服务默认8000且host为0.0.0.0，因此显式loopback/8077配置不能省略。只缓存english/multilingual，不能裸用默认全部checkpoint预加载；typed-decisions未下载。按已有启动配置预加载会占用本机GPU/内存，不等于发起推理。

健康检查：

    node src/decision/check.ts --probe

`--probe`仅GET /health。2026-10-15实跑返回loaded=[english,multilingual]、两个actual device均cuda、device_is_preference=false、revision均匹配；health warnings=[]。服务停止后再次连接失败是预期，不表示缓存丢失。未发送POST /v1/systemone，不声称预测质量/路由选择/全工作流已验收。无`--probe`的check命令或round会请求真实LAYA决策，须另有本轮授权；round还会先运行quota probes，不能当无外部调用健康检查。

固定权重清单来自[官方55cf4c4e版本](https://huggingface.co/convaiinnovations/laya/tree/55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851)：10文件共1,524,397,210 bytes，下载后及离线加载后均核对官方LFS SHA256/Git blob匹配。只用未认证公共下载，未读取现有token；缓存不入Git。加载器对部分choice temperature给出钳制与confidence未经校准警告，即使health warnings=[]也不能忽略。保留P2，不为此擅自调参/升级或信任置信度硬门。不能把上游新版能力视为本机0.3.21已支持。

### 3.1 真实决策兼容阻塞（LAYA-DECISION.1）

用户随后明确授权最多4次合成任务本地推理。实际只发送首个中文classifyTask请求：真实multilingual返回work_kind=implementation及action:{act_probability:1}，当前客户端readChoiceParameters把action当额外字符串任务参数，DECISION_SCHEMA拒绝；没有可供上层使用的validated classification。失败即停，其余英文/计划/pair三项未运行，不把raw JSON当PASS。服务已停止，Job ActiveProcessesFinal=0、owned清理通过。
本机0.3.21与[官方对应源码](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/laya/agent.py#L892)均将action作为答案元数据返回；捕获响应无网络回放复现同一拒绝。LAYA-COMPAT.1现已最小修复并独立通过：validateAnswer统一校验可选action为非数组对象且act_probability为有限[0,1]数值，choice保留字段排除该元数据，raw原样保留；真正字符串任务参数保持，其他非字符串任务参数仍拒绝。独立typecheck、decision429/0、initial-assignment37/0、state-loop169/0及同份捕获JSON修复前/后对照均通过。本片未启动真实服务或新增推理；不提升成真实四项验收或可靠性指标。下一候选LAYA-DECISION.2须另行授权本地4项实测；温度校准P2保留。

### 3.2 修复后四项真实接口验收（LAYA-DECISION.2）

用户另行授权4次本地合成POST后，实际4/4全部经生产provider校验通过：中文分类implementation/moderate（multilingual，734ms）；英文implementation/small（english，52ms）；full/lean计划选lean（73ms）；具体pair选所列demo-code-agent×demo-code-model（59ms）。后两项同为english。无重试，action元数据留raw、不进入parameters。每项各1样本耗时不是性能或选型质量基准；候选availability是合成输入，没有实际调用Agent或认证免费/账户额度。
响应本身routing证明checkpoint，但没有revision（metadata.revisions={}）；同一owned进程health确认english/multilingual都加载在实际cuda、device_is_preference=false、两revision均55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851，不能把health revision伪称逐响应字段。结束协同cancel/退出/validated Job ActiveProcessesFinal=0/owned根清理通过，服务未常驻。先前1/4失败记录保留为历史，当前4/4是新授权结果；不能反复运行旧脚本重用授权。
真实typed接口通过不等于完整生产CLI/Review/工具/真实模型选型最优均已验收。温度校准P2仍保留，产品原生会话5/5不变；下一候选只读准备既有round整链验收和预算，新增推理/Agent调用另行授权。本片未改代码或重新跑typecheck/full suite。

### 3.3 原生动作目标协议阻塞（LAYA-ROUND.1只读审核）

官方/本机0.3.21 choice只返回所列choice与分布、confidence、answer_confidence、action元数据，不生成任意taskId/agentId兄弟参数。当前orchestrationDecisionRequest只提供动作名；输入action_parameters说明不等于输出参数机制。extractAction依赖answer.parameters，而validateDecision要求complete的taskId。受控官方格式complete经真实provider→runDecisionCycle得到malformed-decision，任务仍to_verify、dispatch=0；这是无网络协议反例，不是新真实模型complete实测。b40a fixture主动提供parameters.taskId，因此其93/0与真实协议阻塞可同时成立，不能将fixture能力移到原生LAYA。
先前四预设真实PASS不变，但完整round为BLOCKED。最小方向是复用有限候选/精确映射，让LAYA选择包含已知任务目标的合法动作候选，再送同一验证/执行入口；不默认首任务、不把action元数据当编排动作、不引入生成大脑或新manager。仅建议，未实施；复杂自由参数动作需如实限制，不声称已支持全部动态改计划。
两步顺序理想8次本地决策（1分类+1计划+2pair+4cycle），正常有界loop对应最多13；默认原生Review在可审核/支持时至多另1（否则可为0），quota CLI最多4条正常命令尝试及原生内部辅助另计，不能把理想值当实际硬cap。当前可用性/真实免费证据与产品5/5授权边界保留，未实跑/未改源码。

### 3.4 有界workflow动作目标映射（LAYA-ACTION.1）

有acceptanceMaterial时，复用有限choice：continue/wait/abort加每个eligible to_verify任务的complete候选；单目标complete的描述/表绑定该任务，多目标使用不同opaque key。请求与目标表同次构建，响应只能按同表membership得到payload；不解析任意key生成taskId、不默认首任务、不把provider参数合并成目标。未知key/不一致taskId/额外动作或目标参数拒绝；相符taskId及reason/rationale重述可兼容但不改变候选payload。缺执行/criteria或空输出不提供complete，这是材料存在检查，不认证文件真实性或语义质量；质量由LAYA判定、当前状态仍由原Verification验证。
无material的通用旧请求保持11动作与参数路径。bounded workflow只提供continue/wait/abort/complete，复杂reassign/rework/改计划等自由参数动作不在本片原生支持范围；既有通用API并不因此被删除。独立typecheck及7个定向套件全绿，原生形状真实provider/CLI不再靠fixture注入目标；两个任务选第二个及独立first-target负控验证绑定确实承重。无真实LAYA/Agent调用，不把fixture验收当真实模型质量或整条生产round已认证。保留旧B45负控定位P2与温度P2，下一步真实本地目标验收另行授权。

### 3.5 已验证的实际输入预算限制

LAYA-ACTION.2 本轮真实3/3本地请求均选择continue，生产provider/decision loop解析和受控拒绝通过，未调用complete、任务状态未变；因此明确目标的正向验收NOT OBSERVED，整体BLOCKED。离线同tokenizer/build_sequence复算确认双目标state701 tokens只保留318、丢383，acceptance_material整段不在模型输入；五个选项marker和token span仍各自独立。此为证据可见性P1，不能仅据此断言三次continue的根因。服务已停/Job空/owned清理通过，固定缓存10文件摘要不变；无产品Agent/云模型/新增费用/生产修改。
本机固定english配置max_len=512/head_max_len=192，_encode_state对dict保留序列化state前部；客户端50,000字符限制不等于服务端模型可见长度。实际两个候选的同任务output在state后段，token重放证明未进入输入；须先保证候选与材料能在真实编码预算内共存或明确拒绝。此记录不批准调整已安装模型/服务设置，不能用候选描述中的criteria替代未看到的交付output。

### 3.6 输入可见性最小收口

LAYA-CONTEXT.1代码独立PASS，整体PASS WITH P2：bounded workflow状态/材料只去掉重复元数据，同任务objective/criteria/output及缺失/截断标记完整保留；原生响应后、任何动作应用前检查checkpoint与token信息，缺失/非正/非有限/未知checkpoint或达到保守512线拒绝，不重试。无material旧11动作与非LAYA通用seam保持。离线实际tokenizer验证双目标原样本由丢383 tokens变为全量可见：English300状态tokens、完整序列494；multilingual完整序列442。中英文/Unicode/长材料共8回放，长材料确认超限；不是模型forward或真实选择验收。
守卫在响应后生效，仍消耗一次决策调用，不是发请求前精确计数。实际固定english配置512/192，multilingual为1024/256；代码统一以512保守拒绝，多语言可能在本可容纳时被拒。源码注释和worker报告误把两者容量都写512，独立审核保留P2并在文档纠正，不把它提升为事实；后续限定维护纠正文案，当前不扩大预算。仅已固定配置假设内的有界保护，不认证任意服务配置/模型判断质量或完整round。
原生token信息由既有layaMetadata读取，bounded请求中在extractAction/applyDecision之前拒绝token-budget-saturated、token-visibility-unavailable或unsupported-native-checkpoint；无自动重试。非LAYA通用provider没有同样native预算证明，本片保持兼容，不将其fixture视作真实可见性认证。

### 3.7 真实动作输出的领域适配尚未验收

LAYA-ACTION.3 实际3/3本地请求仍选择continue，原生输入分别494/278/276 tokens；同一实际tokenizer回放确认三例状态均完整可见、材料字段存在、候选可区分，零state截断。生产provider/loop与守卫正确接收合法答案，complete调用0、Task状态未变，受控dispatch均拒绝真实执行；协议/安全/输入可见性通过，正向目标完成仍NOT OBSERVED，因此本片整体BLOCKED。不能据三例断言模型普遍不可用或确定其选择根因；也不能再以本轮材料缺失解释结果。
只读GitHub MCP成功核对官方同版本README Honest limits、staged-adoption与evals：官方自述基础权重在其typed-decisions任务域表现有限，建议shadow/审定标签/独立留出评估后再放行；这些上游结论不是本项目准确率，也不证明本次continue的因果原因。本机evals是已存在的模块文件，不是目录；原生JSONL校验/评价可复用，不安装新依赖。CrewAI quickstart含_DemoAgent关键词/mock回退，未执行、不能当真实模型成功证据。
参考：[同版本分阶段采用](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/staged-adoption.md)、[已有evals](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/evals.md)、[基础权重限制](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/README.md#honest-limits)。先复用小样本/审定标签与未知桶，不凭模型置信度、成功HTTP或几个样本宣称自主编排可靠；不自动采用示例中的固定fallback或阈值。

### 3.8 按现有ready事实过滤动作（LAYA-QUALITY.1）

调研结论采用“按当前状态过滤模型可见动作”，只参考[官方动态工具方法](https://docs.langchain.com/oss/python/langchain/agents#dynamic-tools)，不引入LangChain或第二套调度。GitHub MCP成功核对[同版本LAYA基准边界](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/benchmarks.md)与官方evals；typed-decisions专用权重面向四种合成业务流程，不据发布方成绩推断Coding验收可用，不下载或切换权重。

复用boundActionCandidates与现有observation.ready：仅在有ready子任务时提供continue，始终保留wait/abort及每个有材料的明确complete目标。请求构造与候选表同次冻结，provider等待期间的状态变化不能补授未提供的key；最终资源/quota/fixed/session/停止门保持。无acceptanceMaterial的旧11动作路径不变，不强迫模型完成任务，也不把ready当实际准入。

Codex独立typecheck及decision429/0、state-loop276/0、CLI98/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0全部exit0，三份源码/测试在验证前后hash稳定。内存负控撤去ready条件后264/12、exit1，未修改源文件；三份历史真实响应离线回放：两个ready为空的旧continue被拒且dispatch0，有ready的旧continue仍可进入受控dispatch；不是新模型选择或准确率。

本轮LAYA/产品Agent推理均0，未启动服务；累计本地11次与产品会话5/5不变。历史LAYA-ACTION.3仍BLOCKED（正向目标完成NOT OBSERVED），本片仅候选资格/受控闭环独立PASS；真实判断质量、完整round/工具/费用未认证。english512/192、multilingual1024/256的文案P2已纠正，统一保守512拒绝逻辑不变，保留支持范围限制、温度校准P2及旧B45负控维护P2。估算68/100、PARALLEL_WRITE=CLOSED，正式前端未进入。

下一候选LAYA-QUALITY.2：只在新增明确推理授权后，运行一次冻结的最小资格过滤验证，不重复大组试验。不改阈值/温度/模型，不用强制complete求通过；多个合理目标以接受集合记录，wait/abort如实保留，缺材料不得完成，有ready才允许continue。先离线检查请求与材料可见性，再提出精确次数/每次时限/失败即停范围；当前不启动任何新推理。

## 4. 当前请求约束

支持 choice、score、noul，具体字段以 types.ts 和 laya.ts 的校验为准。
拒绝空问题、缺少内容、未知类型、无效 instructions/state/context 和退化答案空间。
choice 至少两个有效选项；score 至少两个有效 level；
noul criteria 使用 true/false 键和有效描述。

源码当前限制包括：state 50,000 chars、64 questions、单题 100 choice options、
32 score levels、总 options 512、body 2,097,152 bytes。
这些是当前客户端约束，不是对所有上游版本的永久保证。

响应即使 HTTP 2xx，也必须校验回答完整性、type、候选/level、概率和置信度结构。
choice/score/noul 的概率/置信度规则不同，不能统一套用一个阈值公式。
HTTP 200、模型自报 confidence 或 token 数不能证明任务完成、工具调用或预算安全。

## 5. 失败语义

输入失败不发请求；超时、不可达、非成功 HTTP 和 schema 错误明确返回对应错误。
provider 不偷偷选择默认答案。上层如有已定义的 SOLO 等兼容行为，
必须保持可观察且与具体契约一致，不能泛化为任何失败都可猜答案。

LAYA 置信度需在本任务域评估，不作为绕过硬约束的授权。
usage 和 metadata 只记录实际返回值，缺失不编造成零。

## 6. 相关验证

    node tests/decision.test.ts
    node tests/initial-assignment-decision.test.ts
    node tests/live-decision-check.ts

最后一项需显式选择，依赖真实 laya-serve；本轮只读核对未运行上述测试。
Skill/MCP 选择的完整验收见 [后端需求 REQ-06](BACKEND_REQUIREMENTS.md)。

## 7. 新需求接线边界

LAYA 决策包含两个层次：选择合适工作流/分工；再为各独立任务选择具体 Agent × Model。
同目标组的成员职责与集成意图也应进入合法候选，不能成为另一个主管 Agent 的自主调度权。
候选内容由用户、明确模板或已授权 Agent 提供；新 B4.0 从有界候选计划选择，复用现有 typed choice，
不要求 LAYA 输出任意 JSON DAG，也不强制新增一次规划模型调用。
候选 DAG 先校验，再提交；用户 fixed 是硬约束，不能作为可被模型评分覆盖的偏好。
只有唯一候选时保持明确的无选择规则，不伪造 LAYA 已比较多个方案。

Skill/MCP已有声明候选→任务级advisory选择→brief→事件名称观察；不借skills boolean冒充自动目录，不把名称匹配当真实工具认证或权限强制。
普通round的seedRegistry保留配置model/probe modelHint/历史thread来源；B2.2新增显式--model-pool来源，仅当前admitted声明补新pair、标来源并保持pair-specific unknown，已有来源不覆盖。普通CLI接线已受控独立验证，不把声明提升为真实可调用或额度；doctor目录仍不写registry。代表duo成功及受控接线不替代真实LAYA验收。
请求的模型不等于服务端实际模型；DSH 未支持的逐请求选模型不能以提示词参数伪装实现。
LAYA 失败沿既有可观察失败语义处理，不猜计划、不生成免费资格、不解除 fixed。

## 8. 本轮只读外部依据

GitHub MCP读取[官方README](https://github.com/NandhaKishorM/laya/blob/main/README.md)与[health源码](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py)。health读取已加载agent元数据，未调用Router.load或推理。以上是上游源码依据，不证明本机版本/安装兼容性；不引入框架或新依赖。
