# 调研结论

> 核对日期：2026-09-04。本文只记录会改变实现路线的事实，不把推测写成结论。

## 1. 目标站点边界

- [梦幻西游藏宝阁首页](https://xyq.cbg.163.com/)可以公开打开，首页提供服务器选择和角色搜索入口。
- 站点的 [`robots.txt`](https://xyq.cbg.163.com/robots.txt)仅允许根路径 `/`，其余路径均 `Disallow`。
- 首页页脚明确标注禁止使用爬虫采集数据及商业转载。因此，CDP + Stagehand 只是一种采集技术，不会自动获得批量遍历、存储或商业分析授权。
- 项目不实现验证码绕过、风控规避、指纹伪装或代理池；“模拟用户”只表示通过真实浏览器执行正常页面动作，不表示规避站点限制。

### 对实现的约束

1. HTML Collector 的代码可以先在 synthetic fixture 上完成；
2. 生产运行必须加载显式 `CrawlScope`，范围、频率和留存期限应能对应到可留档授权；
3. 没有授权依据时，生产配置只能运行用户明确允许的单页验证，不能冻结为“全服完整批次”；
4. 任何验证码、登录异常或访问限制都应停止任务并等待人工处理，不能自动绕过。

## 2. CDP + Stagehand HTML 采集能力

[Stagehand v4 浏览器配置文档](https://docs.stagehand.dev/v4/configuration/browser)确认：

- `localBrowser.connect()` 可以通过 CDP URL 附着到已经运行的 Chromium；
- 附着后的浏览器仍由用户管理，Stagehand 退出不会关闭它；
- 本项目只连接 `127.0.0.1`，并使用专用 Chrome profile。

[Stagehand v4 Page API](https://docs.stagehand.dev/v4/reference/page)提供 `goto()`、`waitForLoadState()`、`waitForSelector()` 和 `evaluate()`。因此选定的采集过程是：

1. Stagehand 导航到已纳入 scope 的 URL；
2. 等待关键元素出现，并按页面类型执行必要的展开、分页或详情动作；
3. 通过 `evaluate(() => document.documentElement.outerHTML)` 读取当前渲染 DOM；
4. 将 HTML、最终 URL、页面类型、抓取时间和 SHA-256 一起写入不可变快照。

[Stagehand v4 Response API](https://docs.stagehand.dev/v4/reference/response)可以读取主文档网络响应正文，但它代表服务器响应，不等于 JavaScript 执行后的当前 DOM。本项目所说的“爬取 HTML”默认指 **rendered DOM HTML**，不把 response body 当作同一种数据。

### HTML 快照的已知限制

- `document.documentElement.outerHTML` 不自动包含 iframe 子文档、shadow root 内部、canvas 像素或尚未触发的懒加载内容；
- 折叠区域需要 Stagehand 先执行显式页面动作；
- HTML 可能包含脚本、隐藏字段或账户相关标记，必须作为不可信敏感数据保存，不能直接放进 Vite 页面执行；
- 核心业务字段由离线、版本化 parser 确定性提取。Stagehand 的 `extract()` 可用于原型比对，但不作为 canonical 数据来源。

## 3. Wayfinder 使用方式

本会话没有安装可直接激活的 `/wayfinder` skill；规划采用其公开方法论。根据 [The /wayfinder Skill](https://www.aihero.dev/skills-wayfinder)：

- 先定义目的地，再把不确定性拆成决策票；
- 决策票解决问题，不直接承载产品实现；
- 开放、未阻塞的票组成当前 frontier；
- 地图清晰后再形成可独立验收的实现票。

本项目因此分两层：`docs/wayfinder/map.md` 记录待决问题，`docs/delivery-plan.md` 记录实现票。

## 4. 已知缺口

- 脱敏 Excel 尚未进入仓库，无法确认 sheet、字段、公式、单位和期望排序；
- “性价比”尚无唯一数学定义；
- “全量角色信息”尚无 required fields 清单；
- 生产 crawl scope、服务器枚举、分页终止证据、采集频率和留存期尚未确认；
- 没有可合法留存的列表页/详情页 HTML 样本用于建立 parser fixtures。

## 5. 路线结论

采集主链路调整为：**专用 Chrome → CDP → Stagehand 导航与页面动作 → rendered HTML snapshot → 离线 parser → frozen role batch**。开发期先在 synthetic HTML 上验证相同链路；生产运行受授权 scope 门禁控制。Analyzer 和 Vite 不读取在线页面，也不执行采集到的 HTML。

Content was rephrased for compliance with licensing restrictions.
