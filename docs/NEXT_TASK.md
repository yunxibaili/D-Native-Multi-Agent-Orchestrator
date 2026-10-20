# 唯一下一任务 — P0-4.20 单次原生Reviewer验证（待Owner新授权）

P0-4.19有限离线PASS，唯一基线§7.82：OpenCode Go首次超时后一次定向返工完成，typecheck一次0；Codex独立白名单contained单文件一次118/0，3个owned Job final0。首轮node-e只读包信息违反指令的偏差完整保留。无生产改动，无真实产品Worker/LAYA/Review/Round；不能把离线闭环或开发Go会话当真实Review成功。

## 唯一最小建议

单次受控Codex Native Review复核已有真实Round成果，不重新执行Round/Worker/LAYA。固定codex/gpt-6.1-sol，最多1个独立原生会话，实际进程deadline90000ms，失败不重试、不换模型；继续统一runUnifiedReview、结构化schema与唯一owned -o最终文件，严格身份/succeeded/exit0/signalnull/Job停止后读取/validate/清理门禁，不直接手拼输出当产品通过。

执行前仅核对当前代码、既有真实Review材料/产物的身份和哈希，以及已有contained入口适用性；无适用入口或必须改生产代码时停止，提出精确需求，不临时另造Runtime。采用已实现进程局部analytics.enabled=false，不扩大deadline、不做额外探针碰运气。

## 尚未获批

Owner需明确授权上述一次原生会话及消费已有真实成果的数据范围，并确认当前gpt-6.1-sol订阅包含额度足额、无额外credits/API按量/自动充值/付费fallback、辅助调用同边界。Go开发声明不覆盖产品Reviewer，旧调用/费用窗口不补用；当前不启动模型或服务。

验收仅该原生Review是否合法verdict及可信退出/清理，不能回填旧Round PASS或代替Owner Human Gate。输出与Job证据完整留存，不改旧结果/旧证据/用户账户。P0-2新增功能/前端/接力继续不启动。

主HEAD/index/范围外dirty保留；阶段归档沿用独立codex分支、精确文件及隔离索引，不合并main、不强推、不上传本机进度/审计材料。P0-4.19远端SHA/清理事实以本机archive.json及最终记录为准。