# 真实 Native 故障场景脚本

入口为 `scripts/native-os-integration.mjs`。本页区分场景流程与下方已执行结果；disconnect与restart各自fault-only已通过；另有带显式只读AX setup的stock basic通过，范围分别记录。默认不传 `--scenario` 时仍执行原 basic 输入、等待、完成和取消流程；下面每条命令都会准备全新的临时 Chrome profile、扩展、正常 helper、DB 和 socket。

```sh
vp exec node scripts/native-os-integration.mjs --prepare-only --scenario=expiry
vp exec node scripts/native-os-integration.mjs --run --scenario=expiry
vp exec node scripts/native-os-integration.mjs --run --scenario=disconnect
vp exec node scripts/native-os-integration.mjs --run --scenario=restart
```

`--prepare-only` 不启动 Chrome、不申请活动授权、不发送 OS 输入。`--run` 必须先协调 Chrome 独占与用户静置，并按 AGENTS.md 通过 `require_escalated` 审批。真实权限预检失败即停止，不根据用户口头授权推定通过。

用户已取消自动防休眠要求；当前场景不申请 IOPM 断言，也不使用 `pmset` 验收。三个场景都先通过真实 runtime、Governor、工作流、扩展 proof 和正常 helper 将隔离表单价格从 100 改为 120，记录实际 activity lease、严格布尔 `active` ACK/status、host PID 与其真实 helper 子 PID。随后保留原工作流的 AsyncLocalStorage scope，验证故障后原 scope 内的下一次正常 query 被拒绝；不在 scope 外启动新活动，不手发 resume，不清 unknown，不伪造 proof 或 active ACK。

- `expiry`：只 SIGSTOP 本次真实 host，不暂停 helper。先确认实际 ACK 的租约尚未到期，再每约 200ms 核对固定 helper PID 仍存活，直到租约截止后两秒。随后 SIGCONT host，要求实际 expired 停止原因、`activity.active=false`、租约清空，并检查旧缓冲请求没有新的 proof 或成功输入。暂停期间仅观察进程存活；活动状态在 host 恢复后读取，不据此声称已独立观测暂停期间 helper 的精确撤销时刻。普通异常的内外 finally 均先 SIGCONT 再清理。暂停期间不要强杀脚本或取消工具 session；若外部强制中断，应先恢复结果中记录的自有 host PID，再核验退出。
- `disconnect`：销毁本次 relay 的真实 socket 双端，等待 runtime 停止、原 helper 退出，再检查原 scope 拒绝。
- `restart`：SIGKILL 本次真实 host，验证原 helper 退出。随后通过真实扩展 toolbar 路径触发 connectNative，等待不同 host PID 与真实 host-hello，记录新 host 的真实 helper 子 PID。重连只允许观察绑定，确认没有活动授权，不申请新业务活动；旧 scope 仍须拒绝。清理同时核对新旧 helper 全部退出。

成功的实际输入必须按同一 actionId 对齐 SW command-proof、helper 成功 posted 回执、Governor completed permit 和 Bridge completed 命令。宿主在停止时保守返回的 `posted:true, ok:false` 是未知结果，不能计作实际输入成功。脚本还核对价格保持 120、故障后没有新增 proof 或 posted 回执。

每个目录的 `os-result.json` 保留原始 wire、stdio、permit、command、失败 DOM 状态、固定 PID 与清理信息；`notRun` 仅在对应场景实际通过后移除该项。物理用户抢占尚未加入本脚本，需要用户实际移动协作，不能用 CGEvent/CDP 冒充。本轮不锁屏；第二屏缺硬件；恢复新业务授权和官网新请求/成功回调均不由这些离线故障场景证明。

## 当前已执行范围

- `/private/tmp/cbg-installed-oMeK6u/os-result.json`：`passed-real-input-disconnect-only`。一条真实字段动作将100替换为120后，确认活动仍为`active:true`再断开真实relay socket。runtime停止、原helper退出，原AsyncLocalStorage scope再次query被拒绝；故障后没有新增proof或posted输入。
- `/private/tmp/cbg-installed-pOTZmb/os-result.json`：`passed-real-input-restart-only`。真实输入到120且活动仍有效时终止原host，原helper退出；通过真实扩展路径重连到不同host/helper后，runtime仍`stopped:true`，新helper `active:false`且租约为空。旧scope再次query被拒绝，新旧helper最终均退出。没有申请或通过新业务授权。

两轮各有一条按同一actionId对齐的真实proof、成功posted回执、completed permit和completed命令，只证明对应fault-only场景。两项fault-only不能推及按键发送中故障。后续ofKH5m在显式只读AX setup下通过basic原断言；expiry `RV6KYg`已失败，独立helper过期验收NOT PASS。锁屏由用户延期，多屏缺硬件，故障后的新业务恢复也未通过。

basic尝试`/private/tmp/cbg-installed-7Ft8AB/`虽然真实完成100→120，后续仍被未标记mouse事件停止。用户明确确认全程没有操作；该事件来源未解，不能据PID0、相近坐标或停止原因归为人工抢占，也不能直接归为自身投递。因此该历史轮basic失败与未完成的物理接管边界继续保留；后续ofKH5m通过不解决来源问题。

## 只读 AX 诊断

```sh
vp exec node scripts/native-os-integration.mjs --prepare-only --scenario=ax-readonly
vp exec node scripts/native-os-integration.mjs --run --scenario=ax-readonly
```

此模式仍须按项目要求审批 Chrome 启动，但不申请活动、不发送 execute、不操作业务控件。诊断程序以同一翻译单元编译当前 `Input.m` 的真实 `tree`、`str` 和 `bounds`，不调用生产 main。使用 CDP 的实际 browser PID 与 macOS 前台 PID 比较；只有前台为本次 Chrome 时才读取焦点窗口。首次以及约 100、300、800ms 的结果只保存角色、URL 值类型、预期 fixture URL 的命中数和边界，不保存其他页面 URL。`completed-read-only-ax-diagnostic` 仅表示诊断执行完毕，不代表 AX 匹配或任何 OS 输入通过。

当前对照保留四次原始基线，然后只读同一应用的 `AXRole`，再按相同时刻采样四次。它不写 AX 属性，也不加浏览器辅助功能强制标志。只有实际的基线与对照变化才能用于判断握手机制，不能把本来就绪的单次结果当作因果证据。

## 无业务输入的抢占诊断

```sh
vp exec node scripts/native-os-integration.mjs --prepare-only --scenario=preemption-diagnostic
vp exec node scripts/native-os-integration.mjs --run --scenario=preemption-diagnostic
```

此模式通过真实生产工作流申请活动并观察最多 12 秒，不调用 query 或 execute，不生成 command-proof，不向页面发送 OS 输入。用户可正常操作以收集实际停止原因。结果保存 helper 生命周期中首次触发抢占的原子数值诊断：事件类型、来源 PID、userData、事件与回调时间、grant 时间和当时的活动 epoch/所有权；不保存按键编码、文字或日常 URL。纳秒时间保存为字符串，避免 JSON 数字精度损失。

诊断保留所有拒绝规则：即使事件时间早于 grant，也仍会停止。`recordScope` 明确为 helper 生命周期首事件，后续活动不能把旧 epoch 记录归为新事件。`completed-native-preemption-diagnostic-no-input` 仅表示收证结束，不能计为 OS 输入成功或完整物理抢占验收。

## stock basic与剩余验收缺口

`/private/tmp/cbg-installed-ofKH5m/os-result.json`真实通过`passed-real-input-wait-completion-cancellation-only`：stock C9f+Runtimee407下field120、query、field140共3动作的proof/helper/观察/permit/Bridge均completed；wait、heartbeat、正常end active=false/lease={}及cancellation全部原断言通过，helper17255退出。其运行前有显式只读AX预检，现可用`--run --ax-preflight`复现setup；这不是默认冷启动或官网验收。

z6混帧与43SYtA取消/status竞态已分别经两位独立reviewer闭合，新增纯36+浏览器1与真实Unix14回归，保留原TTL及未知动作不重放。最终全量`/tmp/cbg-six-release-complete-final.json`为203文件3641/3641、0失败0跳过、621.07秒；3590/3587为历史。

expiry `RV6KYg`已失败，独立helper过期验收NOT PASS。privateSource `km8`/`NQV`对照不采纳，C9f未变，7Ft用户无操作时的未标记mouse来源仍未解。受控物理接管未验、锁屏延期、多屏无硬件、官网首次查询人工等边界保留；goal不记完成。

`RV6KYg`实际以`failed-or-blocked`结束（terminal 1）：helper21578在host暂停窗口的85次采样均存活，恢复后真实status为active=false/lease={}。但此前续租回执已超时并由Node发送stop，wire只有server-stop，等待expired原因最终超时。因此不能把inactive归因为helper独立过期，验收明确NOT PASS；cleanup确认helper已退出。没有改断言或伪造结果，不再扩实验；独立helper过期仍是剩余验收缺口。
