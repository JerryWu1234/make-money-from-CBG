# P0 与根生命周期接线独立最终审查

评审时间：2026-11-15，Asia/Shanghai。
评审目录：`/private/tmp/cbg-access-reliability`。
基线 HEAD：`2559afc4591391fb2cf00217bc85ee6bf04af3c9`；评审对象为基线之上的当前未提交工作区实现，包括本轮根代理修复。

本审查仅依据当前源码、`docs/cbg-access-reliability-design-and-review.md` 和本次实际运行结果。没有读取任何 memories、历史 rollout、其他 reviewer 报告或旧对话；没有修改生产源码、提交、推送、创建 PR、访问官网或使用真实浏览器配置。原生宿主与扩展内部不属于本报告审查范围。

## 最终结论

**当前所审范围没有剩余已确认、可复现的阻塞问题。** 本轮独立发现三个实质问题，均已由根代理修复；关键两项另用 `/private/tmp` 外部独立 probe 复核，修复后不能再次触发。

这是一份代码及纯隔离测试结论，不代表浏览器模拟验收、原生宿主/扩展内部验收或实站兼容性结论，也不单独替代整个项目的 T01–T22 验收汇总。

## 本轮发现及最终复核

### 1. 晚到查询 A 能错误接受尚未完成的查询 B：已修复

原触发顺序：同一绑定页 `begin(A,page=1)` → `begin(B,page=2)` → `finish(A,normal data)`。旧实现用 `binding.context` 注册 A 的接受结论，实际把 B 的 `access_queries.accepted` 写为 1；B 没有任何 `query_health_results` 行，却能通过 `governor.withProgress(B)`，同时 B 的 pending 被清除。这会破坏 QRY-01/QRY-03 的查询身份与进度门槛。

当前修复位置：`server/query-health/runtime.ts:85–91`。在写入观察、基线或查询接受结论前验证 pending 对象、queryId 与浏览器会话；旧 A 返回 QueryHealthError，不修改 B。`server/query-health/runtime.test.ts:48` 新增顺序回归。

独立复核：外部 probe 验证旧 A 被拒绝、B 仍为 accepted=0、B 无结果时不能推进；真正完成 B 后才允许推进。通过。

### 2. 人工恢复接口绕过浏览器模式切换互斥：已修复

原触发：`browserControl.changing=true` 时调用 `/api/access/open` 或 `/api/access/recover`。两条路径未计入 browserUseRoutes，仍返回 200 并调用恢复执行函数，也不占 pending；恢复页/原生握手因此可与模式关闭切换并行。

当前修复位置：`server/api.ts:82–89`。两条恢复路由统一进入 changing 检查及 pending 生命周期。`server/api-browser-settings.test.ts` 新增切换锁拒绝及请求未完成时 pending 保持的回归。

独立复核：外部 probe 对两路分别验证 changing=true 返回 409，open/recover 执行函数均未调用。通过。

### 3. 原生完整采集未通知跟随分析：已修复

原生 `startNativeCrawl` 的发布回调仅更新采集状态，缺少 Playwright 分支已有的 `appendCapturedAnalysis` 接线，导致跟随分析不能及时取得原生刚采集完成的商品。

当前修复位置：`server/crawler/controller.ts:469–478`。saved 增加时通知分析；同一个 saved 值的状态更新不重复通知。`server/crawler/native-lifecycle.test.ts:108` 验证 saved=1 后重复 saved=1 仅通知一次。通过。

另复核根代理同时修复的两项：`workflow.click` 只有确认导航至新的同源页面后才吞掉旧上下文错误，未确认结果保留异常且不重放；保存的未知 accessAdapter 明确拒绝，不能自动落回 Playwright。对应纯测试通过。

## 审查覆盖与证据

- ACC-01/02：检查业务端点范围、JSON/JSONP 分类、HTTP 403/429、持续页面保护、各业务页面绑定、实际请求单独入账及失败时停止路径。未知/压缩/无安全长度响应保留 unknown；未将其误称为已取得解码后的业务结论。
- ACC-03/04：检查共享 SQLite 状态、stopEpoch、revision、owner/fence、独立 crawl lease、业务事务内 assertActivity/assertProgress、晚到结果归档、恢复冷却/原因确认/并发风险变化与恢复预算。
- ACC-05/06：检查持久预约/最终授权/未知动作账本、窗口/间隔/取消/失主恢复/墙钟异常、单官网交互槽、新旧任务配额、详情首次派发启动固定读取截止时间。
- CFG-01：检查访问策略边界和版本、旧随机 1..N 标记、版本 2 min/max、一致性校验、旧客户端覆盖保护及设置不清理风险。
- QRY-01/02/03：检查身份、结果和访问结论分离、目标非空基线、首次异常空冻结、持久一次性目标/Canary/恢复 claim、blocked 不探测、探针不推进业务、列表/市场写入前的事务 fence；对晚到 A 接受 B 漏洞额外独立注入并验证修复。
- LOG-01：检查 request/action/query/page/epoch 关联、摘要日志、URL/证据脱敏及异常观察存储失败的拒绝路径。
- 完整性与生命周期：检查 `crawler/store` 的版本/尝试修订/complete 与 partial 保护、只归档分支，`official-access.ts`、`native-access.ts`、`crawler/controller.ts`、`page.ts`、`workflow.ts` 与 native workflow/query 包装的根接线，以及正常完成/计划时限/结束失败时的租约与 activity 收尾。

## 实际验证

所有本次执行的测试均已检查为纯 Node / mock / SQLite 路径，没有启动 Chrome。

最终组合命令：

```sh
vp test server/access/governor.test.ts server/access/response-classifier.test.ts server/query-health/runtime.test.ts server/query-health/store.test.ts server/query-health/progress-fence.test.ts server/query-health/role-query-identity.test.ts server/query-health/role-list-diagnostics.test.ts server/query-health/callback-observer.test.ts server/official-access.test.ts server/native-access.test.ts server/crawler/business-lease.test.ts server/crawler/native-lifecycle.test.ts server/crawler/access-guard.unit.test.ts server/crawler/head-refresh.test.ts server/crawler/watch.test.ts server/browser-settings.test.ts server/api-browser-settings.test.ts server/workflow.test.ts
```

结果：退出码 0，18 个文件，275 项测试通过。

外部独立 probe：`/private/tmp/cbg-p0-final-probe/probe.test.ts`，配置 `/private/tmp/cbg-p0-final-probe/vite.config.ts`。

```sh
vp test --root /private/tmp/cbg-p0-final-probe
```

结果：修复前 2 项 probe 均复现不安全行为；将断言改为要求拒绝后，对当前修复实现退出码 0，2 项回归通过。
