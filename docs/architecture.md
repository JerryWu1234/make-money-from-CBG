# macOS V1 最小架构

## 1. 目的地与假设

给定一个明确的采集范围，Collector 通过 CDP 附着用户专用 Chrome，使用 Stagehand 导航并完成必要页面动作，保存渲染后的 HTML。系统随后离线解析 HTML、冻结角色批次、套用 Excel 规则，并在 Vite 页面输出可重复、可解释的 Top N 排名。

当前假设：

- 前端采用 Vite + React + TypeScript；
- Stagehand v4 只运行在 Node.js Collector 中；
- “HTML”默认指页面稳定后的 `document.documentElement.outerHTML`，不是首次网络响应正文；
- 原始 HTML、结构化角色数据、分析结果分三层保存，互不覆盖；
- 文件、JSON/NDJSON 和 SHA-256 足以完成 MVP，不先引入数据库；
- Excel 先转换成安全的标准规则，不执行宏或任意单元格代码；
- 生产采集只能执行显式 `CrawlScope`，其授权与边界必须可审计。

## 2. 主数据流

```text
专用 Chrome
    │ CDP 127.0.0.1
    ▼
Stagehand Collector
  导航 → 等待 → 展开/分页 → 读取 rendered DOM HTML
    ▼
draft crawl run
  HTML snapshots + pages.ndjson + manifest
    │ 校验范围、终止证据、失败数和哈希
    ▼
frozen crawl run
    │ 离线、确定性 HTML parser
    ▼
frozen role batch (roles.ndjson)
    ├──────────────┐
    │              │
Excel adapter      │
    ▼              ▼
canonical rules + pure Analyzer
                    ▼
               analysis run
                    ▼
             Vite React viewer
```

## 3. 组件职责

| 组件 | 唯一职责 | 明确不做 |
|---|---|---|
| `collector` | Stagehand 经 CDP 导航 scope 内页面并保存 rendered HTML | 解析业务字段、评分、交易、风控规避 |
| `crawl-store` | 写 HTML、元数据、哈希，校验后原子冻结 crawl run | 修改已冻结快照 |
| `html-parser` | 离线把版本化 HTML 转为 `RoleListingV1` | 访问浏览器、执行 HTML 中的脚本、猜测缺失字段 |
| `batch-writer` | 校验角色记录并冻结 role batch | 读取在线页面、边抓边分析 |
| `excel-adapter` | 将工作簿映射为标准规则 JSON | 猜列、执行 VBA 或任意公式代码 |
| `analyzer` | 对 frozen role batch 做确定性过滤、评分和解释 | 访问浏览器或网络 |
| `web` | 展示采集/解析状态、Top N 和分项解释 | 运行 Stagehand、保存密钥、渲染原始 HTML |

Stagehand 的确定性 API（`goto`、`waitForSelector`、locator、`evaluate`）优先。`observe`/`act` 只用于确实需要自然语言定位的页面动作；不通过随机延迟、假输入或指纹修改模拟真人，也不将 `extract()` 输出直接写成 canonical 角色数据。

## 4. HTML 采集语义

### 4.1 页面稳定条件

每种 `pageKind` 必须定义自己的稳定条件：

1. `goto()` 等待 `domcontentloaded`；
2. 等待该页面的关键 selector；
3. 执行展开装备、技能或翻页等白名单动作；
4. 再等待关键 selector/计数达到预期；
5. 记录最终 URL 后读取 `document.documentElement.outerHTML`。

不能只依赖固定 sleep。达到超时、验证码、登录异常、未知弹窗或 URL 越界时，当前页面失败，任务不得伪装成完整。

### 4.2 rendered HTML 不包含什么

`outerHTML` 不保证包含 iframe 子文档、shadow DOM、canvas 内容或未触发懒加载。若 required fields 位于这些位置，应新增明确的 snapshot 类型，而不是仍宣称单一 HTML 已“全量”。

### 4.3 不可信数据处理

- HTML 原样存放在 `var/`，权限限制为当前用户，禁止提交 Git；
- 不采集 cookies、localStorage 或 CDP 凭证；
- HTML parser 禁止脚本执行，只做 DOM 解析；
- Vite 只读取结构化 JSON，不使用 `dangerouslySetInnerHTML` 展示快照；
- 提交到仓库的 fixture 必须脱敏，且单独生成，不修改 canonical 快照；
- 保留期限由 `CrawlScope` 指定，过期清理由独立运维动作执行。

## 5. 文件布局

保持单一 TypeScript 工程：

```text
src/
  browser/       # CDP connect 与 Stagehand 页面动作
  collector/     # scope、队列、去重、恢复、HTML capture
  crawl-store/   # raw crawl manifest 与 snapshot
  parser/        # HTML -> RoleListingV1
  contracts/     # Zod schema 与 TypeScript 类型
  batches/       # role batch draft/freeze/verify
  excel/         # 工作簿适配器
  analyzer/      # 纯函数评分
  web/           # React 页面
fixtures/
  html/          # synthetic/脱敏页面样本
  roles/         # canonical 角色样本
var/              # 运行数据；加入 .gitignore
docs/
```

命令边界：

```text
npm run crawl:fixture
npm run crawl -- --scope <scope.json>
npm run crawl:verify -- <crawl-dir>
npm run parse:html -- <crawl-dir>
npm run batch:verify -- <batch-dir>
npm run excel:convert -- <input.xlsx>
npm run analyze -- <batch-dir> <rules.json>
npm run dev
```

## 6. 数据契约

### 6.1 采集范围 `CrawlScopeV1`

```ts
type CrawlScopeV1 = {
  schemaVersion: 1;
  scopeId: string;
  sourceKind: "fixture" | "authorized-cbg";
  authorizationRef?: string;
  allowedHosts: string[];
  seedUrls: string[];
  serverIds: string[];
  allowedPageKinds: Array<"server-list" | "role-list" | "role-detail">;
  limits: {
    maxPages: number;
    maxDepth: number;
    concurrency: number;
  };
  retentionDays: number;
};
```

生产 scope 必须包含 `authorizationRef`，所有导航前后都校验 HTTPS、host、page kind 和 limit。MVP 默认单并发；任何频率调整都来自 scope，而不是反检测逻辑。

### 6.2 HTML 快照 `HtmlSnapshotV1`

```ts
type HtmlSnapshotV1 = {
  schemaVersion: 1;
  runId: string;
  snapshotId: string;
  pageKind: "server-list" | "role-list" | "role-detail";
  requestedUrl: string;
  finalUrl: string;
  parentSnapshotId?: string;
  serverId?: string;
  listingIdHint?: string;
  capturedAt: string;
  htmlFile: string;
  htmlSha256: string;
  byteLength: number;
};
```

HTML 文件与 metadata 分开保存，metadata 不内嵌大字符串。相同 canonical URL 在同一 run 中只采集一次，除非 scope 明确允许分页状态产生不同 snapshot key。

### 6.3 Crawl manifest `CrawlManifestV1`

```ts
type CrawlManifestV1 = {
  schemaVersion: 1;
  runId: string;
  scopeId: string;
  scopeSha256: string;
  authorizationRef?: string;
  state: "draft" | "frozen" | "failed";
  discoveredUrlCount: number;
  capturedPageCount: number;
  failedUrls: Array<{ url: string; reason: string }>;
  terminalEvidence: Array<{
    serverId: string;
    lastListUrl: string;
    discoveredRoleCount: number;
  }>;
  pagesIndexSha256: string;
  startedAt: string;
  frozenAt?: string;
};
```

只有满足以下条件才可 frozen：所有 URL 在 scope 内；每个服务器有分页终止证据；发现的详情集合与成功快照集合一致；`failedUrls` 为空；HTML 和 index 哈希全部有效。部分结果可保留为 draft/failed，但不能交给正式 parser 冒充完整批次。

目录约定：

```text
var/crawls/<run-id>/manifest.json
var/crawls/<run-id>/pages.ndjson
var/crawls/<run-id>/pages/<snapshot-id>.html
```

### 6.4 角色记录 `RoleListingV1`

```ts
type RoleListingV1 = {
  schemaVersion: 1;
  listingId: string;
  source: {
    crawlRunId: string;
    snapshotId: string;
    parserVersion: string;
    capturedAt: string;
  };
  server: { id?: string; name: string };
  askingPriceYuan: number;
  role: {
    level?: number;
    school?: string;
    attributes: Record<string, number | string | boolean | null>;
  };
  equipment: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  extras: Record<string, unknown>;
  coverage: {
    observedFields: string[];
    missingRequiredFields: string[];
  };
};
```

Parser 输出必须能追溯到具体 HTML snapshot 和 parser 版本。`missingRequiredFields` 非空时，该记录不能计入“全量完整”批次。

### 6.5 Role batch、规则与分析结果

`BatchManifestV1` 增加 `crawlRunId`、`parserVersion`、`parseFailureCount` 和 `rolesSha256`。Analyzer 只接受 frozen crawl 派生、记录完整、计数匹配且哈希有效的 frozen role batch。

Excel 输出保持 `RuleSetV1`：包含 workbook SHA-256、case、硬过滤和白名单评分项。`AnalysisRunV1` 至少包含 batch/rule/case/listing ID、总分、价格、分项贡献、入选或排除原因及稳定并列键。

## 7. 最小评分原则

Excel 到达前不臆造公式：先硬过滤，再逐项记录原始值、归一化值、权重和贡献，最后按明示规则聚合及稳定排序。若真实目标是估值折扣或转售收益率，应单独定义和验收。

## 8. 可验证成功标准

1. Stagehand 经 loopback CDP 打开本地动态 fixture，完成一次展开动作，并保存含展开内容的 rendered HTML。
2. HTML snapshot 的 URL、字节数和 SHA-256 可验证；篡改后 `crawl:verify` 必须失败。
3. 同一 HTML 与同一 parser 版本连续解析两次，`RoleListingV1` 内容哈希相同。
4. 缺页、解析失败、无分页终止证据或 required field 缺失时，crawl/role batch 不能 frozen。
5. 同一 frozen role batch 与 rule set 连续分析两次，排名和解释完全一致。
6. Vite 可展示采集、解析和分析状态，但永不执行或直接渲染原始 HTML。
7. 非 loopback CDP、scope 外 URL、无 `authorizationRef` 的生产 scope、验证码或访问限制均立即停止。
8. 项目没有自动购买、支付、议价、上架、验证码绕过或风控规避代码。

## 9. 暂不做

- 未确认授权范围的全服生产运行和定时任务；
- 网络接口逆向、响应拦截作为主数据源；
- 云端浏览器、代理池、多账号并发；
- 数据库、消息队列、微服务和桌面打包；
- Windows 托盘、自启动和 Service；
- 自动交易或价格预测模型。
