# PR #77 六项改进交付记录

基线：`cae224916d5f7d2e4114f078d20ed1477744ecd6`。本轮按六个可独立评审的提交交付，继续更新现有 PR #77，不合并、不强推，不改动真实采集数据库或持久 Chrome 配置。

## 本轮范围调整

2026-11-16，用户明确由自己保持电脑唤醒，取消自动防休眠需求。最终实现移除 IOPM 断言和执行/等待期的防休眠维持，活动 ACK 改为 `active`，只表示输入授权有效。保留活动身份、授权代次、有效期、业务进度和停止围栏；取消、暂停、断连、过期、锁屏、显示器不可用及用户抢占仍停止输入。以下第1提交记录原始实现，第6提交按新要求完成简化；历史 IOPM 实测不再作为交付门槛。

## 代码与提交

| 项目                  | 提交        | 实现及证据边界                                                                                                                                                                                                                                |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 活动工作流生命周期 | `83a0e80`   | 原提交实现活动ID/授权代次/有效期与防休眠；第6提交按用户新要求删除防休眠，保留先取得有效活动授权再输入及所有停止、过期、前台/权限/显示器/抢占检查。                                                                                            |
| 2. 查询诊断和暂停原因 | `4fa8e0f`   | 盘点服务器/服龄、价格和等级控件，按真实边界校验；保留未知键不支持。结构化保存关闭、不支持、无基线、恢复失败和下一步。诊断与普通查询游标隔离，恢复条件/排序/页码，Canary非空仍人工核验。                                                       |
| 3. 内部详情根         | `51f1197`   | 保留根及公开原文节点身份；移除详情root/index/pet DOM打标；人物、装备、宝宝、估值与版本读取均限定在绑定详情范围。第5提交补叶节点身份检查，重排/替换停止并保留partial。                                                                         |
| 4. 观察端生命周期     | `81593d8`   | 同快照去重和通知合并，按绑定/导航启停，配置入口与重复安装/清理保留。网站options/receiver/参数/返回/异常/回调次数回归；旧异步结果不能复活/停止新绑定，当前扩展停止释放Native活动。                                                             |
| 5. 字段覆盖与按需读取 | `3eba49b`   | 先建[字段表](./detail-field-coverage.md)，再以同一完整非空离线账本核对真实PW与MAIN/ISOLATED+Native采集；技能完整字段用已有属性，角色/宝宝装备仍按需提示框。逐字段来源、商品和源版本、unknown/显式空分开，采集版本升10；原文异常保留已读资料。 |
| 6. 集成与实机验收     | 本轮第6提交 | 按最新要求移除自动防休眠；补等价服龄、host退出/启动屏障、权限布尔协议、字段/源版本完整性、集合变动partial和旧port隔离；集成与实机范围见下文。                                                                                                 |

默认保留首次查询由用户在绑定页面人工操作、未知UI动作明确unsupported、Canary后人工核验。高斯轨迹与无业务目的随机浏览未纳入实现。

## 独立review闭合

三个子agent以空父聊天启动，不读取记忆或旧review；一位负责实现，两位独立审查。确认并修复了：扩展停止未终止活动、服龄集合顺序不一致、叶位置路径导致漏第二只宝宝、raw getter/序列化丢partial、装备最小属性不足却跳提示框、fixture模型误分类、辅助生活技能覆盖/等级缺口、来源误标、空白或加载提示假完整、同名仓库装备串读、最终补齐字段未进入来源表、host退出和helper就绪竞态，以及实机暴露的权限布尔协议与绑定观察过渡帧。见[独立审查记录](./reviews/cbg-pr77-six-step-review.md)。

## 已执行验证

| 层次                | 实际结果                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第1独立提交快照     | 类型检查与81项纯测试通过；helper编译与当时26项无输入自检通过。                                                                                                                                                                                                                                                                                                                        |
| 第2独立提交快照     | 类型检查与81项纯测试通过；7项跨层诊断/授权回归通过；helper自检增至34项。                                                                                                                                                                                                                                                                                                              |
| 第3独立提交快照     | 类型检查及47项隔离Chrome范围/估值/原文异常回归通过；crawl-regression5阶段通过。                                                                                                                                                                                                                                                                                                       |
| 第4独立提交快照     | 类型检查及55项纯测试通过；36项隔离Chrome观察/查询/控件回归通过。                                                                                                                                                                                                                                                                                                                      |
| 第5独立提交快照     | 类型检查、158项纯测试、6项完整账本/原文partial隔离Chrome回归通过。                                                                                                                                                                                                                                                                                                                    |
| 独立采集复核        | 原始重排/替换真实viewport探针2/2及叶回归10/10通过；readiness/native/source独立纯测试80/80通过。                                                                                                                                                                                                                                                                                       |
| Native启动/退出修复 | 相关12文件114项纯测试通过；另一reviewer独立运行新8项通过；正常helper编译及34项无输入自检通过。                                                                                                                                                                                                                                                                                        |
| 实机发现的就绪竞态  | 恢复观察时未收到当前代次MAIN render的帧现明确为unknown/loading、无listing或认证结论，避免空服龄毒化协议队列；真正render的非法服龄继续由未修改的严格解码拒绝。定向34项纯测试与4项隔离Chrome回归通过。                                                                                                                                                                                  |
| UI与截图            | 真实本地构建、模拟API，access-settings端到端1/1通过，截图展示恢复失败、字段和下一步，人工按钮不会自动放行。                                                                                                                                                                                                                                                                           |
| 最终legacy采集回归  | 冻结代码的最终复验日志`/tmp/cbg-six-legacy-final-verified.log`为5/5阶段PASS：七标签/子页及8宝宝采集并入库、断点复跑跳过、共享容器宝宝边界、隐藏/提示框/预览图排除及数量歧义拒绝、缺标签/安全验证停止。保留complete=3、字段/特技及隐私/通用功效排除断言，核对10次准确装备提示框读取与同商品源哈希前后一致；仅适配旧fixture展示、身份和坐骑原文，不改生产完整性门槛。                   |
| 静态与构建          | 最终`/tmp/cbg-six-final-check-verified.log`记录`vp check` 0错误、29条原有warning；`/tmp/cbg-six-final-build-verified.log`记录构建通过。                                                                                                                                                                                                                                               |
| 历史首轮全量        | 首跑199文件、3504项：197文件通过，3483项通过、21项失败；detail148项全部通过。失败仅两份旧fixture未提供v10来源或精确对象缺新增来源字段，保留原断言适配后2文件52/52复验通过；生产代码未为这些失败改动。未将复验计数伪作首跑全绿。                                                                                                                                                       |
| 实际安装只读链路    | 实际Chrome157.0.8103.79、正常编译helper、临时profile真实扩展安装/MV3/MAIN/ISOLATED/toolbar快照通过；最终原始记录证明快照实际经MAIN→ISOLATED→SW→NativeMessaging host到Unix socket（非仅SW outbox）；NativeMessaging实际连接3个宿主进程，端口终止后新进程通过。helper三次真实input-monitor-startup-failed均拒绝并停止，未发OS输入。结果passed-read-only-scope；明确不代表完整实机验收。 |

以上定向计数有重叠，不相加。Chrome测试均按AGENTS在沙箱外批准运行，并使用临时隔离配置与离线页面。launcher PATH使用Node25.8.2以避开系统Node18，vp测试工具链实际为其managed Node26.13.1。

实装脚本、正常helper哈希/唯一临时config替换、实际进程PID、拒绝消息、截图和未验项由 result.json 记录。可公开复核的实际断言、运输快照与源码哈希见[只读实装证据](./evidence/cbg-native-readonly-2026-11-15.json)。本机只读成功目录 `/private/tmp/cbg-installed-rkOWuq/`；首次因 Chrome要求tab target而使用page target导致的脚本失败保留在 `/private/tmp/cbg-installed-KFym0t/`，修正测试协议目标后重跑成功，生产逻辑未因此改动。可复现步骤见 [真实安装验收说明](./native-installed-integration.md)。

最终冻结代码（C `9f32949c`、Runtime `e407714d`）全量为**203个文件、3641/3641通过，0失败、0跳过**，621.07秒；原始报告`/tmp/cbg-six-release-complete-final.json`。修复前200文件3590/3590、616.21秒及其并行首跑3589通过/1项登录用例原5秒超时、原限4/4复验均保留为历史；更早3587/3508与首轮3483/21也不冒作最新结果。原断言和时限未为求绿修改。逐文件结果与报告哈希见[最终全量证据](./evidence/cbg-final-regression-2026-11-16.json)。

## 实机与官网范围

| 范围               | 已有证据与未完成项                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码与review       | 前五项实现及全部已确认review代码问题已闭合。第6项已交付集成与实机脚本；带显式只读AX setup的离线输入/等待/结束/取消及两项fault-only已通过，默认冷启动及其余物理范围未补齐，不据此宣称goal完成。                                                                                                                                                        |
| 字段和归档完整性   | 化圣、现金、存银、储备金、仙玉逐字段校验；缺失/非法不补0，合法0保留。保存与复用实时重验数值、唯一observed子路径、目标商品和相等64hex源版本，不信归档issues=[]或汇总对象。独立196项纯测试通过。                                                                                                                                                        |
| 背压与范围变化     | 消息过大/队列满在存储或页面等待前关闭Native连接；旧port回复和ACK不能影响新绑定，19项纯测试通过。集合新增、替换或标题变化停止；宝宝B失稳时顶层partial保留A属性与装备，20项隔离Chrome回归通过。                                                                                                                                                         |
| 实际权限与空闲     | 用户最终添加并开启确切managed Node26.13.1后，真实Chrome→NativeMessaging→host→helper链的Accessibility、InputMonitoring、monitor、前台和显示器均通过。ScreenRecording仍false，非本次输入前提。早期AX=false记录保留，不当作当前状态；当前代码不再报告或申请防休眠断言。                                                                                  |
| 单屏与AX           | 本机只有内建Retina。CGDisplayPixelsWide给出逻辑1440，而当前mode物理2880/逻辑1440，已修正倍率来源；非0旋转明确unsupported。实际ChromeDPR2/scale1已观察。只读应用AXRole前四次无WebArea、之后立即唯一URL命中，补标准只读握手；没有写AX属性或强开flag。                                                                                                   |
| 活动与抢占实机     | 历史无业务输入诊断在活动后捕获type5鼠标事件并停止；另一次捕获type10键盘事件。来源PID0不能认定人为或自动，安全检查未放宽。旧IOPM持有/释放仅是已取消需求的历史证据。当前仅用内建触控板。                                                                                                                                                                |
| 当前输入与故障验收 | `ofKH5m`在显式只读AX预检setup下，以stock C9f+Runtimee407通过原输入、等待、heartbeat、正常end和取消全部断言；3动作proof/helper/DB均completed，helper17255退出。该setup现可用`--ax-preflight`复现，不证明默认冷启动或官网。既有断连/重启仅字段完成后active等待期fault-only通过；expiry `RV6KYg`已失败，独立helper过期验收NOT PASS。受控物理接管仍未验。 |
| 实际多屏与锁屏     | 用户明确没有第二屏，物理多屏、负坐标、跨屏缩放和显示器断连待硬件。用户明确本轮先不锁屏，实际锁屏停止验收延期；单元guard和模拟坐标不代替实机。                                                                                                                                                                                                         |
| 官网已观察         | 本轮未访问真实官网、登录、首次人工查询或真实采集；官网origin请求均为隔离route fixture。首次查询仍由用户人工操作。                                                                                                                                                                                                                                     |

只读安装链路见[只读实装证据](./evidence/cbg-native-readonly-2026-11-15.json)，早期权限记录见[直接helper预检](./evidence/cbg-native-permission-preflight-2026-11-15.json)及[早期实际宿主尝试](./evidence/cbg-native-os-attempts-2026-11-15.json)。后续AX、活动及抢占的选定原始字段与结果哈希见[单屏实机收证](./evidence/cbg-native-live-2026-11-16.json)。

实机复现见[真实OS说明](./native-os-integration.md)与[故障及只读诊断场景](./native-os-fault-scenarios.md)。系统设置只读UI核验曾因ScreenCaptureKit `-3811`失败，未观察或修改权限设置；没有通过reset、忽略抢占或清空unknown来推进。

本轮goal保持active：默认冷启动、来源未解事件、受控物理接管、多屏硬件及延期锁屏等范围没有被离线通过或代码测试替代。高斯轨迹与无业务目的随机浏览继续为可选实验。

## 防休眠简化后的收尾验证

两位独立审查者确认没有移除活动授权与安全停止围栏。Reviewer B独立9个纯测试文件106/106通过；实现者另一组9文件109/109通过（范围有重叠）。默认沙箱的真实CGEvent对象创建不可用，最初自检失败已保留，不算通过；改为独立`--text-event-self-test`，不可用明确exit2。正常纯逻辑自检55项与抢占14项通过，沙箱外同正常binary的对象自检实际返回flags0、Unicode120、no input posted；B独立编译及对象探针同样通过。

实际安装又暴露两个字段替换问题，均已修复并经两个独立reviewer只读核验：先投递Command+A再立即打字可能晚全选，造成100120；等待后新事件又可能继承Command修饰。现在分页、角色条件和市场文本三入口共同保留原已验证AX节点，正向确认焦点、原值及完整UTF16选区，再发送明确无修饰键的Unicode；空字符串用Delete。读取有700ms单调上限和100ms AX调用超时，原proof/活动有效期不延长，每轮继续检查授权、停止及抢占，失败不重放。

最终单字段实机证据：`7Ft8AB`中价格100→120，actionId `93cb689b-c034-48d7-839e-88599011e47e`的真实SW proof、helper ok/posted、观察快照、Governor和Bridge completed全部匹配。用户明确确认该轮全程没有操作。grant后约3.094秒收到未标记type5鼠标事件，下一query许可取消，活动active=false、lease清空、固定helper95518退出。不能据坐标、PID0或时间推断事件来源或豁免停止；该历史轮basic失败不改写。后续带显式AX setup的成功另见下文；来源未解仍保留。选定字段、失败历史及哈希已附[实机证据](./evidence/cbg-native-live-2026-11-16.json)。

断连`oMeK6u`与宿主重启`pOTZmb`分别通过`passed-real-input-disconnect-only`和`passed-real-input-restart-only`。两次故障均在首个120字段动作已完成、活动仍为active的等待期注入，不是在按键发送中注入。故障撤销活动、stopEpoch推进、旧scope下一动作在proof前拒绝、原helper退出；重启后新host/helper实际连接，但runtime保持stopped、active=false/lease={}，没有申请或通过新的业务授权。这两项fault-only自身不证明按键发送中断连/重启、等待结束/取消、expiry或人工恢复；后来ofKH5m的独立通过范围另记。

已审的两组control记录`a8PxTN`（0 post、0 event）与`931687`（1 post、1 marked event）均有有效的12秒观察期，未复现额外unmarked事件。这只是两个有限对照结果，不能解释或关闭`7Ft8AB`的来源问题。生产`Input.m`仍冻结在SHA256 `9f32949c0e4fe994d118be9fe92d1d829608c915519c57975226bb3f6c4c8d7a`；`/tmp`中的privateSource实验`km8`/`NQV`对照不采纳，不是生产修复或通过证据；来源问题仍未解。goal保持active。

## 最终Runtime修复与stock实机通过范围

`z6VMiu`确认ISOLATED的新DOM提交混入旧MAIN QueryArgs，旧完成谓词把rev7错误写completed；现只对角色query/page冻结实际提交控件与服务器维度，等待完成快照的UI和QueryArgs合法归一后一致才接受。新增36条纯测与1条实际MAIN/ISOLATED浏览器回归；未改原TTL、fixture或断言，未补发业务动作，两位独立reviewer闭合。

`43SYtA`随后完成120字段、query及140字段，却在取消后只读status等待期间遇到在途server-stop通知；现仅该已知通知保留精确纯status pending，等待同actionId真实回复。显式stop、其他请求、其他停止原因、断连与超时仍拒绝，不伪造active=false，不恢复输入授权。新增真实Unix socket14条回归，两位独立reviewer闭合。最终Runtime SHA256为`e407714d4b21ded72ea1d4d54df3d1c96d5f0c3dc6a07eb9fe7ee5db90e97066`；C保持9f不变。

`ofKH5m`的原始结果为`passed-real-input-wait-completion-cancellation-only`：field120、query、field140三个action的SW proof、helper成功posted、观察结果、Governor permit及Bridge命令全部completed；实际页面等待与heartbeat、正常end的active=false/lease={}和主动取消全部原断言通过，固定helper17255退出。运行前进行了显式只读AX预检，现项目`--ax-preflight`可复现该setup；不把这轮结果说成默认冷启动或官网成功。

expiry `RV6KYg`已失败，独立helper过期验收NOT PASS。多屏无硬件、锁屏按用户要求延期、受控物理接管未验；官网首次查询仍由用户人工操作。以上通过不解释`7Ft8AB`无人工操作时的未标记mouse来源，也不使goal完成。

`RV6KYg`实际以`failed-or-blocked`结束（terminal 1）：helper21578在host暂停窗口的85次采样均存活，恢复后真实status为active=false/lease={}。但此前续租回执已超时并由Node发送stop，wire只有server-stop，等待expired原因最终超时。因此不能把inactive归因为helper独立过期，验收明确NOT PASS；cleanup确认helper已退出。没有改断言或伪造结果，不再扩实验；独立helper过期仍是剩余验收缺口。
