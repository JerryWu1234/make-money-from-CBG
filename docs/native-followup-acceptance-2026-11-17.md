# PR #77 原生后续验收（2026-11-17）

> **后续更新：** OBS-02 网站回调故障隔离已在 `14aec82` 修复并经两位独立复审；当前全量为204文件、3683/3683通过，见[回调复核](./reviews/cbg-observer-callback-isolation-2026-11-17.md)和[当前回归](./evidence/cbg-observer-contract-regression-2026-11-17.json)。受控Esc入口及63项纯判据已准备，见[准备证据](./evidence/cbg-physical-takeover-preparation-2026-11-17.json)；尚无真实用户意图/事后回执，不算物理通过。以下四轮原生实机记录于 `98318d6`，Input/host/Runtime字节仍未变；它们不证明新MAIN回调或新物理模式已实机重跑。

当前生产 `Input.m` 为 `224348ba03a4c93bdc37e23a654a9243d2b64ff1839455d7950fb7d998469e15`，正常编译 helper 为 `ece793eb4b1eb3c8da58b5e50dbb39574ebd3d0d975b60ee86954b40e5942223`。host 和 Runtime 分别保持 `d8fc9471…`、`e407714d…`。本记录补充原六项交付，取代旧记录中“当前冷启动/独立过期尚未通过”的状态摘要；原始失败与旧版本证据仍按原结果保留。

自动防休眠已按用户要求移除，`active` 只表示有效输入授权。没有重新加入 IOPM 断言，也没有放宽停止、权限、前台、页面身份或抢占检查。

## 代码与独立 review

生产修复提交 `20a7d53` 在原 proof 的 1500ms 有效期内，为 AX 就绪读取设置最多 700ms 的结果接受预算。每个实际读取对象设置剩余消息超时，并在 IPC 前后复核原活动、授权代次、proof、PID、前台与原窗口。只有完整扫描且目标 URL 零命中才重采样；多匹配、截断、读取失败或非法类型都拒绝。不重取 proof、不重派动作、不写 AX 属性或延长 TTL。700ms 不是系统调用硬实时中断保证。

watchdog 已判定租约过期时先按原 lease 身份撤权，不再先查询桌面状态。这修复了确定的代码顺序风险，不意味着此前 `RV6KYg` 已被证明阻塞于 WindowServer。

独立 stdio observer 仅用于测试。显式 `--observe-helper-stdio` 在临时 host 副本中增加一个透明进程，生产 helper 的路径和二进制字节保持不变。记录器分别核验 host、observer、真实 helper 的 PID/PPID 和哈希，保存原始双向 Buffer；不生成权限、proof、ACK 或业务回复。默认流程不插入 observer。

三位子 agent 延续各自空父历史且不读取 memory 的任务。原生实现由另两位独立复审；observer 也由另两位独立复审。以下确认的问题全部修复并复核：

- AX success 却无值、缺失状态却有值，以及错误或空的 Role/URL，不能把未知子树当作完整唯一页面。
- 原始流按消息重组，不能因 grant 与后续命令合并、分片，或 ACK 被较晚读取而漏掉 stop/续租。排除区间从 grant 首片开始，暂停前只允许已知的只读 status，暂停后不得有入站字节。
- 溢出后停止增长并失败；child 的退出码 0 不能覆盖 fatal，OS runner 也必须传播失败。提前 EOF、信号、早期退出均核验真实子进程清理。
- Node 测试注册 Promise 显式等待，未增加 lint suppress。

## 验证范围

| 验证               | 结果与证据                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整回归           | 204 文件、3683/3683 通过，0 失败、0 跳过，627.47 秒；包含34项同源码AX/watchdog及8项观察回调故障回归。见[逐文件与源码哈希](./evidence/cbg-observer-contract-regression-2026-11-17.json)。                                            |
| 检查与构建         | `vp check` 0 错误、29 条原有 warning；构建通过。正常 helper 55 项、抢占 14 项无输入自检通过；真实 CoreGraphics 键盘对象 flags 为 0、Unicode 为 120，不调用事件投递。                                                                |
| 独立记录器纯回归   | 15/15 通过，包括合并/分片、ACK 前后的命令、partial、信号/EOF、背压、溢出、退出码和清理。与全量计数分开，不相加。                                                                                                                    |
| 默认 AX 路径 basic | `ALYpDS` 新进程、新 profile，无 `--ax-preflight`、无 observer、无外部 AX 诊断。3 个动作均有真实 SW proof、helper ok/posted、可信 DOM、completed permit/Bridge；等待续租、正常结束和取消通过，helper 退出。                          |
| helper 独立过期    | `9mAQdg` 正常生产 helper，host 暂停而 observer 独立运行。截止后 51ms 收到完全匹配原 lease 的真实 expired 消息，当时 host 为 `T`；此前无续租、stop、信号或 EOF。恢复后 inactive/lease={}，旧 scope 无新增 proof/输入，全部进程退出。 |
| 当前版本断连与重启 | `kvMysh`、`6Xqp2D` 分别 fault-only 通过。故障发生在 field120 完成后的 active 等待期；旧 scope 拒绝。重启后新 host/helper 连接，Runtime 仍 stopped、active=false/lease={}，没有申请新业务授权。                                      |

重启样本中，旧 scope 重连后曾对 140 做一次只读 locate，回执 `posted:false`；随后活动授权检查拒绝，没有新增 execute、proof、输入或第二个 permit。“旧 scope 拒绝”不表示没有发生这次只读定位。

本轮四个实机目录使用相同新 helper 字节。原始报告、stdio 哈希、身份、逐 action 证据、状态与清理见[当前实机证据](./evidence/cbg-native-followup-live-2026-11-17.json)。原生 basic 与独立 expiry 的原始包已分别由子 agent 直接核对 stdio、SQLite 和真实进程身份。

`9mAQdg` 的 Runtime 更早因原有 10 秒回执超时停止；helper 的独立到期晚于该事件。故只能证明 helper 在暂停 host 下自行撤权，不能声称 Runtime 是被 expired 通知停止。历史 `RV6KYg` 仍为 failed-or-blocked，未把恢复后的 inactive 冒充独立过期。

## 可复现入口

在仓库目录、沙箱外依次运行，使用项目管理的 Node 26.13.1。每次使用新的临时 profile/SQLite；出现 `AWAIT_NATIVE_START` 后，为该次目录创建 `start-native.signal`。先确认桌面时间窗口，避免与其他 Chrome 测试重叠。

```sh
vp exec node scripts/native-os-integration.mjs --run --scenario=basic --await-start
vp exec node scripts/native-os-integration.mjs --run --scenario=expiry --await-start --observe-helper-stdio
vp exec node scripts/native-os-integration.mjs --run --scenario=disconnect --await-start
vp exec node scripts/native-os-integration.mjs --run --scenario=restart --await-start
vp exec node --test scripts/native-helper-stdio-observer-regression.mjs
```

实机 scope 为已授权 TCC、明确前台 start gate、隔离离线页面下的首轮默认 AX 路径；不能扩为无需等待的无人值守启动、实际触发零到一重采样、跨环境长期稳定或官网成功。断连、重启和 expiry 不证明按键发送中的故障。

## 尚未完成

用户确认未操作时的历史未标记鼠标事件来源仍未解；本轮通过不代表它已消失。没有按 PID、坐标、时间或零位移增加豁免。受控物理用户接管尚未验收；多屏、负坐标和跨屏缩放缺第二块实际显示器；锁屏按用户要求延期。本轮没有访问真实官网或登录，官网首次查询继续由用户人工操作。

goal 尚未全部完成；剩余实机需要实际用户操作和硬件后继续，不能用准备或离线通过替代。高斯轨迹和无业务目的随机浏览仍为可选实验。
