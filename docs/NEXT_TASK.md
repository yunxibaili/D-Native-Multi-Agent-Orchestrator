# 唯一下一任务 — P0-3最终只读静态收口（待Owner确认）

当前事实见PROJECT_BASELINE.md §7.45。P0-3a来源、P0-3b检查点材料、P0-3c自动异常/Review非pass投影均已有限离线PASS；P0-3整体及真实MVP尚未封板。

## 唯一下一动作

不再追加实现或机械跑测试。只读核对批准的监督、异常、用户交付与最终Human Gate契约，对照a/b/c源码、已有日志与哈希，裁定P0-3在限定范围内能否收口；若仍有直接缺口，具体列出，不继续扩张。

- P0-3c现有A–F加预算0/2及Review reject/rework，单文件仅一次104/0，最终typecheck通过。提前返回保存attention-only记录，不伪造任务/Attempt或完整RoundResult。
- wait保真，系统失败不伪记Owner stop；机器验证失败/预算拒绝/非pass Review不会制造成功。
- 交付与未完成事项保存在现有结果中；resumeSupported=false，stopSafetyCertified=false。报告保存不是持久恢复或整轮安全证明。
- 保持原停止保护、唯一Verification、TaskStore与最终动作NONE；不重新运行历史9/26失败。

## 后续真实闭环

只读收口之后才能另行核对当前模型资格、费用、人工最终决定、数据范围、调用次数与deadline，并取得新的真实执行授权。当前不允许真实产品Agent/LAYA/Native Review、第四次E2E或新开发。

Codex本片直接实施并静态复核，不称OpenCode委派或第三方独立审计。OpenCode403/桌面接入旁支保持暂停；外部规范确实未知再给Gemini具体检索单，不为本地明确接线重复检索。

阶段完成后依Owner授权推送独立审核分支，不合并main；主HEAD/index/范围外dirty保留，9/26历史边界与68/100规划信用不变。audit只读，进度页ignored，正式前端未授权。
