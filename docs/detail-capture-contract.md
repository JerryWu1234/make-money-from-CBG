# 详情资料统一核验与失败复现

详情未通过完整性校验时保存部分资料和缺失原因，不进入完整商品库或角色分析。已有的本轮最多三次读取和失败隔离机制继续适用。规则不按角色 ID、商品 ID 或某个装备名称分支。

## 统一规则

- `isNonRoleEquipment` 为物品读取、人物装备校验、空库存判断提供相同分类。分类同时记录 `categorySource`；描述中出现“灵气”等文字形成的推测不能单独证明库存为空。
- 分类针对人物装备范围。读取召唤兽自身资料时，仍需读取其装备属性，不能因为它不属于人物装备而跳过。
- 空库存必须核对穿戴和随身区域的存在、可见性及其他已出现的装备区域。每个物品图标须有独立的已读记录，并有明确的非人物装备依据。未知型号、未读说明、身份不符、隐藏区域及记录数量不足仍然阻止通过。图片和它的外层带元数据节点只计算一个图标。
- 名称从同一图标的有效元素属性、官网 `CBG_GAME_CONFIG.equip_info[modelId].name` 或关联提示框提取。占位文字和属性行不是名称；提示框标题不要求位于第一行。无关联 ID 时，多个不同的可见提示框不能拼接为一件物品。记录 `nameSource`；原元素名称的空白保持原样。
- `readDetailIdentity` 统一读取页面的 `EquipInfo` / `equip` 详情对象，包括不挂在 `window` 上的顶层变量。只接受明确的 `server_id` / `eid`；配置表 `equip_info`、URL 和列表预期 ID 不补缺失身份。多个来源冲突或解析期间身份变化阻止通过。穿戴装备原档补充和本体解析使用相同身份规则。
- 补采失败显示具体商品及原因；转入正常发现阶段清除旧的当前商品和详情进度提示。数据库中的失败原因仍保留。

## 可复现用例

`server/crawler/compact.test.ts` 的“同一分类证据用于任意非人物物品”覆盖多种技能书和材料，以及缺说明、缺名称和重复图标缺对应记录的边界。“占位或属性文字不能遮蔽”覆盖有效名称被无效属性遮挡。

`server/crawler/detail.test.ts` 的“所有角色共用名称”使用临时 Chrome 和本地模拟页面，覆盖官网型号名称、非首行标题、未知名称及多个提示框。成功路径经正常 `CrawlSource.detail` 完整性校验后写入内存 SQLite。原有未知物品和名称空白边界同时保留。

`server/crawler/valuation-identity.browser.test.ts` 覆盖普通全局对象、顶层 `const`、替代详情对象、缺失/非法身份、完整或部分来源冲突、无关配置表和解析期间身份变化。

`server/crawler/watch.test.ts` 验证补采失败后仍正常发现，同时清除上一阶段提示。

```sh
vp test server/crawler/compact.test.ts server/crawler/watch.test.ts --run
vp test server/crawler/detail.test.ts server/crawler/valuation-identity.browser.test.ts --run
vp check
vp run build
```

在 Codex/macOS 中，第二条会启动临时隔离 Chrome，须按 `AGENTS.md` 经沙箱外审批执行；正式源码全量回归 `vp test server src tests --run --maxWorkers=2` 同样适用。限定目录避免运行 `data/diagnostics` 中保留的历史测试副本。不得使用真实采集配置作为浏览器测试目录。

这些用例证明公共规则及失败保护的行为。它们不能证明此前所有真实页面缺失字段的底层原因相同，也不等同于真实网站上的失败商品已补采成功。真实页面确实没有足够证据时，仍保留未完成状态。
