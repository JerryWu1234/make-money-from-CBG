# 自动连接与显式任务聚焦复核

本轮在 `722f254` 后继续更新 PR #77。用户要求精确锁定官网域名并默认连接，常规使用不再点击扩展开关或“开始查询”。

## 行为与修复

- 自动连接仅选择 `https://xyq.cbg.163.com` 合格页面；登录、支付、下单和账户路径排除。后台保留已绑定页的只读观察，断线、导航与 worker 重启重查身份与代次；工具栏只作可选暂停/继续开关。
- 列表中实际有超过 75 万字符的完整描述，原 20 万字符 MAIN 传输上限导致整个列表帧没有发出。现对 QueryResult 逐行投影当前列表消费者所需身份/时间字段，不变更详情资产读取；超量或不合法结构明确缺失，不截断成空列表。
- 官网实际退出链接使用 `javascript:logout('https://xyq.cbg.163.com/cgi-bin/logout.py?act=logout')`。现只解析该严格单调用形式，不执行它；仍需 MAIN 正向登录证据与可见退出控件，登录界面和负向标志优先否决。未知仍未知。
- 状态 GET 仅启动本地监听并读取数据就绪；不聚焦、不恢复、不输入。正常、认证、已加载且新鲜的后台列表可显示就绪。仅显式任务 POST 聚焦原绑定的精确标签页/窗口，取得新鲜可见快照后继续原 TCC/AX/前台/活动/lease/CAS 校验。
- focus 经过真实 Native Messaging，但归入 observe 只读类型，`posted` 必须为 false，伪 proof 不到 helper。focus 不改变 authority 或 stopped。
- toolbar 手动暂停只由再次点击 toolbar 继续；延迟 focus/resume 不能清除它。普通 server-stop 可恢复只读观察，仍不恢复输入。

## 独立复核及修复闭环

两位独立 reviewer 未读取记忆；另一位实现协作者只补测试。最终修复：

1. 旧 focus 晚于 toolbar stop 到达：focus 与 resume 均拒绝 autoPaused，不借 recoveryEpoch 清除手动暂停；覆盖晚到命令。
2. host-status 绕过 Runtime.stop 的取消路径：统一取消 focus 并中止等待。覆盖可见快照迟到、已返回 receipt 停止后失效。
3. 硬风险恢复丢失 focus receipt：透传到 recoverOfficialAccess 内部的 prepareManualRecovery。
4. 等待 nativeStatus 时收到停止、随后真实状态 ACK：focus 取消同步 abort 关联 recovery，关键 await 后重新检查，complete 拒绝取消票据；精准反例断言零新增 resume/activity/execute。
5. focus 产生的晚到窗口事件可能触发同页重绑：临界段内真实恢复只读 bind/capture 后再聚焦并 ACK，不仅改 observing 标志。

## 验证

- 最终针对性纯测：9 文件 200/200；兼容性子集：2 文件 57/57。测试集合内有重叠，计数不相加。
- MAIN/ISOLATED 隔离浏览器回归：1 文件 39/39；浏览器设置与采集入口页面：16/16。
- 独立测试协作者的 host/focus/activation 子集：3 文件 44/44，包含上述停止时序。
- `vp check`：0 错误、29 条既有 warning；构建与 diff 检查通过。本轮没有复跑历史完整套件。
- 最终真实安装隔离脚本：临时 Chrome 加载真实 MV3，无 toolbar action 自动绑定；15 行、903161 字符的原始列表逐行身份/时间一致；真实 Native Messaging focus 返回 posted=false，宿主断连重启后重新连接。只发送 ACK/status/focus，未发送 resume/activity/execute，未执行 OS 业务输入。

证据摘要见 [JSON](../evidence/cbg-native-auto-binding-2026-11-18.json)。截图为临时隔离商品列表，不包含真实账号、二维码、私钥或令牌。

## 实站范围

更新前实际日常 Chrome 已连接，服务收到官网 15 行真实列表；此前完整描述溢出问题已消除。最终版本安装文件已更新到 1.1.1，5174 验证服务已加载新代码，保留原数据库、9 条待采集记录及历史暂停账本，没有清数据或启动真实采集。用户休息前未重新加载最终版本，重启服务后的状态为宿主连接、等待官网重新绑定。明日须在扩展卡片重新加载一次、官网 CmdR 一次；最终登录就绪、用户点击采集及完整资产结果由实站验收确认，不记为已通过。多屏、锁屏仍按用户决定不作本轮门槛。
