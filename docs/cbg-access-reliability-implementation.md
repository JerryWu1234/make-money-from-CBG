# CBG 访问可靠性实现与验收记录

本记录对应 `cbg-access-reliability-design-and-review.md` 的全部 22 项需求。设计文档中的“未实现”是实施前基线；本文件记录本次实现、验证层级和运行边界。日期：2026-11-15（Asia/Shanghai）。

## 实现范围

| 需求 / 用例  | 实现与证据入口                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC-01 / T01 | `server/access/response-classifier.ts`、`crawler/access-guard.ts`、`query-health/callback-observer.ts`：限定业务请求、HTTP/业务拒绝和未知 schema 分类；不将静态资源或 AI 错误当作官网限制。                         |
| ACC-02 / T02 | `official-access.ts`、`native-access.ts`、`crawler/controller.ts` 及三个 `analysis/browser-*-source.ts`：共用同一数据库的站点闸门，覆盖工作流、采集、补采、锚点与市场查询。                                         |
| ACC-03 / T03 | `access/governor.ts`、`crawler/store.ts`、`analysis/store.ts`：SQLite 事务内重新核验站点 stopEpoch、owner fence、业务 crawl lease、页面和查询身份。旧数据只归档，不推进当前资料或进度。                             |
| ACC-04 / T04 | governor 的 Retry-After、恢复票据/CAS；`official-access.ts` 的正向登录与页面核验；原生恢复先收齐 SW/输入宿主确认，再提交共享恢复，最后激活本地输入。                                                                |
| ACC-05 / T05 | 持久 permit 的 reserve/authorize/complete，窗口配额、最小间隔、单动作槽、取消、未知在途、接管、时钟异常保护。授权后消耗不返还；实际业务请求另记账。                                                                 |
| ACC-06 / T06 | `crawler/runner.ts` 的 new/old 配额；并发默认和 API/UI 均支持 1。原生仅支持 1，其他值明确拒绝。首次授权后才开始详情读取时限，重试不重置；超时保留 partial。                                                         |
| CFG-01 / T07 | 版本化 AccessPolicy；`HeadRefreshSettings`/`head-refresh.ts` 保留旧固定/随机语义并支持 min/max；未知版本明确拒绝；更新不清风险或消耗。                                                                              |
| QRY-01 / T08 | `query-health/{store,runtime}.ts`、`crawler/page.ts`：查询预分配身份；数据、身份和健康独立判断；初始提交、翻页、异步响应与接受结果关联。                                                                            |
| QRY-02 / T09 | `crawler/role-list-diagnostic-driver.ts`、`query-health/role-list-diagnostics.ts` 和三个市场源：持久单次目标复核与可选对照；仅用同会话真实基线；持久保存原表单并通过 UI 恢复。                                      |
| QRY-03 / T10 | 采集和市场进度提交均核验 accepted query；unknown/suspect 不推进 checkpoint、水位、backfill、pageReview、cursor、exhausted 或报价。诊断结果不直接成为普通进度。                                                      |
| LOG-01 / T11 | run/query/action/page/generation/session/stopEpoch 关联；`access/redaction.ts` 与 `diagnostics.ts` 对 Cookie、令牌、指纹和敏感 URL 参数脱敏。                                                                       |
| OBS-01 / T12 | `adapters/contracts.ts`、`adapters/playwright.ts`、`adapters/extension-native.ts` 的 UiDriver/PageObserver；纯标签、装备、宝宝、估值快照转换和共享完整性校验。                                                      |
| OBS-02 / T13 | 回调观察保持 this、参数、返回与异常；重复安装、替换、导航和关闭的清理；观察异常不改变网页原回调行为。                                                                                                               |
| BRG-01 / T14 | `extension/cbg-access/` 的 MAIN/ISOLATED/SW；限定域 fetch/XHR/JSONP 和可见页面观察；Native Messaging 宿主经本地 Unix socket 接服务。                                                                                |
| BRG-02 / T15 | sender/origin/frame/tab/window/协议/限额核验；有限语义计划；ISOLATED 独立解析目标，宿主和 AX 再核验，不接收网页任意系统命令或最终坐标。                                                                             |
| BRG-03 / T16 | `adapters/bridge-store.ts` 的持久数据去重/有界缓冲/ACK 重试；连接代次隔离；动作未知不重放。stop/resume 后旧 proof 同时受 SW revision、宿主 generation 和输入进程 epoch 拒绝。                                       |
| DAT-01 / T17 | 新旧通路共用 7 类标签、装备/仓库/宝宝完整性和身份门槛；partial/history 与当前 complete 分开；版本和进度同事务提交。                                                                                                 |
| NAT-01 / T18 | `native/cbg-access/Input.m` 的授权、前台、绑定 Chrome 窗口、锁屏、输入监控与用户抢占检查；有限输入、立即停止、防休眠释放。禁用 event tap 时保持停止。                                                               |
| NAT-02 / T19 | 可见语义节点、矩形时效、视口/DPR/屏幕坐标、遮挡/命中和 AX 角色/名称/范围复核；执行后等待业务证据；部分输入或未知结果停止且不重放。                                                                                  |
| NAT-03 / T20 | 原生列表 query/refresh/next/jump、详情开关/标签、市场表单/查询/分页/详情；跨文档用本地 completed receipt + governor completed permit 验收；owned child 返回 parent 后再刷新。没有可核验 UI 入口时明确 unsupported。 |
| MOD-01 / T21 | `browser-settings.ts`、`session.ts`、API 与浏览器设置 UI：通路互斥；切换不清保护状态；原生读/等/取证/输入无 CDP 依赖；未知已保存通路拒绝隐式回退。                                                                  |
| REL-01 / T22 | 版本化持久 schema、幂等启动、旧配置兼容和未知版本拒绝；本记录、安装说明和独立 review；静态、隔离及实站证据分开报告。                                                                                                |

## 生效的默认策略

| 参数                           | 默认值                                  |
| ------------------------------ | --------------------------------------- |
| 策略 schema / 初始 version     | 1 / 1                                   |
| 最小动作间隔                   | 5 秒                                    |
| 窗口 / 最大动作数 / 同时动作数 | 60 秒 / 12 / 1                          |
| 无服务端时间时的冷却           | 60 秒，结束后仍须人工核验               |
| owner lease / reservation TTL  | 各 120 秒                               |
| 时钟容差 / 最大跳变            | 1 秒 / 300 秒                           |
| 连续 new 任务配额              | 3；随后给可执行 old 任务机会            |
| 每件详情读取预算               | 15 分钟；首次实际派发才开始，重试不重置 |
| 每事件诊断动作上限             | 128，包含表单恢复动作                   |
| Canary / 基线有效期            | 默认关闭 / 30 分钟                      |

这些是项目操作参数，不表示官网认可的访问频率。共享范围是连接同一个 SQLite 文件的本机服务实例；不同数据库或不同机器不会自动共享额度。

## 迁移、安装与回退

新增表和列以版本核验和幂等迁移接入现有数据库，保留商品、历史资料、查询 cursor、配置和停止原因。业务写入必须持有当前租约；旧 worker 即使仍有活的服务 owner，也不能用旧 crawl fence 提交。

原生通路需要手动安装扩展和 Native Messaging 宿主、授予 macOS 权限，再在固定 Chrome 配置绑定当前标签页。完整步骤见 `native/cbg-access/README.md`。本次实现不安装到用户日常环境，不修改真实 Chrome profile，也不启动实际官网采集。

回退前停止官网任务并保留数据库、配置和桥接证据。不能让不理解新闸门/schema 的旧采集器自动接管；未知 schema 或未知通路应停止官网操作。卸载只移除宿主自身文件和注册，不删除登录或采集数据。

## 验证层级

代码测试覆盖状态、事务、配额、回调、数据完整性、协议故障、DOM 语义与业务流程。浏览器测试使用临时隔离 Chrome 和模拟网络页面，并按项目约定在沙箱外执行。原生自检只编译和验证 guard，不投递 OS 输入。

真实官网、实际权限授予、不同 macOS/Chrome 的 AX 行为、屏幕坐标与真实 OS 输入未在本次观察。上述实现及隔离结果不能表述为实站已验证或所有桌面环境均已适配。

以下结果来自本次实际运行，测试数量存在重叠，不相加。

## 最终验证与独立 Review

| 检查                                                                                    | 最终结果                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `vp test --run`                                                                         | 184 文件、3305 项全部通过；退出 0。浏览器测试使用沙箱外临时隔离 Chrome。                                                                 |
| `vp check`                                                                              | 格式通过，0 error；保留原有 `scripts/setup-macos-regression.mjs` 的 29 条 warning，新增代码无 warning。                                  |
| `vp run build`                                                                          | TypeScript 与前端构建通过，退出 0。                                                                                                      |
| `playwright test tests/e2e/access-settings.pw.ts tests/e2e/head-refresh-settings.pw.ts` | 5 项通过；界面排版更新后 access-settings 单独复验 1 项通过并生成 PR 截图。                                                               |
| `playwright test tests/e2e/browser-settings.pw.ts`                                      | 已通过；仅模拟本地接口和页面。                                                                                                           |
| `playwright test tests/e2e/crawl-concurrency.pw.ts`                                     | 7 个场景中先通过 6 个；修正旧 min/step 断言后，剩余配置/暂停/续采场景单独复验通过。                                                      |
| 原生编译与 `--self-test`                                                                | 系统 clang 编译通过，19 项 guard/坐标断言通过；不投递输入。                                                                              |
| 最终 P0 独立复审                                                                        | 18 文件、275 项纯测试及 2 项外部故障回归通过；本轮发现 3 项问题全部修复复验，无剩余已确认阻塞。                                          |
| 最终原生独立复审                                                                        | 15 文件、90 项纯测试及 3 文件、17 项 Chrome 模拟测试通过；本轮 12 项问题全部修复复验。另验证实际 SW 延迟 proof 和 host 双 ACK 故障路径。 |

两名最终 reviewer 均以 `fork_turns: none` 启动，不继承父聊天历史，不读取记忆、旧对话或其他评审报告，依据设计和当前源码独立审查。最终报告见 [P0 与根接线复审](./reviews/cbg-access-p0-final.md) 和 [原生全链复审](./reviews/cbg-access-native-final.md)。早期轮次发现的暂停/业务租约、回调拒绝、诊断恢复、身份与完整性问题也均已修复，并由最终完整回归覆盖。

最终收敛包括：晚到查询不能接受新查询；恢复接口参与模式切换互斥；原生采集及时通知跟随分析；正常结束允许后续新轮次重新核验；跨文档导航需要本地 receipt 与已完成 permit；停止/恢复后旧 proof 无效；恢复需 SW 和输入 helper 双确认；跨服清理依据真实 hidden 表单值；宝宝技能/内丹、折叠控件、穿戴等级和 loading 证据补全。

结论：22 项需求的代码已接入，已确认 review 缺陷已闭合，所列隔离验证通过。实际安装、真实 OS 输入和官网兼容仍属于未观察范围；本记录不将它们记为已验收，也不替代设计要求的 P1/P2 完整实机阶段证据。

## PR #77 后续修复：本次市场提交与回调关联

GitHub 对 `c359830` 的审查指出：同条件再次提交时，旧成功回调可随新 action 快照被误接受。该问题确实存在，初次 3305 项回归未覆盖这个交错。

修复后 MAIN 在请求发出时分配唯一 requestId，固定公共查询参数，并在原回调执行前保存限定商品身份摘要、执行后发布响应；原 this、参数、返回和异常保持。只有正在派发的可信目标点击可关联一次请求，已结束的点击不能被后台刷新或另一次请求复用。

ISOLATED 将请求、响应与本次 action/query 关联。成功响应中的每一行必须具备服务器身份及 eid 或 game_ordersn，并与可见商品链接/订单属性逐项对应；真空结果还必须没有商品行且有空结果标志。DOM revision、滚动、分页文字或容器 class 变化不构成完成证据。相同商品的全新响应可以接受；同步或微任务渲染只在列表身份匹配后接受；旧请求的延迟渲染不能冒领新响应。

服务端再核验 commit 与对应成功业务响应的 requestId/eventId、action/query、开始/完成时间和行数，要求请求开始不早于本次授权派发。没有新响应证据时保持 unknown，不推进 cursor、exhausted 或报价，也不重放未知输入。

兼容性边界：当前确认的是点击事件派发期间同步发起的首个 `ajax_with_recommend` 请求；回调之后的异步 DOM 渲染已覆盖。若网站改为延迟/微任务才发请求、同一次点击先发其他查询，或响应缺少可核验的公共商品身份，通路会保留 unknown 并暂停，不能借用旧点击或旧响应。没有将“微任务渲染通过”表述为“所有异步请求启动路径通过”。

本轮验证（数量有重叠，不相加）：

- MAIN/实际扩展浏览器定向回归：2 文件、35 项通过，覆盖同条件再次提交、旧在途响应、迟到 DOM、同页/翻页/排序、新空结果/拒绝、后台请求、微任务渲染及服务器/订单身份。
- Runtime/MAIN/市场源纯测试：3 文件、30 项通过；Runtime 对提交、分页、排序分别验证旧 receipt、错误事件、失败响应和派发前请求不能完成当前动作。
- 独立 reviewer：未继承父聊天历史、未读取记忆，23 项纯测试和 10 项独立 Chrome 故障探针通过，本轮无剩余已确认阻塞。[独立复核报告](./reviews/cbg-pr77-market-submission-fix.md)。
- 完整回归初跑：3328 项通过，1 项详情测试超过默认 5 秒，另 4 个套件在 Chrome 关闭钩子的默认 10 秒内未结束；均为时限错误。停止并行 Chrome 后，4 套件串行复跑 49 项通过（仅命令行将 hookTimeout 设为 30 秒）；详情单项保留原 5 秒时限复跑通过，未修改断言或测试源码。
- `vp check`：0 error、29 条原有 warning；`vp run build` 通过。

仍未访问真实官网或投递真实 OS 输入。
