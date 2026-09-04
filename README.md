# make-money-from-CBG

梦幻西游藏宝阁角色倒卖决策系统（规划阶段）。

## 发布顺序

- **V1：macOS**——先完成 HTML 采集批次、离线结构化解析、Excel 分析和 Vite 管理页面的完整闭环。
- **V1.1：Windows 11 x64**——复用同一核心，增加托盘图标、用户登录自启和本地管理页面自动打开。
- **Future**——按需要增加低权限 Analyzer Windows Service。

Windows 10 不属于当前发布范围。

## 当前文档

- [领域、CDP 与 Windows 调研](docs/research.md)
- [分阶段跨平台架构](docs/architecture.md)
- [Wayfinder 决策地图](docs/wayfinder/map.md)
- [macOS V1 → Windows 11 V1.1 交付计划](docs/delivery-plan.md)

## 已确定方向

- Vite + React + TypeScript 前端；
- Stagehand 通过 CDP 连接用户控制的本机 Chrome；
- macOS/Windows 都使用专用非默认 Chrome profile；
- CDP 只监听 `127.0.0.1`；
- Collector 使用 Stagehand 导航和展开页面，在页面稳定后保存渲染 DOM HTML；
- 原始 HTML 快照先形成完整、不可变的 crawl run，再由离线 parser 转成角色数据批次；
- Analyzer 只消费冻结的角色批次和 Excel 规则；
- 不边抓边分析，不自动购买、付款、议价或上架。

## Windows 11 V1.1 体验

- Collector 以托盘应用运行在当前登录用户会话，不作为 Session 0/LocalSystem Windows Service；
- 用户登录后自动启动托盘和本地服务；
- 本地服务健康检查成功后，每个登录会话自动打开一次 Vite 管理页面；
- 登录时不自动启动藏宝阁专用 Chrome、不连接 CDP、不开始采集；
- Analyzer 作为用户后台进程，Windows Service 延后；
- 默认数据目录为 `%LOCALAPPDATA%\CBGRoleTrader`。

当前将“页面弹出来”解释为打开本地管理页面；藏宝阁专用 Chrome 和采集任务仍由用户显式启动。

## 当前边界

采集技术路线固定为 **CDP + Stagehand + rendered HTML snapshot**。CDP 用于复用本机会话，不是反检测或“防封号”机制。生产站的服务器范围、页面范围、频率和留存必须由可留档授权决定；授权未确认前，只在本地 fixture 或用户明确允许的单页范围验证采集链路，不执行自动全服遍历。项目不实现验证码绕过、指纹伪装、代理池或风控规避。

下一步：上传脱敏 Excel，并回答 [Wayfinder 前沿问题](docs/wayfinder/map.md#frontier当前可处理的独立决策票)。
