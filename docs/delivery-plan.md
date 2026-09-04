# macOS V1 最小实现票

## 1. 拆票原则

严格让每票从空仓库运行会重复脚手架和公共类型，并制造合并冲突。这里采用最小可并行定义：

1. 先合并唯一基线 **M0**，冻结依赖、目录和公共数据契约；
2. **M1–M6 彼此不消费对方生成的 `var/` 数据**，每票自带输入 fixture；
3. 每票有独立命令、可观察输出和失败验收；
4. Collector、parser、Analyzer 和 UI 通过文件契约连接，不互相 import 业务实现；
5. 最后执行薄集成验收，不借机改变契约或增加功能。

所有票以 `docs/architecture.md` 为准。需要改变公共契约时，先回到 Wayfinder 做决策。

## 2. 票总览

| 票 | 独立可运行结果 | 状态 / 阻塞 |
|---|---|---|
| M0 | Vite/Node 基线和全部 V1 契约可构建 | Ready，唯一基线 |
| M1 | HTML snapshots 可写入、校验并冻结成 crawl run | M0 后 Ready |
| M2 | Stagehand 经 CDP 抓取动态页面的 rendered HTML | M0 后 Ready；生产 scope 阻塞于 WF-01 |
| M3 | HTML fixtures 可离线解析并冻结成角色批次 | M0 后 Ready；最终字段阻塞于 WF-04 |
| M4 | 脱敏 Excel 可转换为标准规则 JSON | 阻塞于 WF-02/WF-03 |
| M5 | 角色 fixture + 规则 fixture 可输出确定性排名 | M0 后 Ready |
| M6 | Vite 可展示 crawl、解析和排名 fixture | M0 后 Ready |

## 3. 实现票

### M0 — 建立 TypeScript/Vite 基线并冻结 V1 契约

**目标：** 一个仓库、一个锁文件，同时支持 React 页面和 Node CLI；公共 schema 先于各功能票落地。

**范围：**

- Vite + React + TypeScript；
- Node CLI 入口与子命令帮助；
- `src/{browser,collector,crawl-store,parser,contracts,batches,excel,analyzer,web}`；
- Zod schema：`CrawlScopeV1`、`HtmlSnapshotV1`、`CrawlManifestV1`、`RoleListingV1`、`BatchManifestV1`、`RuleSetV1`、`AnalysisRunV1`；
- `fixtures/{html,crawls,roles,rules,analyses}` 与 `var/`；
- `.env.example` 只列变量名；`var/`、真实 Excel、HTML、Chrome profile 和密钥全部忽略；
- 依赖使用实施时确认的精确版本并提交 lockfile。

**不做：** 浏览器操作、HTML 解析、评分、业务 UI、数据库或桌面壳。

**独立命令：**

```bash
npm ci
npm run contracts:verify
npm run cli -- --help
npm run typecheck
npm run build
```

**验收：** 所有命令退出码为 0；每个 schema 都有一个合法和一个非法 JSON fixture；构建产物不含密钥或运行数据。

---

### M1 — 不可变 HTML Crawl Store

**目标：** 不依赖 Stagehand，仅用 synthetic HTML 证明 draft → validate → hash → frozen 的原始采集边界。

**范围：**

- 按 `HtmlSnapshotV1` 保存 `.html` 文件与 `pages.ndjson`；
- 计算每页 SHA-256、字节数及 index SHA-256；
- URL 去重、相对路径防穿越、文件权限限制为当前用户；
- 校验 scope、页面计数、失败 URL、服务器终止证据和授权字段；
- 同文件系统临时目录原子改名冻结；
- frozen run 只读，不能追加或覆盖。

**不做：** Chrome、Stagehand、DOM 解析、Excel、评分。

**独立命令：**

```bash
npm run crawl-store:demo
npm run crawl:verify -- fixtures/crawls/frozen-valid
```

**验收：** demo 生成可验证的 frozen crawl；篡改 HTML、缺页、重复 snapshot ID、路径越界、失败 URL、缺少分页终止证据或无授权的生产 scope 均失败，且不能留下伪 frozen 目录。

---

### M2 — CDP + Stagehand Rendered HTML Collector

**目标：** Stagehand 附着专用 Chrome，导航动态 fixture，执行必要页面动作，并抓取页面当前渲染 DOM HTML。

**范围：**

- 使用 Stagehand v4 `localBrowser.connect()` 连接 loopback CDP；
- 加载并校验 `CrawlScopeV1`；
- `goto()`、`waitForSelector()`、locator 或白名单 `act()` 完成导航、展开和分页；
- 页面稳定后调用 `evaluate(() => document.documentElement.outerHTML)`；
- 记录 requested/final URL、page kind、parent、server/listing hint、时间和 HTML；
- 同 run URL 去重、max pages/depth/concurrency 限制、可中断并保留 draft；
- 检测验证码、登录异常、未知弹窗、scope 外跳转并停止；
- Stagehand 退出不关闭用户 Chrome。

确定性 locator 优先；只有页面动作无法稳定定位时才使用 `observe`/`act`，模型密钥可选。不得通过随机输入、伪造指纹或代理模拟“反检测用户”。

**不做：** 解析角色字段、Stagehand `extract()` 直接产出角色、网络接口逆向、响应拦截、自动交易。

**用户手动准备专用 Chrome：**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/CBGRoleTrader/ChromeProfile"
```

**独立命令：**

```bash
npm run collect:fixture -- --cdp http://127.0.0.1:9222
```

获准后的生产入口使用同一实现，但必须显式传 scope：

```bash
npm run collect -- --cdp http://127.0.0.1:9222 --scope var/scopes/approved.json
```

**验收：** 动态 fixture 的内容在展开前不存在、展开后出现在保存的 HTML；Collector 只访问 fixture scope；最终 URL 和哈希正确；远程 CDP、HTTP 目标、scope 外 host、超页数、验证码 fixture 均停止并返回非零；Chrome 保持运行。生产命令在缺少 `authorizationRef` 时必须在导航前失败。

---

### M3 — 离线 HTML Parser 与角色批次

**目标：** 不依赖浏览器，仅凭 frozen HTML fixtures 确定性生成可追溯的 `RoleListingV1` 和 frozen role batch。

**范围：**

- 使用不执行脚本的 DOM parser；
- 按 `pageKind` 和 parser version 选择解析器；
- 列表页解析详情 URL/服务器/分页证据，详情页解析价格、角色、装备、技能及 extras；
- 每个角色记录引用 `crawlRunId`、`snapshotId` 和 `parserVersion`；
- 生成 observed/missing required fields；
- 校验 listing ID 去重、发现集合与详情集合一致、parse failure count 为零；
- 写 NDJSON、SHA-256 并原子冻结 role batch。

**不做：** 执行 HTML 脚本、访问网络、AI 猜字段、Excel 或评分。

**独立命令：**

```bash
npm run parse:demo
npm run batch:verify -- fixtures/roles/frozen-valid
```

**验收：** 同一 HTML + parser version 连续两次输出内容哈希相同；字段均能追溯到 snapshot；缺 required field、未知页面版本、重复 listing、缺详情页或脚本注入 fixture 均安全失败；脚本 fixture 不产生任何副作用。

---

### M4 — 脱敏 Excel 到标准规则的单向适配器

**目标：** 将用户实际工作簿转换为 `RuleSetV1`，并给出逐单元格诊断。

**前置输入：** WF-02/WF-03 已关闭；真实工作簿放在 `var/`，仓库只保留用户确认可提交的最小脱敏 fixture。

**范围：**

- 只读打开工作簿；
- 明确的 sheet/列映射；
- 单位、空值、布尔值和枚举规范化；
- 公式读取方式按 WF-02 决策实现，不执行 VBA；
- 未知列、非法算子、重复 case ID、缺少必填值时失败并报告 sheet/cell；
- 输出 workbook SHA-256 和转换摘要。

**不做：** 评分、浏览器、自动猜列、任意代码执行。

**独立命令：**

```bash
npm run excel:convert -- fixtures/excel/cases.xlsx --out var/rules/demo.json
npm run rules:verify -- var/rules/demo.json
```

**验收：** fixture 产生固定 `RuleSetV1`；至少 3 个用户案例可逐项对应；错误 cell 得到精确位置且不产生可用输出。

---

### M5 — 纯函数性价比 Analyzer CLI

**目标：** 不依赖 HTML、Excel 或 Collector 实现，仅凭 canonical role/rule fixtures 生成可解释、确定性的排名。

**范围：**

- 拒绝非 frozen、哈希不符或 required fields 缺失的 role batch；
- 硬过滤、白名单评分项、聚合与稳定并列排序；
- 输出原始值、归一化值、权重、贡献值和入选/排除原因；
- 记录输入哈希、parser/rule 版本和运行 manifest。

**不做：** 读取 `.xlsx`、解析 HTML、访问网络、机器学习、隐式默认权重。

**独立命令：**

```bash
npm run analyze:demo
npm run analysis:verify -- fixtures/analyses/valid
```

**验收：** synthetic 的 3–5 个角色得到文档化的唯一名次；连续两次结果哈希相同；每个总分可由分项复算；破损批次、未知字段和非法规则均失败。

---

### M6 — Vite Crawl 与排名查看器

**目标：** 仅读取静态 manifests 和 `AnalysisRunV1` fixtures，也能演示采集到排名的完整状态。

**范围：**

- crawl run：scope、页面数量、成功/失败、终止证据和时间；
- role batch：parser version、角色数、字段覆盖和缺失；
- Top N：服务器、价格、总分、排名；
- 详情：装备、技能、分项贡献、入选/排除原因和来源 snapshot ID；
- draft/failed/frozen、空状态、无合格结果和 schema 不兼容状态；
- 只绑定 `127.0.0.1`。

**不做：** 登录、设计系统、浏览器内 Stagehand、密钥存储、`dangerouslySetInnerHTML` 或原始 HTML 预览。

**独立验收：**

```bash
npm run typecheck
npm run build
```

开发演示由用户手动运行：

```bash
npm run dev -- --host 127.0.0.1
```

页面只凭已提交 fixtures 显示完整状态和排名解释；断开 Collector/Analyzer 后仍可演示；恶意 HTML 字符串 fixture 只能作为转义文本出现，不能执行。

## 4. 发布验收（不是独立实现票）

M0–M6 合并后只连接既有接口：

1. M2 经 CDP + Stagehand 抓取动态 synthetic 页面；
2. M1 验证并冻结 HTML crawl；
3. M3 重放 HTML，生成并冻结 role batch；
4. M4 转换脱敏 Excel；
5. M5 输出排名；
6. M6 展示 crawl、字段覆盖和 Top N；
7. 断网后重复步骤 3–6，证明解析、分析和 UI 完全离线；
8. 修改任一 HTML 字节，验证后续链路拒绝该 crawl。

生产 smoke test 只在 WF-01 关闭后执行，并使用最小 approved scope；发布验收不等于已获准全服运行。

## 5. 推荐顺序

```text
M0
├─ M1 ─┐
├─ M2 ─┤
├─ M3 ─┤
├─ M5 ─┤  可并行，各自使用 fixture
└─ M6 ─┘

WF-02 + WF-03 关闭后：M4
全部完成后：发布验收
WF-01 + WF-04 关闭后：最小生产 smoke test
```

最先验证核心技术风险的路径是 **M0 → M2 → M3**；最先验证业务价值的路径是 **M0 → M5 → M6**。

## 6. 主要风险与停机条件

| 风险 | 最小控制 | 停机条件 |
|---|---|---|
| 生产采集范围无授权依据 | `CrawlScopeV1` + `authorizationRef` 前置校验 | 无依据时生产命令在导航前失败 |
| rendered HTML 不含 iframe/shadow/canvas/懒加载 | 每种 page kind 定义稳定条件与 required fields | HTML 无法表达必填字段时不宣称全量 |
| Stagehand 页面动作不稳定 | selector/locator 优先，动作白名单，保留失败 draft | 未知弹窗、验证码、URL 越界立即停止 |
| HTML 含脚本或敏感标记 | `var/`、当前用户权限、离线无脚本 parser、UI 不渲染 HTML | 快照进入 Git 或浏览器执行则阻断发布 |
| 页面改版导致 parser 漂移 | parser version + 多版本 fixtures + 来源追溯 | 未知页面版本不自动猜测 |
| 全服完整性无法证明 | 服务器清单、分页终止证据、发现/抓取集合对账 | 任一失败 URL 或缺终止证据时不冻结 |
| HTML 体积和运行时间超预期 | 首次运行记录字节数/耗时，再决定压缩或数据库 | 无测量证据前不引入复杂存储 |
| Excel 语义被误读 | 逐列映射 + 3 个手算案例 | 任一列/公式无法解释时 M4 不完成 |
| CDP 暴露本机会话 | loopback + 专用 profile | 非 loopback CDP 立即拒绝 |
| 过早复杂化 | 单进程、文件批次、单并发默认值 | 在真实规模证据前不引入队列/微服务 |
