# MAIN 回调观察失败隔离复核（2026-11-17）

六项改进的后续 completion audit 确认一个 OBS-02 缺口：`ajax_with_recommend` 的回调 `finally` 直接调度观察读取；若调度器抛错，会覆盖网站原本的返回值或异常，并跳过描述符恢复。构造观察 metadata 时抛错也有同样问题。

生产变更只把该回调的整个观察后处理放入现有 `safe`，描述符恢复继续在单独的 `safe(record.restore)` 中执行。原 `Reflect.apply(callback, this, values)`、请求身份、新回调关联、完成判据和生命周期围栏均未改变。

当前 MAIN SHA256：`361a6b35a91d968ad281b1a1b64252edcb2d62bf8d119da6bf0aee818a4f3f9b`。

## 证据

实际执行 MAIN 脚本的 VM 回归使用合法请求数据，确认回调确实已包装，再交叉注入以下故障：

- `onSuccess`、`onFailure`。
- 返回原对象、抛出原 Error 对象。
- `setTimeout` 调度失败、`Date.toISOString` metadata 构造失败。

8 个新用例在修复前全部失败，原 16 项通过；修复后保留原 receiver、参数、恰一次调用、返回对象或同一异常身份，以及原始属性描述符。定向 3 文件 38/38 通过。

完整回归为 **204 文件、3683/3683 通过**，0 失败、0 跳过，627.47 秒；构建通过。原始日志摘要、逐文件计数及源码哈希见[当前回归记录](../evidence/cbg-observer-contract-regression-2026-11-17.json)。物理接管判据的独立 Node 用例不计入该全量数字，也不作为物理输入证明。

另两位子 agent 分别直接审源码并独立运行 VM 故障组合或单文件 24 项，确认缺口闭合。没有读取 memory，没有运行 Chrome 或投递系统输入；独立数字与主回归有重叠，不相加。

## 版本与未完成范围

本次 MAIN 变更未修改生产 Input、host 或 Runtime，其哈希仍分别为 `224348ba…`、`d8fc9471…`、`e407714d…`。[四轮原生实机证据](../evidence/cbg-native-followup-live-2026-11-17.json)记录于 `98318d6`，当时 MAIN 为该提交版本；本回调异常修复由上述独立源码与回归验证，不冒称四轮原生已针对新 MAIN 重跑。

历史无操作鼠标事件来源仍未解；首事件记录不能追溯缺失的生产者或完整前序。当前没有增加 PID、坐标或时间豁免。受控物理接管仍需要真实用户操作；当前只有一块内建 Retina 显示器，锁屏按用户要求延期，官网首次查询继续人工进行。goal 未记全部完成。
