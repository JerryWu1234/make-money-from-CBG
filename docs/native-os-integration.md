# 真实 OS 输入最小复现

> 新受控物理模式的操作与证据边界见[故障场景](./native-os-fault-scenarios.md#受控物理动作与真实停止对齐准备阶段尚未实机通过)。63项纯判据及prepare已通过，未产生物理通过结论；当前MAIN回调故障隔离由[新回归](./evidence/cbg-observer-contract-regression-2026-11-17.json)验证，旧原生四轮仍对应其记录版本。

> **2026-11-17 更新：** 当前 `224348ba` helper 已在无 AX 预检的新 profile 下通过 basic；独立 helper expiry 与本版断连/重启 fault-only 也通过。实际范围和新入口见[当前验收](./native-followup-acceptance-2026-11-17.md)。下文旧版本执行记录及其“尚未通过”按原时点保留；`RV6KYg` 本身仍失败，未改写为通过。物理、官网及鼠标来源边界仍保留。

入口为 [`scripts/native-os-integration.mjs`](../scripts/native-os-integration.mjs)。已执行真实安装、只读诊断、带显式只读AX setup的离线basic输入/等待/结束/取消，以及断连和重启各自fault-only验收。默认冷启动和其余物理范围未据此通过。早期四轮与后续收证分开记录，运行结果以实际 `os-result.json` 为准。

在仓库根目录使用支持 `node:sqlite` 和 `node:module.registerHooks` 的 Node 环境。下面沿用本机 Node25 启动 PATH；`vp exec` 可采用其 managed Node 运行时，不修改全局环境。

```sh
PATH=/Users/wangxinyan/.nvm/versions/node/v25.8.2/bin:$PATH vp exec node scripts/native-os-integration.mjs --prepare-only
```

默认不带参数与 `--prepare-only` 等价：准备临时扩展、宿主、正常编译的 helper、配置和记录器，写入 `plan.json`、`os-result.json`，不启动 Chrome。此时 `outcome` 为 `prepared-not-run`，不能作为实机输入证据。两个模式不可同时指定。

执行真实输入前，先确认其他 Chrome 测试和实装验收已结束，并准备实际 macOS 授权。按项目 [AGENTS.md](../AGENTS.md)，在 Codex 中必须通过 `exec_command` 的审批流程设置 `sandbox_permissions: "require_escalated"`，不要先在沙箱内试跑。批准后执行：

```sh
PATH=/Users/wangxinyan/.nvm/versions/node/v25.8.2/bin:$PATH vp exec node scripts/native-os-integration.mjs --run
```

本次运行独占 Chrome 测试时段。脚本使用新的临时 profile 和离线 fixture；其他网络请求均中止，不使用真实采集配置或日常浏览器目录。

脚本使用实际 `ExtensionNativeRuntime`、`AccessGovernor`、`withNativeWorkflow`，配合生产扩展、NativeMessaging host 和正常编译的 helper。扩展脚本按原文件复制；临时 manifest 增加固定公开测试 key，host 仅改用临时配置路径。stdio 和 Unix socket 记录器解析副本作证据，原始字节透明转发，不生成或替换 proof、权限结果、posted 回执或 active ACK。

用户已取消任务执行和等待期间的自动防休眠要求。当前实现不申请 IOPM 防休眠断言，脚本不再调用 `pmset` 验收；`activity.active` 与活动 ACK 的 `active` 只表示有效输入授权。授权租约、过期、停止、取消、断连及用户抢占检查继续保留。

Playwright/CDP 负责启动、安装和绑定扩展、离线路由、读取与截图，不填入、点击或按键操作业务控件。价格输入与本地搜索按钮由实际 runtime、授权工作流和 helper 执行。脚本将核对：

1. 真实权限、前台窗口与绑定状态；空闲时 `activity.active=false` 且没有活动租约。
2. 最低价格从 `100` 改为 `120`，点击模拟搜索并等待 DOM 提交；核对实际活动授权与同一租约的真实续约 ACK，工作流完成后授权结束、租约清空。
3. 另一工作流将价格改为 `140` 后取消；核对 runtime 停止、活动授权撤销及租约清空。
4. 三个动作各自的真实扩展 proof、成功 posted ACK、Governor permit 和命令记录匹配同一 actionId，并保留可信 DOM 输入/点击事件。
5. 结束时停止 runtime、关闭临时 Chrome、清理连接，并核对固定 helper PID 已退出。

脚本输出的 `OS plan:` 或 `OS evidence:` 指向本次临时目录下的 `os-result.json`。核对其中的 `mode`、`outcome`、`assertions`、`actions`、`permits`、`commands`、`nativeStdio`、`runtimeWire`、`cleanup`、`failure` 和 `notRun`；同时保留 `plan.json`、`native-wire.jsonl`、`access.sqlite` 及运行时生成的 `real-os-fixture.png`。准备模式、失败或被阻断的结果都应按原样保留，不能仅凭截图或退出码宣称完整验收。

`notRun` 的原因分别记录：

- **锁屏**：用户明确要求本轮延期，不执行，不记通过。
- **第二屏**：当前没有第二屏硬件；物理多屏、负坐标与跨屏缩放仍待硬件验收。
- **默认冷启动、租约到期**：ofKH5m仅在显式只读AX setup下通过basic；expiry `RV6KYg`已失败，独立helper过期验收NOT PASS，不能借其他场景补齐。
- **用户物理抢占、显示器断连**：尚未完成实机验收；未标记鼠标事件的来源仍未解释，不能当作人工抢占成功。
- **故障后的新业务授权和人工恢复**：断连/重启场景只证明旧活动被拒绝，不证明新的授权业务可以继续。
- **官网认证及 fresh 请求/回调证明**：模拟搜索只证明本地角色列表 DOM 提交，不代表真实官网认证查询，也不替代请求、成功回调与商品 DOM 一致的官网证据。

运行结果以实际 `os-result.json` 为准。

## 当前实机输入与故障结果

| 临时目录                             | 实际结果与范围                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/private/tmp/cbg-installed-oMeK6u/` | `passed-real-input-disconnect-only`。真实字段输入将价格从100替换为120，在`active:true`时断开真实relay socket；runtime停止、原helper退出，原工作流scope再次query被拒绝，故障后没有新proof或posted输入。                                                          |
| `/private/tmp/cbg-installed-pOTZmb/` | `passed-real-input-restart-only`。真实字段输入到120后，在`active:true`时终止原host；原helper退出。扩展实际重连到不同host/helper，runtime仍`stopped:true`，新helper为`active:false`、租约为空；旧scope被拒绝，新旧helper最终均退出。没有申请或通过新的业务授权。 |

两个目录各自的`os-result.json`记录一条已完成的真实字段动作及对应proof、posted回执、permit与命令。它们只通过字段动作completed后active等待期的各自故障场景，不代表按键发送中故障、basic或expiry；basic的另一次成功另列，锁屏仍由用户延期，多屏仍缺硬件。

`/private/tmp/cbg-installed-7Ft8AB/`的basic尝试已真实完成100→120，随后因未标记mouse事件停止。用户明确确认该轮完全没有操作。该事件在grant后约3.094秒发生；来源仍未解释，不能据PID、坐标或停止原因认定为人工操作，也不能认定为自身事件。该历史轮不是basic或物理抢占通过结果；后续ofKH5m通过不解释这条来源问题。

## 2026-11-15 早期实际尝试

本节保留旧需求下的原始实机结果，其中 `awake`、`assertionId` 和 power 记录均为历史证据；自动防休眠要求现已取消，不能把这些旧字段当作当前验收要求。

四轮均保留原始结果且零业务输入：

| 目录                                 | 实际结果                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/private/tmp/cbg-installed-wu1PLJ/` | 脚本缺少自动安装内容脚本的就绪屏障；仅host hello与清理stop。补真实脚本存活检查后再用新实例重跑，没有注入业务脚本。                                                                                                                                 |
| `/private/tmp/cbg-installed-xVQDJq/` | 暴露生产绑定过渡帧缺陷：清globals后空服龄帧被严格拒绝，正确后续帧堵在outbox。现按当前MAIN代次修复，非法条件规则保持。                                                                                                                              |
| `/private/tmp/cbg-installed-4ZSBau/` | 修复后实际双端resume与ready快照通过，真实DPR2/scale1；实际Chrome启动链helper报告Accessibility=false、ScreenRecording=false，而InputMonitoring及monitor均true。空闲awake=false、assertionId=0。停在辅助功能预检，没有activity/proof/posted/permit。 |
| `/private/tmp/cbg-installed-iKDjPi/` | 用户开启实际负责node的辅助功能后，以全新profile及新host/helper重验；TCC归属仍为相同managed Node26.13.1，实际Accessibility仍false、InputMonitoring及monitor=true。零activity/proof/posted/permit；没有根据用户回复假设权限生效。                    |

Codex直接启动helper的权限结果不能替代Chrome→NativeMessaging→host→helper实际链的权限。ScreenRecording在此记录为实际状态，不因其false擅自要求额外授权；当前输入预检被Accessibility阻断。未执行任何权限绕过、旧动作重放或实际锁屏。

可公开复核的选定原始字段与哈希见[实机尝试证据](./evidence/cbg-native-os-attempts-2026-11-15.json)。TCC确认responsible为managed Node26.13.1，而不是泛指Chrome或Codex；系统设置可能显示node条目。本轮只读设置UI失败（ScreenCaptureKit `-3811`），未观察或改动权限设置，不据此判断用户操作错误。锁屏延期、多屏无硬件，仍按原notRun范围保留。

## 后续权限、AX与抢占收证

用户随后确认确切Node条目原为关闭/不存在，完成添加并开启后，真实扩展链的AX、输入监控和monitor均通过，旧实现记录空闲无断言。当前不再以早期AX=false解释之后的失败。

实机发现Retina的CGDisplayPixelsWide返回逻辑宽度，已改用当前mode同轴pixel/point求倍率并严格校验；非0旋转明确拒绝。Chrome应用级AXRole只读查询已通过同PID零命中到唯一命中的对照，生产补这次标准握手；没有AX属性写或强开flag。所有URL唯一、DPR、AX命中和证明有效期检查保留。

之后的活动诊断在旧需求下真实持有IOPM，并在外来未标记鼠标/键盘事件后停止，固定helper退出且无残留断言。这些 power 结果原样保留，自动防休眠要求现已取消。该诊断不调用query/execute、没有command-proof，不能计为业务输入成功。选定原始字段和哈希见[单屏实机收证](./evidence/cbg-native-live-2026-11-16.json)，当前业务和故障验收仍保留notRun边界。

为把工具审批/浏览器准备与人工静置分开，可加`--await-start`：

```sh
vp exec node scripts/native-os-integration.mjs --run --scenario=preemption-diagnostic --await-start
```

脚本先真实绑定、预检并确认`activity.active=false`，输出本次临时目录的`AWAIT_NATIVE_START`信号路径；在该owned目录写入信号文件后，脚本重新只读核对真实窗口聚焦与权限，才开始原有活动。等待有界并记录时间，不清抢占状态、代次或unknown，也不伪造任何证明。默认不加该参数的流程保持原样。所有Chrome启动仍须按AGENTS审批。

## stock basic最终通过与复现setup

`/private/tmp/cbg-installed-ofKH5m/os-result.json`为`passed-real-input-wait-completion-cancellation-only`。stock C9f+Runtimee407真实完成field120、query、field140；三个action各自的SW proof、helper ok/posted、观察快照、Governor permit和Bridge命令全completed。页面wait/heartbeat、正常end active=false/lease={}及主动取消均通过原断言，固定helper17255退出。

该轮运行前有显式只读AX预检。项目现提供以下可复现setup，不视作默认冷启动修复：

```sh
vp exec node scripts/native-os-integration.mjs --run --ax-preflight
```

`--ax-preflight`在活动前运行只读AX探针并核对最后样本唯一命中本次fixture URL，不写AX属性、不生成输入proof、不投递业务输入。命令仍须`require_escalated`并与其他Chrome任务互斥。ofKH5m的结论不扩到默认冷启动、官网或其他未验物理场景。

该通过包含两项已确认Runtime修复：z6混帧先DOM/旧MAIN参数现须一致后才completed；43SYtA取消后的server-stop只对纯status保留同action真实回复，其他停止/请求/超时边界不变。分别新增纯36+浏览器1及Unix14回归，并由两位独立reviewer闭合。C保持9f，Runtime最终为e407；全量203文件3641/3641、0失败0跳过、621.07秒，报告`/tmp/cbg-six-release-complete-final.json`。3590/3587属于修复前历史。

privateSource `km8`/`NQV`实验不采纳，不是生产修复或通过证据；7Ft用户完全无操作的未标记mouse来源仍未解。expiry `RV6KYg`已失败，独立helper过期验收NOT PASS。多屏缺硬件、锁屏延期、受控物理接管未验，官网首次查询人工；goal仍未完成。

`RV6KYg`实际以`failed-or-blocked`结束（terminal 1）：helper21578在host暂停窗口的85次采样均存活，恢复后真实status为active=false/lease={}。但此前续租回执已超时并由Node发送stop，wire只有server-stop，等待expired原因最终超时。因此不能把inactive归因为helper独立过期，验收明确NOT PASS；cleanup确认helper已退出。没有改断言或伪造结果，不再扩实验；独立helper过期仍是剩余验收缺口。
