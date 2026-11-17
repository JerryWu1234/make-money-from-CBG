# PR #77 六项改进独立审查记录

> 当前OBS-02故障隔离的两位独立复核与204/3683全量见[专项复核](./cbg-observer-callback-isolation-2026-11-17.md)。`56b21a4` 补充真实用户受控Esc与原生keydown撤权对齐，两位独立原始流/DOM/SQLite审计通过，见[本次实机复核](./cbg-physical-takeover-review-2026-11-17.md)。此前63项纯回归仍仅为判据验证；历史记录中的物理未验不覆盖该后续结果，底层生产者、严格因果与来源未解边界仍未关闭。

> **早期后续复核（`98318d6` 历史快照）：** 新原生 AX/过期顺序及独立 stdio 采证实现均通过另两位子 agent 的独立复审，已确认问题全部闭合；新全量 204 文件、3675 项通过，独立记录器 15 项通过。当时新版真实 basic、helper 独立 expiry、等待期断连/重启的 raw/SQLite/身份已分别独立核验。详见[当前补充记录](../native-followup-acceptance-2026-11-17.md)。以下截至 `28baf1a` 的代码哈希、计数、最终/当前字样及 NOT PASS 均按历史版本保留，不能移用于新代码；当时物理未验；来源未解边界仍未关闭。

基线：`cae224916d5f7d2e4114f078d20ed1477744ecd6`。两位 reviewer 以空父对话启动，不读取记忆、旧聊天或其他审查者报告；以下保留初始发现和最终复验，初始失败不代表修复后仍失败。reviewer A 后续参与已确认 Native/F2 缺陷修复，reviewer B 独立复核其最终生产代码及启动生命周期回归。

冻结生产代码中已确认并完成复核的代码缺陷已修复；`7Ft8AB`在用户明确无操作时收到未标记mouse事件，其来源仍未解。纯逻辑、故障注入及模拟页面不等于完整真实输入、物理多屏或官网验收，不能据此宣称goal完成。完整集成与实机范围见 [本轮交付记录](../cbg-pr77-six-step-delivery.md)。

以下初始审查、计数及当时未执行范围按历史快照保留；其中IOPM/awake属于用户后来取消的防休眠要求。当前规范与最终冻结结果见本文末尾，不将初始失败或旧需求误作当前状态。

# Native / 角色诊断 / 扩展观察独立审查

审查者 A，2026-11-15。仅根据 `/private/tmp/cbg-access-reliability` 当前源码、用户目标与自行运行的回归审查；没有读取记忆目录、旧 review 文件或其他 agent 的报告。基线 `cae224916d5f7d2e4114f078d20ed1477744ecd6`，初始 HEAD `51f1197`，包含工作树第 4 步改动；MAIN 用 `/tmp/cbg-step4-main.js` 精确快照核对，随后对当前 worker/runtime 的修复再次验证。未改生产代码，未运行真实浏览器输入或真实持久化采集。

## 发现及复核

### F1 / P1：扩展停止未撤销 Native 活动（已修，复核通过）

扩展按钮停止、关闭绑定标签页或意外导航产生 `status {stopped:true}`。原 runtime 的 status 分支只修改 `stopped/reason`，未调用完整 `stop()`；因此活动信号未 abort、heartbeat 与 workflowActivity 继续存活，也未向 host/helper 发送停止命令。活动等待期间点击停止可能继续持有断言，helper 已获得的输入不能立即由该状态撤销。

初始独立回归三个场景 3/3 失败。实现修复后，worker 对停止状态携带完整 Chrome 绑定身份，runtime 对首次接收且匹配当前连接、页面代次、tab/window 与 bindingEpoch 的状态调用完整 stop。负向验证旧代次、旧 binding、旧 tab、旧 connection 与重复消息不会停止后来的活动。

复核文件：`server/adapters/native-fresh-review-user-stop.test.ts`。8/8 通过；与 `extension-native.test.ts`、`service-worker.test.ts` 合计 47/47 通过。

### F2 / P2：等价服龄集合未统一规范化（已修复，见最终复核）

`queryIdentityHash` 已对 `serverAge` 与逗号集合条件排序，但 `QueryHealthStore.broadBaseline` 对 `candidate.serverAge` 和条件值采用原字符串相等（`server/query-health/store.ts` 中 broadBaseline）。Native 的 `listIdentity` 直接读取实际 QueryArgs，不保证字符串顺序恒定。

可复现：保存近期、同会话、同服务器、同排序的普通非空角色宽条件基线 `serverAge/server_type=1,2,3`；目标条件为同集合 `3,1,2` 加 `price_min=100`。`broadBaseline()` 错误返回 undefined，导致 `no_valid_baseline`。

此外 `createRoleListDiagnostic` 的 validate 直接比较 `identity.serverAge !== saved.serverAge`（`server/query-health/role-list-diagnostics.ts`）。即使基线查询规范化修复，原目标 `3,1,2` 与合法 Canary `1,2,3` 仍被拒绝为 unsupported_condition；其 `server_type` 比较却已经集合规范化，形成同一模块内部不一致。

独立回归文件：`server/query-health/native-fresh-query-baseline.test.ts`。保存基线与执行诊断两条正向回归在初始快照中 2/2 失败。当时建议统一服龄集合比较，并维持真正换服龄的负向隔离；不需要放宽服务器、会话或查询身份。

## 已逐层核对的接入（初始防休眠版本，历史）

- 活动作用域确实覆盖 `native-query-health` 的列表 prepare/page/refresh、详情/hover/onShelf，以及 `native-market-source` 的 discover/find 工作流；`withNativeWorkflow` 使用 AsyncLocalStorage 保留当前 governor context/crawl lease，串行化选定原生页。
- runtime 先请求 activity begin 并验证 `ok/awake/activityId`，才执行 governor 授权及实际输入；活动有 activityId、authorizationEpoch、stopEpoch、browserSessionEpoch、TTL、进度截止与进度序号。
- host 在接受计划及实际派发 proof 两处校验活动；helper 独立持有 IOPM assertion，ACK 真实 assertion 创建结果；helper 以单调时间检查续期与业务进度期限，100ms watchdog 校验权限、锁屏、前台与显示器状态。service 或 host 挂起不能仅靠旧心跳维持断言。
- 结束、取消、断连、过期与诊断切换的清理、晚到旧 activity invalidation 与旧 end 的 fencing 已核对源码及相关测试；idle/bound 不申请 assertion。
- native-access 的 runAction 真实接入 AccessGovernor，诊断目的只能在匹配 page/generation/session/stopEpoch 的 workflow context 中进入；非 ready 下跨页/无匹配 scope 的动作拒绝。动作预算和持久化 claim 在 dispatch 前消费，诊断结果不标 accepted，原游标仅存事件快照。
- 角色诊断从公开 QueryArgs、可见合法控件和服务器/服龄 UI 维度读取；未知键显式 unsupported，保存实际原条件/表单/约束/排序/页码/revision。正常空结果继续、与同条件近期非空基线冲突的空结果冻结；Canary 非空仍要求人工。
- MAIN/ISOLATED 默认休眠，bind 启用，stop/unbind/pagehide 清理 hook、observer、timer 与未完成读取，token/readSequence/url 隔离晚到结果。相同 render/snapshot 合并并保留有界新鲜心跳。公开配置通过单一入口和有时限缓存读取。
- ajax 包装保持原 options/data、receiver、参数、返回、异常、回调次数；仅对支持的自有数据属性安装，首 terminal callback 恢复描述符，teardown 不覆盖网站之后的替换。复用 options 不冒认新的 requestId。现有固定回归继续要求新 request、新 callback 与对应商品 DOM 一致。

## 本次实际验证

- 初始独立运行 11 个纯测试文件、100/100 通过：native activity / host activity / workflow / diagnostic authority / passive observer / service worker / role diagnostics / query runtime / query store / native query health / UI。
- F1 修复后相关 3 文件、47/47 通过（包含独立新增 8 项）。
- 随后对最新工作树汇总复测 14 个相关纯测试文件，145/145 通过（增加完整 extension-native、observer-activation 与独立停止状态回归）。此计数不含 F2 的两条失败用例。
- 两个额外 worker VM 探针通过：意外导航旧 unbind ACK 晚于新 user bind，以及旧 toolbar bind ACK 晚于 Native stop；脚本 `/tmp/cbg-native-worker-fresh-probe.cjs`，结果保持新绑定或停止状态。
- 当前 `Input.m` 在本机以 clang、Cocoa/ApplicationServices/IOKit 成功编译为 `/private/tmp/cbg-native-fresh-review-input`；仅执行 `--self-test`，34 assertions 通过，明确 `no input posted`。此项属于本机编译与纯逻辑自检，不证明实际权限或桌面输入。
- F2 初始独立新增 2 项失败；后续修复及交叉复核见下一节。

纯测试/VM 并非真实 Native Messaging/TCC/AX 输入证明。真实锁屏、显示器不可用、用户抢占、host restart、IOPM assertion 实际生命周期与 Chrome AX 行为仍待第 6 步在隔离实机验收；本审查没有将 VM 或 helper 自检计作实机通过。

## Reviewer A 最终修复与交叉复核

F2 已使用现有集合归一化方法修复：同服龄不同顺序可查询基线和诊断，真正不同集合仍拒绝；相关6文件55项纯测试通过。另确认并修复 host 未关闭 stdin 导致进程不能自然退出、helper event tap 尚未初始化便宣布 ready 两个问题。新增8项进程/同源码编译故障注入测试；相关12文件114项纯测试和34项无输入 helper 自检通过。reviewer B 独立读取最终 host/Input.m/测试代码并运行8项新回归通过，无本轮剩余阻断发现。

# Independent reviewer B: capture scope and field preservation

Reviewed directly from repository source, without memory, previous review reports, or other agents' reports. Production files were not edited. Baseline: `cae224916d5f7d2e4114f078d20ed1477744ecd6`; step 3 commit: `51f1197218c7ac4cb42da8d2fa1121e155be8180`. The step 5 working tree was explicitly unfinished during this first pass.

## Step 3

- Internal root/document identity, bound public textarea identity, and scoped selectors are present. Root replacement, document navigation and source replacement have explicit incomplete guards. No added DOM markers were found in the migrated production paths.
- **P1 confirmed in isolated Chrome: positional leaf identity regression.** `detail.ts:166-202,254` captures positional paths, and `pets.ts:83-95,127` captures positional entry paths; only the root and textarea retain actual node identity. A list rebuilt or reordered inside the same root can replace every leaf while every old positional path still resolves exactly once. Using the committed `collectPets`, `detail-root` and `petCaptureSummary` from a clean `git archive 51f1197`, a two-pet fixture rebuilt `[A,B]` as `[B,A]` after first selection. Actual clicks were `[A,A]`, captured pets were `[宝宝A,宝宝A]`, expected count remained 2, and `petCaptureSummary` returned `complete=true, issues=[]`; B was omitted. Encoded role/config source revisions do not hash the changing DOM. Original markers would normally disappear on an `innerHTML` replacement and cause failure. Freeze leaf handles or verify independently retained leaf identity. Repro: `/tmp/cbg-step3-independent-review.mjs`.
- **Confirmed existing limitation, not classified as introduced:** final raw archive accesses `globals[key]` outside a catch and wraps serialization failure as ordinary `Error` (`detail.ts:899-904` in commit). The collector only preserves already read tabs for selected error names (`948-956`). In independent isolated Chrome, both a throwing `RoleInfo` getter and throwing `RoleInfo.toJSON` reached the final archive after seven tabs, then returned ordinary `Error` with `hasPartial=false`. Parent reports a new controlled parse-issue/cause patch, pending re-review.

## Step 5 findings at initial unfinished snapshot

1. **Confirmed: minimal stat evidence is not field equality.** `item-read-policy.ts:19,22-42` skips hover for equipment description `等级：100#r伤害：420`; the actual tooltip can additionally contain `命中：500`. An independent pure-function repro in `/tmp/cbg-field-policy-review.cjs` with model 7001 produced `actionSkipped=true`, equipment `complete=true`, `issues=[]`, but different recorded/tooltip descriptions. The initial policy unit test deliberately treated this description as complete. This does not prove every required field is available from the existing source.
2. **Confirmed: fixture equipment models were materials.** Initial `complete-role.mjs:18,26` used 4001 and 4002 for weapon/helmet, but `compact.ts:87-88` maps them to 百炼精铁 and 太阳石. Initial ledger assertions checked names and locations but omitted classification. The synthetic success could therefore avoid the role-equipment completeness path it was supposed to cover.
3. **Confirmed: auxiliary/life skill equivalence was untested.** Initial fixture had seven school icons, one life-skill text row, no auxiliary skills. Initial `assets()` compared skill items only and omitted auxiliary/life text. Parent confirmed these will be made nonempty and explicitly asserted.
4. **In progress, not final defect:** initial `sourceEvidence` was a capture envelope only, and coverage table was group-level. Parent confirmed per-field provenance and missing-state records will be added before final review.
5. **Found during the new provenance implementation:** `field-evidence.ts` inferred description provenance from `item.tooltip`, but the Playwright collector did not set that property after a normal known-name tooltip read. Most actual tooltip descriptions would therefore be mislabeled as element attributes. Worn levels merged from the official parser were also labeled as element attributes. Parent notified to retain provenance at read time.
6. **Coverage contract still needs a defined required set:** generic enumeration of only present fields cannot record an absent required field, and readiness did not yet consume required `unknown` evidence. An empty/unloaded appearance/home content panel can be visited while none of its fields are recorded. Parent notified to distinguish explicit empty from missing under the field coverage contract.

## Independent validation executed

- `vp test server/crawler/item-read-policy.test.ts`: 1 file / 5 tests passed. These assertions expose the policy boundary above, not complete equivalence.
- Pure-function adversarial repro: `/tmp/cbg-field-policy-review.cjs`, successful; no Chrome involved.
- Directly invoking `node_modules/.bin/vp` initially failed with the shell's Node 18 extensionless-file error; the configured `vp` launcher ran successfully afterward. This is a runner invocation issue, not a product failure.
- With parent-coordinated exclusive Chrome access and `require_escalated`, a separate clean `git archive 51f1197` snapshot ran three offline cases: pet reorder, raw getter, raw serializer. All three exposed the boundaries described above. The pet component used real collector/root/summary modules and simple Playwright locator hover/click stubs for the viewport wrapper; browser-evidence capture was disabled to avoid production output. Browser and temporary profile were closed/deleted in `finally`. No real website, real profile, native OS mouse action, authenticated collection, or real-device validation was run by this reviewer.

## Follow-up review after fixes

The parent fixed the positional leaf issue by retaining discovered actual element handles and checking their document/root/path identity before and after interactions. I statically reviewed those guards and later independently reran the final isolated Chrome probes described below. Raw getter/serializer failures now become controlled incomplete errors with causes while preserving earlier data.

The parent also restored on-demand role/pet equipment tooltips, corrected fixture models and categories, added nonempty auxiliary/life skills, preserved actual item provenance, introduced mandatory body evidence for mounts/appearance/home, and upgraded capture version 9 to 10. New complete captures must include the source evidence envelope; old version 9 and missing-envelope cases are independently rejected.

I added `server/crawler/field-evidence-review.test.ts` with 22 independent pure cases using actual `itemFromAttributes`, `fieldEvidence`, `captureIssues`, valuation normalization and asset summary functions. It verifies official-model names, official-slot/description categories, loaded blank/missing content with navigation decoys, loading/unavailable-data messages, legitimate nonempty content, and explicit absence. All 22 pass after the fixes.

Two additional final-review leaks were independently found and fixed:

- A life skill with name/type but no level previously skipped tooltip and passed readiness. `/tmp/cbg-step5-skill-review.cjs` demonstrated skipped=true, missing level evidence and issues=[] using actual modules. The policy now demands the missing level, the field table records unknown, and readiness blocks it. A real native collector mock regression preserves completed school skills as partial.
- Duplicate warehouse equipment sharing name/model/location previously hovered index 0 twice and replaced both descriptions with the first item's defense 100, silently losing the second item's defense 200 while readiness passed. The actual native collector pure repro confirmed requests `[0,0]`. Native controls now require the observed icon index and independent identity; pet subsets retain their global observed index in snapshot objects only. The new regression passes with requests `[0,1]` and distinct 100/200 descriptions. Missing indices plus ambiguous identities fail partial.

I adapted only the authorized three existing fixture/test files (`tests/fixtures/analysis.ts`, `capture-readiness.test.ts`, `native-capture.test.ts`). The fixture evidence is derived from the synthetic fixture body with a SHA-256 revision, and every previous assertion remains. The combined final pure run passed **80/80** tests: readiness 52, native capture 6, independent field evidence 22. The fixture module was validated through those imports. Final assembled tabs and school-text-derived provenance were statically checked for consistency.

## Native startup and exit follow-up

Independently read the current `host.mjs`, `Input.m`, and `native-startup-lifecycle.test.ts`, without consulting another review report. The host buffers bounded commands until helper ready, discards stale queued generations on stop/resume, and closes Native stdin/helper/socket on terminal lifecycle events. The helper waits for monitor startup before emitting ready and returns explicit unavailable/timeout before reading queued commands. No new blocking defect was found in this scoped review.

I independently ran `native-startup-lifecycle.test.ts`: **8/8 passed**. These include real child-process stdin lifecycle tests with substituted socket/helper and compiled helper tests with the no-OS-input monitor backend. Actual production EventTap startup, TCC, NativeMessaging end to end, desktop AX/input, and authenticated official-site collection remain unverified. These results are not real-device acceptance.

No unresolved blocking finding remains from this review's verified scope. No unfinished red browser test was counted as a final delivery defect.

## Final leaf regression closure

After the exclusive Chrome slot was released, I independently replayed both pet-entry mutations against the current actual `collectDetail` and production `viewport` interaction path in real isolated Chrome. The fixture was entirely offline; all requests were intercepted, the persistent profile lived under a newly created temporary directory, and only browser-evidence output was disabled. The script was `/tmp/cbg-final-leaf-independent-review.mjs`; machine-readable results are `/tmp/cbg-final-leaf-independent-results.json`.

Both `reorder` and `replace` passed strict assertions:

- Only the first pet was clicked (`[0]`), then capture stopped with `IncompleteCaptureError` and an incomplete-detail cause. It never clicked/read the first pet a second time.
- The original detail root remained connected, both pet entrances remained present, and no old detail/inspection/pet DOM marker was added.
- Partial data retained exactly the four already-read main tabs: person/training, skills, equipment, pets/children. The prior person text, seven school skills, and both weapon/warehouse equipment items remained present; prior equipment completeness remained true.
- Final source revision remained unconfirmed, `stable=false`, and actual `captureIssues(..., true, true, listing)` blocked a complete save.

I then independently ran `vp test server/crawler/detail-leaf.browser.test.ts` with `require_escalated`: **10/10 passed**, 2026-11-15 22:01:58 local, 11.99 seconds. It covers stable distinct entries plus pet/icon/mount/child reorder/replacement boundaries and stale-scope disposal. All Chrome sessions terminated; the independent probe's temporary profile was removed in `finally`.

This closes the independently reproduced P1 pet omission against the final code. These are isolated Chrome/offline collector results. Production EventTap/TCC, actual macOS AX/input delivery, NativeMessaging integration with an installed extension, and authenticated official-site collection remain outside the verified evidence. No further review scope was added.

## 后续真实安装只读验收（主agent核验，历史时点）

独立review完成后，正常生产helper及原样扩展脚本在Chrome157的临时profile实际安装；本地socket原始记录确认实际观察快照经NativeMessaging到达。3个真实宿主进程启动/端口结束后的重新启动通过，实际input-monitor-startup-failed三次拒绝并停止。结果为passed-read-only-scope，实际输入、AX目标、活动等待IOPM、锁屏/抢占/物理多屏仍待验。该后续结果不追溯改写reviewer当时未执行的范围。

## 权限启用后的协议类型复核

用户随后启用输入监控；正常helper在沙箱外只读预检返回input-ready、真实AX/TCC/显示器状态可用、空闲断言为0。沙箱内同一helper仍初始化失败，不能再据此推断实际权限被拒绝。预检还发现AX返回值被装箱为JSON数字1，与runtime严格布尔检查冲突。Input.m现将该值、activity状态条件和activity回复条件显式转换为bool，保留真实AXIsProcessTrusted及CGPreflight系统调用。

Reviewer B独立核对生产差异，并在默认沙箱运行启动生命周期9项与ExtensionNativeRuntime24项，33/33通过，未启动Chrome或发OS输入。新增status类型回归仅替换monitor启动并禁用OS输入，实际AX/TCC读取没有替身；测试后端的inputMonitorActive不计真实EventTap验收。锁屏已按用户指示本轮延期，第二屏无实际硬件；这些均不记实机通过。

## 实际OS验收脚本的独立审查

Reviewer B直接核对`native-os-integration.mjs`与实际生成产物：Runtime、Governor、Workflow、SW、host与helper保留生产实现，stdio/socket原样透传，不伪造proof、权限、awake ACK或posted结果，Playwright不点击或填写业务控件。修复了异步搜索未处理拒绝、取消准备失败永久等待、失败证据未保存和cleanup结果不一致等验收脚本问题。每个实际actionId必须同时匹配SW proof、helper ok/posted、Governor completed、Bridge completed与120/140真实观察快照；释放检查复用活动时已确认的固定helper PID。

生成recorder经无输入自检确认JSONL使用真换行、分片帧转发字节一致。主agent曾将工具JSON展示转义误读为文件内容，独立自检证明模板正确，未据此修改模板。Reviewer B放行的范围仅临时离线页真实输入、页面等待、完成和取消释放；是否执行通过仍以实际`os-result.json`为准，脚本审查本身不计实机通过。

## 实装绑定过渡帧缺陷与修复复核

前两轮OS脚本均零业务输入：首轮缺少测试脚本就绪屏障，第二轮由真实安装暴露生产缺陷。Reviewer B独立对照原始时序：旧有效帧早于新boundAt被归档ACK；resume再次bind时ISOLATED清globals后同步发送normal/空服龄/空QueryArgs的过渡帧，严格decode拒绝且不ACK，后续真实合法帧堵在outbox。未丢弃该帧或伪造筛选默认值来使验收通过。

生产修复增加当前观察代次的hasMainRender门槛：fresh MAIN前明确unknown/loading，无listing或认证结论；收到真正render后继续发布实际数据并由未修改的严格解码拒绝非法服龄。实现者定向34项纯测试及4项隔离Chrome回归通过。Reviewer B独立确认旧token在设置门槛前已被拒绝，verification/login/busy仍优先报告，真实非法条件不被隐匿；独立readiness/runtime25项纯回归通过。

真实输入脚本使用viewport:null保留实际Chrome窗口与Retina DPR，保存真实viewport和原始proof；不将Playwright仿真DPR冒充物理映射，也未放宽helper的scale校验。

## 空闲物理输入与活动抢占的最终复核

Reviewer B沿实际controller与market入口确认：首次绑定后的idle=false使活动不会再走resumeForRun，而原tapCallback把空闲外来输入也置preempted，用户点击“开始”可能污染下一活动。这是源码路径证据；四轮真实OS尝试均在辅助功能预检停止，不能冒作该缺陷的实机复现。

修复使用原子ownsInput镜像：只有活动真实grant成功后发布，release在IOPM调用前清除；旧end/invalidate先检查活动身份，不抹除新owner。tap callback只作原子读取，不等待activityLock或访问Objective-C状态；活动执行及等待期间的外来输入仍置抢占，tap disabled/timeout与显式stop仍严格停止。实现者相关33项纯测试、类型检查、正常无宏clang编译及14项抢占/34项原有自检通过；Reviewer B独立10项启动/状态回归通过，无剩余已确认阻断项。

自检在monitor启动前退出，使用的合成awake状态在进入真实释放路径前清零；没有创建IOPM断言、启动event tap或发送OS输入。以上不记为物理用户抢占实机通过。

## 字段、消息背压与partial的后续独立复核

Reviewer B独立执行数值/来源5个纯测试文件196项与SW19项，合计215/215通过。确认合法0保留、缺失/非法为unknown、唯一逐字段来源、旧汇总ledger/清空issues/空source组及归档商品身份/哈希门槛，并核对实际CrawlStore拒存/拒复用反例。随后独立审查10份fixture差异，7个纯测试文件151/151通过；最后prompt路径仅根据push前输入tabs.length生成，原严格path/facts及1400/100金额断言保留，独立7/7通过。

叶节点20/20隔离Chrome由主agent执行；B仅静态复核完整集合的实际node断言及顶层collectDetail partial用例，确认宝宝B追加时保留已读宝宝A的资质与装备，未将其记为自己运行的20项浏览器结果。上述计数有重叠，不相加。防休眠简化前主agent完整回归200文件3587/3587通过；不能替代简化后验证。

## 用户取消自动防休眠的范围变更

2026-11-16用户明确由自己保持电脑唤醒，取消执行及等待期自动防休眠。最终实现删除IOPM断言和awake条件，活动ACK的active只代表输入授权。旧报告中IOPM/awake及等待防休眠检查属于当时范围，保留为历史；取消、暂停、断连、过期、锁屏、权限、显示器及抢占仍须独立停止输入。此变更的最终review和冻结复测结果见后节。

## 防休眠简化及真实文本替换的最终交叉复核

去防休眠delta经Reviewer B独立9纯文件106/106通过，另一无历史实现agent独立只读复核，没有新增阻断：没有fake awake或旧ACK fallback；active严格对应有效输入授权，取消/暂停/断连/过期/锁屏/显示器/权限及抢占围栏仍保留。

真实Chrome记录随后确认字段追加与Unicode修饰键两个问题，均在同一已验证AX目标上修复。Reviewer B及另一agent分别从当前源码独立核对三条文本入口的强引用、实际focus/CFEqual/PID/frame、稳定原值、完整UTF16选区、700ms单调上限、100ms AX读超时、每轮原authority/lease/proofTTL/stop/preempt检查，且无锁跨AX等待。空串Delete与Unicode down/up显式flags0仅操作本次生成事件，不改变硬件/全局modifier，不扩大marker豁免，不重放未知动作。最终Input.m SHA256为`9f32949c0e4fe994d118be9fe92d1d829608c915519c57975226bb3f6c4c8d7a`。

Reviewer B独立startup11/11通过，正常编译55+14纯自检通过。CGEvent实际对象在默认沙箱创建不可用时明确失败，拆分独立self-test后不可用返回2；B从同源码fresh编译，在沙箱外无post运行确认down/up flags0、Unicode120，不能据此声称业务流程通过。主agent实际`7Ft8AB`的价格替换100→120子步骤已通过匹配proof/helper/快照/许可/Bridge核验；后续收到未标记type5鼠标事件而停止；用户明确确认全程没有操作，事件来源仍未解，该历史轮basic失败。两位审查者的最终结论是当前已审代码无新增阻断，未把物理多屏、延期锁屏或未通过的原生业务完整流程判为通过。

后续断连/重启收证由无父历史、未读memory或旧review的替补独立reviewer直接核验：从同冻结Input.m fresh clang编译的binary SHA256 `4c8b6014acc617b0cd03a01677f05be78b96a8c5f88b23258d4855d201fe78e1` 与两实际安装helper一致，55+14无输入自检通过；nativeStdio和各自wire逐项一致（19/37条）。`oMeK6u`和`pOTZmb`分别证明disconnect-only/restart-only；故障都发生在120字段动作已completed后的active等待期，不是在按键发送中。原helper退出、旧scope下一动作在proof前拒绝；重启后不同host/helper已连接，但runtime仍stopped、active=false/lease={}，没有申请或通过新业务授权。不能推及搜索、完整等待、正常完成/取消、TTL、按键发送中的故障、实际接管或官网成功。替补接手是原reviewer运行报错，原冻结版生产审查结论不受影响。

## 最终冻结验证与来源未解边界

以下为交付事实的文档汇总，不新增独立源码审查或实机运行计数。

生产`Input.m`保持上述9f32949c哈希不变。最终代码为C9f、Runtimee407；`/tmp/cbg-six-release-complete-final.json`为203文件、3641/3641通过，0失败、0跳过，621.07秒。修复前3590/3590、616.21秒及其并行3589+1原5秒登录超时、原限4/4复验保留为历史，3587/3587等更早计数同样不是当前结果；没有为求绿修改原断言或时限。

冻结代码的legacy最终复验`/tmp/cbg-six-legacy-final-verified.log`为5/5阶段PASS；`/tmp/cbg-six-final-check-verified.log`为0错误、29条原有warning，`/tmp/cbg-six-final-build-verified.log`构建通过。这些代码验证本身不替代实机；带显式AX setup的basic通过另记，expiry独立helper过期验收NOT PASS，物理接管、多屏和延期锁屏未补齐。

已审control `a8PxTN`（0 post、0 event）与`931687`（1 post、1 marked event）各有有效12秒观察期，未复现额外unmarked事件。它们不能解释`7Ft8AB`在用户全程未操作时收到的未标记鼠标事件，不能据此认定来源已修。privateSource实验`km8`/`NQV`对照不采纳，不在冻结生产代码中，也不计修复或验收通过；来源仍未解，goal继续active。

## 最后两项Runtime竞态与实机范围闭合

`z6VMiu`的rev7已DOM提交且控件120，但MAIN参数仍100，2ms后rev8才120。修复限定角色query/page，在实际dispatch捕获已观察的合法数值控件及serverid/server_type维度；完成快照须UI/QueryArgs与提交一致，空和0不混用，不因旧混帧写completed。原TTL、fixture和断言未改，无额外业务动作；新增纯36条及真实MAIN/ISOLATED浏览器1条，两个独立源码review通过。

`43SYtA`暴露取消后的纯status请求被在途server-stop误拒。最终e407仅保留精确command/status pending等同action真实reply；先撤销活动、停止续约，显式stop/断连/超时及其他请求或停止原因仍全部取消。没有fake false、授权恢复或输入重放。新增真实Unix socket14条；第二审查者从精确72d混帧冻结版重建小delta核验，两位独立reviewer均闭合。

最终Runtime SHA256为`e407714d4b21ded72ea1d4d54df3d1c96d5f0c3dc6a07eb9fe7ee5db90e97066`，C仍为9f。`ofKH5m` stock链路在显式只读AX setup下真实通过input、wait、heartbeat、normal end及cancellation全部原断言；3个action的proof/helper/DB全completed，helper17255退出。该setup现可用项目`--ax-preflight`复现；它不证明默认冷启动、官网成功或7Ft未标记mouse来源已修。expiry `RV6KYg`已失败，独立helper过期验收NOT PASS。断连/重启既有fault-only结果仍有效，但不扩为按键发送中故障；物理接管、多屏及延期锁屏仍未验，goal不记完成。

`RV6KYg`实际以`failed-or-blocked`结束（terminal 1）：helper21578在host暂停窗口的85次采样均存活，恢复后真实status为active=false/lease={}。但此前续租回执已超时并由Node发送stop，wire只有server-stop，等待expired原因最终超时。因此不能把inactive归因为helper独立过期，验收明确NOT PASS；cleanup确认helper已退出。没有改断言或伪造结果，不再扩实验；独立helper过期仍是剩余验收缺口。
