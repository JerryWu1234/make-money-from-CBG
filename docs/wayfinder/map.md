# Wayfinder 决策地图

**状态：** 地图已建立，尚未清空。  
**规则：** 本文件只记录决策，不承载产品实现；采集技术路线已确定，但生产 scope 仍由授权决策控制。

## Destination

形成可直接实施的 macOS V1 规格：Collector 通过 CDP + Stagehand 在明确 scope 内导航，保存 rendered HTML；离线 parser 将 HTML 转成可追溯的完整角色批次；系统结合脱敏 Excel 规则产生确定、可解释的 Top N 性价比排名，并通过 Vite 展示。范围不包括自动交易和规避访问限制。

到达目的地的判据：frontier 均有书面答案，足以冻结 crawl scope、HTML 完整性、角色字段、Excel 规则和评分目标。

## Decisions so far

| 决策 | 结果 |
|---|---|
| 首发平台 | macOS V1；Windows 11 x64 延后 |
| UI | Vite + React + TypeScript |
| 浏览器边界 | Stagehand 运行于 Node，经 `127.0.0.1` CDP 连接专用 Chrome profile |
| 采集机制 | Stagehand 导航/等待/展开页面，随后保存 rendered DOM HTML |
| HTML 定义 | 页面稳定后的 `document.documentElement.outerHTML`，不等同于网络 response body |
| 解析机制 | 版本化离线 parser 从 HTML 确定性生成 `RoleListingV1`；`extract()` 不作 canonical 来源 |
| 数据分层 | frozen HTML crawl → frozen role batch → analysis run，三层不可变且可追溯 |
| MVP 存储 | HTML + JSON/NDJSON + manifest + SHA-256，不先引入数据库 |
| 分析原则 | 纯离线、确定性、每个分数可解释；不猜测 Excel 语义 |
| 交易边界 | 不购买、付款、议价、上架，不绕过验证码或风控 |

## Frontier：当前可处理的独立决策票

### WF-01：生产 `CrawlScope` 允许覆盖哪些页面和运行条件？

- **类型 / 模式：** task + grilling / HITL
- **负责人：** 用户提供授权和业务范围，代理整理成 scope
- **要回答：** 允许的 host、服务器、列表/详情页、分页深度、运行频率、并发、HTML 留存期及商业分析范围是什么？
- **所需材料：** 可留档授权文本或官方功能说明；敏感内容可脱敏，但需保留范围和限制。
- **完成标准：** 形成可机器校验的 `CrawlScopeV1`，每项限制都能追溯到依据。
- **默认答案：** 未提供依据时只运行 synthetic fixture 或用户明确允许的单页验证，不能冻结“全服完整”生产 crawl。
- **解锁：** 生产配置、完整性判定和运行排期。

### WF-02：现有 Excel 每个 sheet、列和公式表达什么？

- **类型 / 模式：** task + grilling / HITL
- **负责人：** 用户上传脱敏工作簿，代理做字段盘点并提问
- **要回答：** sheet 用途、字段类型、单位、空值、公式、宏、优先级、跨表引用和输出含义。
- **所需材料：** 脱敏 Excel；至少保留表结构和公式。若含宏，说明宏的输入输出，但 MVP 不执行宏。
- **完成标准：** 每个输入列都映射到标准字段或明确标记“不使用”；未知列为零。
- **解锁：** 标准谓词、评分项和 Excel adapter 规格。

### WF-03：“最具性价比”的唯一优化目标是什么？

- **类型 / 模式：** grilling / HITL
- **要回答：** 从以下目标中选择一个作为 V1，或提供明确公式：
  1. 满足硬条件后最低售价；
  2. 综合配置分 / 售价；
  3. 预测公允价相对挂牌价的折扣；
  4. 预计转售净利润或收益率；
  5. 其他多目标排序。
- **所需材料：** 至少 3 个脱敏案例，每个包含输入、手工计算过程、期望名次和并列处理。
- **完成标准：** 对同一输入只有一个预期排序；单位、归一化、权重、缺失值和并列规则全部明确。
- **解锁：** Analyzer 的最终公式与业务验收样例。

### WF-04：哪些 rendered HTML 内容构成“全量角色信息”？

- **类型 / 模式：** prototype + grilling / HITL
- **要回答：** 哪些角色、装备、技能、召唤兽、修炼及其他字段必需；哪些折叠区域必须先展开；是否存在 iframe、图片/canvas 或 HTML 无法表达的字段。
- **所需材料：** 一组有权用于研发的列表页和详情页 HTML，或结构等价的 synthetic fixtures，以及字段优先级。
- **完成标准：** 发布 `requiredFields` 与 `pageKind → stable selector → interaction → parser mapping` 清单；每个字段有类型、单位和缺失策略。
- **解锁：** HTML parser 与 crawl 完整性验收。

## Blocked decisions

### WF-05：一次全服 crawl 何时可判定完整？

阻塞于 **WF-01** 和 **WF-04**。预期判据包括：scope 中所有服务器均有分页终止证据；发现的角色详情集合与成功 HTML 快照集合一致；没有失败 URL；所有快照和索引哈希有效；全部 required fields 可解析。

### WF-06：HTML 保留、脱敏和删除策略是什么？

阻塞于 **WF-01**。canonical HTML 原样保存在 `var/` 且不提交 Git；提交 fixture 必须另行脱敏。具体保留天数和可接触人员由授权范围决定。

### WF-07：Excel 规则的安全算子白名单是什么？

阻塞于 **WF-02** 和 **WF-03**。默认禁止任意代码执行、宏执行和静默字段转换。

## Not yet specified

- 每种真实 `pageKind` 的稳定 selector、展开动作和分页终止标志；
- 生产 HTML 的平均大小、一次全服运行所需空间和耗时；
- 页面改版后的 parser 版本迁移及历史 HTML 重放策略；
- Windows V1.1 的分发、签名和自动更新方式。

## Out of scope

- 未经授权的生产运行、接口逆向和网络响应拦截；
- 验证码绕过、指纹伪装、代理池、封禁规避；
- 把 Stagehand AI `extract()` 结果直接当成不可审计业务事实；
- 在 Vite 中执行或原样渲染采集 HTML；
- 自动购买、支付、议价、上架；
- V1 的预测模型、云端多租户和 Windows Service。

## 下一次 Wayfinder 会话

优先处理 **WF-02** 和 **WF-03**：上传脱敏 Excel，并给出 3 个“输入 → 手算过程 → 期望排名”案例。并行提供 **WF-01** 的 scope/授权材料和 **WF-04** 的脱敏 HTML 样本；没有真实样本时先确认 synthetic 页面字段清单。
