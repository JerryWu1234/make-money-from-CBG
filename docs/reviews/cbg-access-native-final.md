# CBG P1/P2 原生全链独立最终审查

评审日期：2026-11-15，Asia/Shanghai。最终验证时间：16:57–17:02。

评审工作树：`/private/tmp/cbg-access-reliability`。HEAD：`2559afc4591391fb2cf00217bc85ee6bf04af3c9`。该HEAD不包含本次全部实现；最终已跟踪diff为84文件、2468行新增、905行删除，另有extension/native/server/adapters等新增文件。已跟踪二进制diff的SHA-256：`1acaa354bfe71e42d9cb29f41b77c614ace7d6e8301a5a44def7548f34afdada`。下附19个关键文件hash。核心扩展/host/Input在最终浏览器与协议测试前后比较一致；最后仅controller新增显式拒绝native并发>1，已按新hash复跑针对回归。

结论：本轮发现的12项实现缺陷均已关闭。冻结版本中未发现本次范围内剩余的已确认实现阻塞，可进入PR评审。所列隔离测试通过；没有完成实际Native Messaging安装联调、真实macOS AX/输入/TCC或实站验收，不能将本报告当作P1/P2全部阶段退出条件或端到端零CDP实测证明。

独立性：以空父历史启动，只读设计和当前源码；没有主动读取memories、历史聊天、以前review报告或其它reviewer结论。本报告依据自己的源码核查、命令输出和独立探针。没有修改实现、数据库、服务配置或Git状态。只写本报告与`/private/tmp/cbg-native-review-*.mjs`探针。按clear-writing技能整理文字。

## 1. 实际审查边界

对照`docs/cbg-access-reliability-design-and-review.md`检查OBS-01/02、BRG-01/02/03、DAT-01、NAT-01/02/03、MOD-01，以及相关QRY/ACC停止与事务边界。

- MAIN：实际`main.js`、`market-config.js`的网页对象目录、角色parser数据、fetch/XHR/JSONP旁路及脱敏。
- ISOLATED：实际`isolated.js`、`market-rules.js`、`pet-product-observation.js`的DOM读取、商品身份、语义选择器、节点关联、遮挡与freshness。
- SW：实际sender.id/frameId/tab/origin核验、绑定、导航、限流、持久outbox/ACK/重传和异步停止代次。
- NativeHost：实际`host.mjs`的Native Messaging framing、Unix socket、命令授权、旧proof失效、helper/SW双ACK；安装依赖与固定扩展允许名单。
- Objective-C：实际`Input.m`的TCC预检、前台/锁屏、event tap、紧急停止、AX URL/控件语义/命中、窗口内容区、屏幕/DPR/坐标与CGEvent派发边界。
- 业务：实际角色七主标签、人物/技能、穿戴与仓库、宝宝及子项、版本完整性、partial；装备/宝宝/宝宝装备三市场公共目录、表单、分页、主商品验证、游标与查询ID；controller/session/official-access的正常下一轮、手工恢复、共享停止和模式互斥。

没有用mock NativeCaptureIO或mock market source单独代替全链检查。浏览器测试执行真实扩展脚本文件，但通过模拟页面及stub chrome.runtime工作；它们不证明真实MV3 worlds、TCC、AX或Native Messaging已安装联调成功。上述原生边界同时做了源码检查、协议故障注入及Input编译自检。

## 2. 最终验证结果

| 验证                  | 实际结果                                 | 证据/范围                                                                                                                                                                                      |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15文件纯测试          | **90 tests通过，退出0**                  | 17:01；含真实runtime/query wrapper、bridge receipts、SW outbox、查询/导航关联、三市场源、capture、宿主authority/安装、controller lifecycle和MAIN observer                                      |
| 3文件Chrome模拟测试   | **17 tests通过，退出0**                  | 16:57:25；临时隔离Chrome、全部页面fixture拦截；含实际MAIN/ISOLATED目录与控件、hidden清跨服、折叠技能展开、回调观察                                                                             |
| Input.m系统clang编译  | **通过，退出0**                          | 链接Cocoa/ApplicationServices/IOKit；输出仅`/private/tmp/cbg-input-review-native-final`                                                                                                        |
| Input.m --self-test   | **19 assertions通过，退出0**             | 负坐标、缩放/坐标映射与共用桌面guard/monitor判断；在正常main之前退出，没有投递输入                                                                                                             |
| 实际SW延迟proof探针   | **旧proof被拒绝**                        | `/private/tmp/cbg-native-review-race.mjs`；stop→resume→延迟revalidate返回，old-action收到ok=false；`oldProofEmittedAfterResume=false`                                                          |
| 实际host恢复ACK探针   | **单ACK不激活、拒绝不丢失、双ACK才成功** | `/private/tmp/cbg-native-review-host.mjs`；加载实际host源码，仅替换IO导入为受控模拟，未启动helper；helper和SW任一端单独成功均无成功input-result，helper失败返回ok=false，两个成功才返回ok=true |
| 角色实际DOM探针       | **普通技能分区证据恢复**                 | `/private/tmp/cbg-native-review-dom.mjs`；实际ISOLATED脚本给普通cifu技能输出`data_cbg_skill_section=技能`，计数/空分区证据保留                                                                 |
| 三市场实际DOM目录探针 | **高低内丹可定位、加载/hidden可见**      | `/private/tmp/cbg-native-review-market.mjs`；实际MAIN+ISOLATED文件；MooTools retrieve-only高低内丹均ok=true；LoadingCover使loading=true；hidden user_serverid=33被观察                         |

纯测试完整命令：

```sh
vp test server/adapters/extension-native.test.ts server/adapters/bridge-store.test.ts server/adapters/service-worker.test.ts server/adapters/native-capture.test.ts server/adapters/native-market-controls.test.ts server/adapters/native-market-source.test.ts server/adapters/native-query-health.test.ts server/adapters/native-workflow.test.ts server/adapters/native-navigation-health.test.ts server/adapters/native-query-correlation.test.ts server/native-access.test.ts server/adapters/native-authority.test.ts server/adapters/native-install.test.ts server/crawler/native-lifecycle.test.ts server/adapters/passive-observer.test.ts
```

Chrome命令经沙箱外审批后执行，没有先在受限沙箱启动：

```sh
vp test server/adapters/extension-native.browser.test.ts server/adapters/native-market-controls.browser.test.ts server/query-health/callback-observer.browser.test.ts
```

原生无输入验证命令：

```sh
clang -fobjc-arc -fblocks native/cbg-access/Input.m -o /private/tmp/cbg-input-review-native-final -framework Cocoa -framework ApplicationServices -framework IOKit
/private/tmp/cbg-input-review-native-final --self-test
node /private/tmp/cbg-native-review-race.mjs
node /private/tmp/cbg-native-review-host.mjs
```

中间版本曾出现mock adapter缺status、初绑resume握手测试未同步，以及crossServerFields导出遗漏；最终上述90+17 tests均重新通过，不把中间失败当成最终开放缺陷。

## 3. 十二项发现的最终状态

历史严重性表示发现时的影响；所有项最终均为**已修复并复验关闭**。

| ID / 原严重性 | 需求                   | 可重现场景与原缺陷                                                                | 冻结版本代码证据                                                                                                                           | 最终验证                                                                                     |
| ------------- | ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| RN-01 / P1    | BRG-03、NAT-01/02      | revalidate延迟→停止→恢复→旧proof返回；原SW/host可能分发旧unknown动作              | SW `service-worker.js:171`异步assertCurrent；`command-authority.mjs:2`本地代次；host stop清pending；Input检查host/stop/session代次         | 实际SW延迟探针旧proof=false；CommandAuthority故障测试及编译通过                              |
| RN-02 / P1    | NAT-01                 | event tap被系统禁用后，原tapReady仍true，resume清抢占状态而失去用户监控           | `Input.m:34`真实CGEventTapIsEnabled；`:701`disabled撤销active；`:853`禁用tap拒绝resume                                                     | 共用monitor/guard自检19断言及clang通过；真实系统tap禁用未触发                                |
| RN-03 / P1    | OBS-01、DAT-01、QRY-01 | beginListing生成queryId后，raw.prepare再次随机重置；需排序prepare无法关联结果     | `native-query-health.ts:90/:414`动作前beginListing；`extension-native.ts:1314`raw.prepare不再重置ID                                        | native-query-correlation/native-navigation-health实际wrapper与计划构造测试通过               |
| RN-04 / P1    | NAT-01/03              | 正常完成或时限结束被无条件stop，后续计划轮次无法自动安全开始                      | `controller.ts:408/:500`接resumeForRun/finishRun；`extension-native.ts:1205/:1220`区分idle与人工/风险/unknown停止                          | native-lifecycle和runtime两轮/时限/禁止unknown自动恢复测试通过                               |
| RN-05 / P1    | OBS-01、DAT-01         | 普通cifu技能缺DOM分区，compact记unknown，采集可complete但宝宝报价全拒绝           | `isolated.js:276`按可见分区生成data_cbg_skill_section，保留conditional/future差异                                                          | 实际DOM探针普通技能section=技能；Chrome技能分区用例通过                                      |
| RN-06 / P2    | OBS-01、DAT-01         | 角色穿戴槽等级仅存在AllEquip.obj_level，原native未迁移身份/型号/描述核验补全      | `main.js:422`受限wornEquipment；`isolated.js:468`传输；`native-capture.ts:78`共享mergeWornEquipmentLevel                                   | 非空穿戴AllEquip等级测试与现有完整性门槛通过；身份/型号/描述冲突不放宽                       |
| RN-07 / P1    | BRG-01、NAT-03         | 高低内丹li值只有MooTools retrieve，原MAIN名单漏panel，ISOLATED无值                | `main.js:262/263`纳入两panel；market-rules仍按独立DOM节点属性/标签关联值                                                                   | 实际MAIN+ISOLATED probe高低内丹均ok=true；Chrome用例通过                                     |
| RN-08 / P2    | NAT-03                 | 宝宝技能默认折叠，原语义协议没有#btn_all_skill展开前置                            | `native-market-actions.ts:222`有限market-expand；`market-rules.js:211`固定按钮规则；SW/Input白名单；runtime核验expanded                    | 实际Chrome折叠技能展开→准备目标用例通过；没有任意ID/脚本控制入口                             |
| RN-09 / P1    | OBS-01、DAT-01、BRG-01 | 角色排序先改QueryArgs后等LoadingCover，旧rows可能误作新查询成功                   | `isolated.js:401`与旧通路对齐LoadingCover/LoadingImg/loading_img                                                                           | 实际DOM探针及Chrome加载/条件验证；新导航/结果关联测试通过                                    |
| RN-10 / P2    | NAT-01、MOD-01         | 生产未传accessReady，idle自动握手可能与共享暂停状态不一致                         | `native-access.ts:36`注入governor.state===ready；runtime自动启用各阶段重查                                                                 | runtime/lifecycle/共享工作流纯测试通过，普通runAction仍走相同闸门                            |
| RN-11 / P1    | NAT-03、DAT-01         | 用上次CurSearchValue条件确认清跨服；初始hidden旧服被空集every跳过，或清空后误超时 | `market-rules.js:10/:707`crossServerFields定义并导出；`isolated.js:320`实际hidden formValues；`extension-native.ts:656/:839`按真实字段确认 | 初始conditions={}及含旧cross_buy两种实际Chrome用例均通过；secret hidden不外传                |
| RN-12 / P1    | NAT-01、BRG-03         | 原host恢复只等SW ACK，helper resume的失败因无actionId被丢弃，可能误认原生已恢复   | `host.mjs:45/:70/:193`汇合helper与SW ACK；`:161`actionId贯通；`command-authority.mjs:88`同代次双ACK barrier                                | 实际host源码探针确认任一单ACK不成功、helper拒绝传递、双ACK才成功；正式authority/安装测试通过 |

安装边界同时复验：host新增command-authority依赖已进入统一HOST_FILES安装/卸载清单，固定扩展ID manifest测试通过；没有运行真实安装，也没有修改用户Library目录。

## 4. 需求与证据级别

| 需求   | 本轮结论                                                                         | 尚未由本轮证明的范围                                                                       |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| OBS-01 | 代码边界齐全，所列纯数据/实际脚本隔离场景通过                                    | 全量非空角色离线fixture在旧/新完整链下逐项一致的独立端到端报告                             |
| OBS-02 | MAIN幂等包装、回调this/参数/异常/次数/清理及实际回调模拟通过                     | 允许会话中的官网版本兼容观察                                                               |
| BRG-01 | MAIN/ISOLATED/SW/host链路及当前公共目录/控件修正已核查                           | 真正安装扩展后的MV3 worlds/CSP/Native Messaging联调                                        |
| BRG-02 | sender/frame/tab/origin/限流及独立DOM/AX语义代码已核查，模拟拒绝场景通过         | 不同Chrome/macOS的真实AX节点、控件名称和命中可用性                                         |
| BRG-03 | outbox/receipt/序号/ACK、旧命令fence、恢复双ACK隔离验证通过                      | 实际Chrome SW挂起/真实host崩溃重启联调                                                     |
| DAT-01 | 七主标签、装备/宝宝/原档等级与共享完整性/事务入口已核查，针对发现的回归通过      | 完整真实角色资产链的隔离OS输入验收与实站观察                                               |
| NAT-01 | 权限/前台/锁屏/event tap/紧急停止/两阶段恢复代码与无输入自检、协议故障验证通过   | 真实TCC权限缺失、锁屏、用户抢占、tap失效和异常退出的OS测试                                 |
| NAT-02 | 1.5秒proof、节点命中、AX/窗口内容区/DPR/屏幕转换及未知不重放已核查               | Retina多屏负坐标、侧栏/公告/滚动、遮挡、部分真实输入结果的OS验证                           |
| NAT-03 | 角色/分页/详情、三市场表单/目录/主商品与有限展开路径已核查，无暗用goto/CDP回退   | 首次角色列表目前要求人工完成登录/查询并绑定；缺原生入口明确unsupported；OS端到端兼容待验证 |
| MOD-01 | 显式模式、工作流串行、忙碌切换拒绝、native模式getBrowser报错及共享停止代码已核查 | 真正安装配置下的完整切换与读取侧协议审计                                                   |
| REL-01 | 实验状态与安装限制保留；本报告区分代码/模拟/真实证据                             | 未执行真实安装、生产数据库迁移/回退或全部项目回归；不借其它review结论补本报告证据          |

阶段结论：本次确认的代码缺陷已闭合；PR可描述为“实现完成，所列隔离验证通过”。P1/P2整体阶段验收和实站兼容仍须按设计补齐对应证据。本报告未观察实际官网，不作长期成功率、安全阈值或“不会被识别”的承诺。

最后维护变更复验：native-market-source历史遍历改为array.slice()仍保留数组快照；Playwright适配器关闭Set直接遍历。`vp test server/adapters/native-market-source.test.ts server/crawler/native-lifecycle.test.ts server/adapters/playwright.test.ts`共14 tests通过。native模式显式拒绝concurrency>1的新增lifecycle用例通过，不再静默覆盖配置。

## 5. 冻结版本关键文件SHA-256

以下清单由本reviewer直接计算；controller最后并发约束变更已纳入，相关回归通过，其余核心文件与17个浏览器/协议验证版本一致。路径相对评审工作树。

```text
a0c54e5d362a3d967b7e92214d9c5003dbcc0ba96cf0517e6d47a432e6829245  extension/cbg-access/isolated.js
20c33589226a9b8218a4985387a1e1c6e8690fbbb9ca3acc5b77508efc8d4e41  extension/cbg-access/main.js
a2c11c2bee12fdc7957cdd91f5bfab42dd1be11b10a09093f80734e559a0dedf  extension/cbg-access/market-config.js
d762bb2138b662875bbaf69c8a983a7bb18b02c6c8b2dd35d4408e87a969f790  extension/cbg-access/market-rules.js
ef3ad8d17c06ca14dbda510e6a3c2fe24197f48c80c4aa1d77928838658691cc  extension/cbg-access/pet-product-observation.js
418222f51c13ea01eab7b0612bd548d93d550d39e6973485515b2274a7a57975  extension/cbg-access/service-worker.js
b9c7385a774a7ff595e0b8f565646966b2734fa55a33f2720b8717cf7289816e  native/cbg-access/command-authority.mjs
a719794741440c19e91d988428e841b08a1e59ec7de387d92a7d2c5d8a08798f  native/cbg-access/host.mjs
b85e779c3add6ca7db267319946a52ae5ba2ebf15f0cce8ea8e5e23f9c2bd351  native/cbg-access/install-plan.mjs
c9ab9e4a6c9076528247322d2710ead2e0b28537805da525e5fd1e8e9a559e3f  native/cbg-access/install.mjs
2e91515e71a2c017647cd1b173bf3f0ab9a3163640a7fb02610acebdd8986bea  native/cbg-access/Input.m
4ec5aa4f4943c993e257ff997092051f76b44cac75344868ae986ceb62963e74  server/adapters/extension-native.ts
7097ea4d30396a0949fae065a3fa51c634e9ed60b938f493036eaa5828bedac3  server/adapters/native-capture.ts
d3a4c15e547eb79b4a78acac0dcc0152f54d6a719616861526c5d0aaf3f54986  server/adapters/native-market-source.ts
e6e2f2404ba4da03a106f8de6f21b539639bd383cc30cf78a401e8e976672373  server/adapters/native-market-actions.ts
57e20b4167e654464d2cdb1a8b9cd3a3e342acd5b470bfe13bd2ac34f3f6e499  server/adapters/native-query-health.ts
96169f62b0fb9edea0c4758d768468a78db6c8980b62b57bc7e145d6b54a1dc4  server/native-access.ts
f1453fa98b4a68a4ee3a3dc6c32bcd30c9c3e6e5cf92cd9a7477198015f1022b  server/crawler/controller.ts
3edc54fe781ca221c85a7abbfb2b2e1bf10831b966fafd86d1f5fe1d156ddd6f  server/official-access.ts
```

本报告可复制到`docs/reviews/`。复制行为本身不改变本报告的实站/原生OS证据级别。
