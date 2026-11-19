# PR #77 受控 Esc 实机复核（2026-11-17）

基线 `084b691`。本次代码只将原生隔离测试开始前的空闲 gate 从180000延长至900000毫秒，等待实际用户确认；活动TTL、20秒动作窗口、60秒事后回执和63项验收判据均未改。生产源码未变。临时执行入口与交付 runner 逐字节相同，SHA256 `629f0c5851c1d7fd5065eebf62ce5cf8f20678a7a1867f99a14e3d2d1640ab9e`。

两位独立 reviewer `/root/review_native_probe_fresh`、`/root/observer_impl_continued` 直接读取 `bs9yzU` 的 helper/native/socket 原始流和 SQLite，并实算源码、安装文件与五份 capture 哈希。两位原以空父聊天历史创建，按要求未读取记忆。本次 review 不启动 Chrome 或生成输入。

两位一致确认：

- 真实 field100→120 有1次 proof、execute、成功 posted、可信 DOM input，permit/Bridge 唯一且 completed。
- 28行 helper 原始记录重解后，首次抢占为同 helper、同 lease/epoch 的未标记 type10；在此前无 stop、signal 或 EOF。原始事件区间在提示窗口内，窗口内该字段首个可信 keydown 是 Escape/27，事后实际用户回执在限时内。
- 实际 helper inactive、lease清空，Runtime stopped、governor needs_action。旧 ALS 的140尝试因缺失/过期快照拒绝，无新定位、execute、proof、posted输入或第二个permit。该次不单独证明后续授权守卫的拒绝原因。
- runner、Chrome、host、observer、helper 五个精确PID均已退出。生产 Input/host/Runtime/MAIN 与所记哈希一致。

已修复 review 文案：历史尝试不再暗示交付页面内开始按钮；已提交/当前runner表述、窗口内首个keydown范围及旧scope拒绝原因均明确。两位最终无剩余已确认 finding。

本轮63/63纯回归和 `vp check`（0错误、29条原有warning）通过。此前204文件、3683项全量和构建保持原 capture，本次未重跑生产未变的完整回归。实际执行终端0，但结论限定为“用户确认 Esc 与原生 keydown 撤权对齐”。helper没有记录键码，不证明事件生产者、严格因果或历史鼠标事件来源。隔离模拟页、AX预检及透明observer的范围不能扩展到官网、多屏、锁屏或故障期间的新授权恢复。

[实际证据](../evidence/cbg-physical-takeover-live-2026-11-17.json) · [历史未通过尝试](../evidence/cbg-physical-takeover-attempts-2026-11-17.json) · [交付摘要](../native-followup-acceptance-2026-11-17.md)
