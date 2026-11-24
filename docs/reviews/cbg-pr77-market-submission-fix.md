# PR #77 市场提交修复独立复核

复核基线：`c35983081de5cd247d85c021bf56d081ee02d27a`。范围仅为本轮 market callback 新鲜度、请求归属和结果对应修复，以及相应测试、风险说明；不替代整份 PR 的完整审查。

结论：此前独立复现的问题均已处理。最终独立隔离浏览器 10 项 probe 全部通过，未发现本轮修复仍有可复现的阻塞缺陷。

## 已处理的问题

1. **结果区任意变动冒充当前响应完成。** 初版在新成功回调后，仅变更分页文字即可把旧商品行记为新结果；旧请求先回调、延迟渲染晚于新回调时，也能冒领新响应。修复删除 DOM mutation witness，改用本次响应的受限商品身份摘要与可见行逐项对应。
2. **微任务渲染被错误拒绝。** 初版的同步 mutation 与 postMessage 后 baseline 存在时序空隙；真实 `queueMicrotask` 已渲染新结果，仍保持 uncommitted。身份对应方案不依赖该时间窗口。
3. **后台请求继承旧点击。** 初版保留上次可信点击的 timeStamp，点击本身未发请求时，后续独立后台请求仍能归属当前 action。修复要求可信事件仍在派发，并且同一激活只能关联首个请求。
4. **迟到旧回调否认正确新结果。** 初版固定读取 `business.at(-1)`：当前响应已正确渲染后，旧请求的迟到回调即使被网站忽略，也会令 committed 从 true 变为 false。现按 submission/commit 的唯一 requestId、eventId 查找对应响应；若旧回调实际替换了 DOM，身份不再相符，仍拒绝采用。
5. **不完整商品身份。** 最终实现要求非空行具有服务器身份及 eid 或订单标识，避免假设 eid 跨服全局唯一。

## 最终代码核验

- MAIN 在调用原回调前保存受限公共摘要，执行后发布响应；回调 this、参数、返回和抛出的原异常保持。回调异常不标为成功。请求公共条件在请求启动时固定，唯一 requestId 将并发、倒序回调分开。
- ISOLATED 仅把当前目标可信点击的一次请求与 action/query 关联；停止、绑定和 URL 代次改变会清理旧关联。
- marketRules 检查对应成功响应、类别、查询条件、页码、行数和有序身份。空结果须响应确实为空、可见商品行数为零并存在空标志；普通 revision、滚动、分页文字和容器属性变化不满足完成条件。
- Runtime 交叉核验 commit 与对应业务响应的成功、request/event、action/query、开始/完成时间和行数；请求必须不早于本次授权派发，完成时间不晚于快照。
- 相同身份的全新响应允许 DOM 不变化；该行为是明确设计，后续候选仍需重新打开详情验证，不能把列表身份核对视为价格或详情字段已刷新。

## 验证记录

已执行纯测试：

```text
PATH=/Users/wangxinyan/.nvm/versions/node/v25.8.2/bin:$PATH ./node_modules/.bin/vp test server/adapters/passive-observer.test.ts server/adapters/extension-native.test.ts
2 files / 23 tests passed
```

最终独立浏览器命令：

```text
PATH=/Users/wangxinyan/.nvm/versions/node/v25.8.2/bin:$PATH node /private/tmp/cbg-pr77-review-repro.mjs
exit 0 / 10 assertions passed
```

该次测试在其他 Chrome suite 完成后独立串行运行，临时隔离 Chrome 已关闭。所有页面请求均由本地 route 拦截，不访问真实官网、不使用真实用户配置。验证了以下结果：

| 场景                                       | 结果                 |
| ------------------------------------------ | -------------------- |
| 新回调后只有分页文字变动，旧行身份不同     | 不提交               |
| 原回调通过 queueMicrotask 渲染当前商品     | 提交                 |
| 旧回调先到、新回调到后旧任务才延迟渲染     | 不冒领新响应         |
| 新响应与现有 DOM 商品身份相同，无 mutation | 提交                 |
| 目标点击未发请求，后续独立后台请求渲染     | 不继承该点击         |
| 当前响应正确渲染后，旧回调迟到但不改 DOM   | 保留当前有效证明     |
| 原回调通过 splice 消费 msg 后渲染          | 保留原摘要并提交     |
| 响应缺少服务器身份                         | 不提交               |
| 响应服务器与 DOM 不同                      | 不提交               |
| 当前正确提交后，旧回调迟到并改为旧商品 DOM | 当前证明失效，不提交 |

## 保留的边界

- 已确认的请求启动模式是：目标可信 click 派发期间同步启动的首个 `ajax_with_recommend`。延迟或微任务才启动请求、一次点击先发别的查询、缺失身份或未知 schema 会保持 unknown/暂停。支持异步 DOM 渲染不等于支持任意异步请求启动。
- 临时浏览器 fixture 验证脚本逻辑和浏览器事件时序；未验证真实扩展安装、真实 OS 输入或官网当前响应 schema。
- 本轮不声称发现并修复了 PR #77 的全部潜在问题，也未提交源码或发送外部消息。
