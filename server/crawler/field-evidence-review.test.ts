import { expect, it } from "vite-plus/test";
import { CAPTURE_VERSION, itemFromAttributes } from "./compact";
import { captureIssues } from "./capture-readiness";
import { MAIN_TABS } from "./detail-tabs";
import { equipmentCaptureSummary } from "./equipment-capture";
import { fieldEvidence } from "./field-evidence";
import { petCaptureSummary } from "./pet-capture-summary";
import { normalizeValuationSource, ROLE_NUMERIC_FIELDS } from "./valuation-source";
import { CrawlStore } from "./store";
import type { Listing, RoleDetail, TabSnapshot } from "./types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const listing = { serverId: "367", eid: "independent-field-evidence" };
const collectedAt = "2026-11-15T14:00:00.000Z";
const revision = "a".repeat(64);
const itemFor = (detail: RoleDetail): Listing => ({
  ...listing,
  key: `${listing.serverId}:${listing.eid}`,
  url: detail.url,
  ordersn: "field-contract-fixture",
  sellingTime: null,
  createdTime: null,
  orderTime: null,
  name: "独立字段样本",
  price: "100",
  attrs: {},
  summary: null,
});

function tab(name: string, contentText: string): TabSnapshot {
  return {
    name,
    contentText,
    text: contentText,
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  };
}

function source(
  riders: Record<string, unknown> = { one: { iGrow: 230, exgrow: 0, mattrib: "力量" } },
) {
  return normalizeValuationSource({
    ...listing,
    riders,
    advancedMount: { isJinJie: 0 },
    hasArtifact: false,
    artifact: null,
    idEffects: [],
    goldIdFlag: false,
    allSkills: { 230: 40, 237: 20 },
    holyLevel: 0,
    assets: { iCash: 0, iSaving: 0, iLearnCash: 0, xianyu: 0 },
  });
}

function refreshEvidence(detail: RoleDetail): RoleDetail {
  detail.sourceEvidence = {
    version: 1,
    ...listing,
    initialRevision: revision,
    finalRevision: revision,
    stable: true,
    fields: fieldEvidence(detail.tabs, detail.valuation),
  };
  return detail;
}

function complete(): RoleDetail {
  const person = tab("人物/修炼", "名称：独立字段样本\n等级：175\n攻击修炼：25/25");
  person.fields = [
    { name: "名称", value: "独立字段样本" },
    { name: "等级", value: "175" },
    { name: "攻击修炼", value: "25/25" },
  ];
  const skills = tab("技能", "师门技能\n生活技能\n辅助技能");
  skills.items = ["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((name, index) => ({
    index,
    name: "独立师门" + name,
    level: "150",
    kind: "skill",
    category: "师门技能",
  }));
  skills.items.push(
    { index: 7, name: "强身术", level: "140", kind: "skill", category: "技能" },
    { index: 8, name: "烹饪技巧", level: "140", kind: "skill", category: "技能" },
  );
  const equipment = tab("道具/法宝", "暂无道具");
  equipment.equipmentEmptyProof = "official-containers";
  equipment.equipmentContainers = ["RoleUsingEquips", "RoleStoreEquips"].map((id) => ({
    id,
    present: true,
    visible: true,
    icons: [],
  }));
  const pets = tab("召唤兽/孩子", "召唤兽(0/10)\n无召唤兽");
  pets.petCount = 0;
  pets.pets = [];
  const mounts = tab("坐骑", "名称：仙鹿\n坐骑成长：2.3");
  mounts.fields = [
    { name: "名称", value: "仙鹿" },
    { name: "坐骑成长", value: "2.3" },
  ];
  const clothes = tab("锦衣/外观", "锦衣：青花瓷\n祥瑞：浪淘沙");
  clothes.fields = [
    { name: "锦衣", value: "青花瓷" },
    { name: "祥瑞", value: "浪淘沙" },
  ];
  const home = tab("玩家之家", "房屋：豪宅\n庭院：大型庭院");
  home.fields = [
    { name: "房屋", value: "豪宅" },
    { name: "庭院", value: "大型庭院" },
  ];
  const tabs = [person, skills, equipment, pets, mounts, clothes, home];
  return refreshEvidence({
    captureMode: "all",
    captureVersion: CAPTURE_VERSION,
    url: "https://xyq.cbg.163.com/equip?s=367&eid=independent-field-evidence",
    collectedAt,
    tabs,
    raw: {},
    valuation: source(),
    equipmentCapture: equipmentCaptureSummary(tabs, collectedAt),
    petCapture: petCaptureSummary(0, [], collectedAt),
  });
}

function contentEvidence(detail: RoleDetail, name: string) {
  return detail.sourceEvidence?.fields.find((field) => field.path === `tabs.${name}.content`);
}

it("keeps an official model name distinct from an element name in the field ledger", () => {
  const item = itemFromAttributes(
    {
      data_equip_type: "900101",
      data_official_model_metadata: JSON.stringify({
        modelId: "900101",
        records: [{ name: "官方模型物品", category: "材料" }],
      }),
    },
    0,
  );
  expect(item.nameSource).toBe("official-model");
  const snapshot = tab("道具/法宝", "官方模型物品");
  snapshot.items = [item];
  expect(fieldEvidence([snapshot])).toContainEqual({
    path: "tabs.道具/法宝.items[0].name",
    source: "official-model",
    state: "observed",
  });
});

const categoryCases: Array<{
  source: "official-slot" | "description";
  attrs: Record<string, string>;
}> = [
  {
    source: "official-slot",
    attrs: {
      data_equip_name: "明确槽位头盔",
      data_equip_type: "900102",
      data_equip_location: "role_using_equip_1",
    },
  },
  {
    source: "description",
    attrs: {
      data_equip_name: "说明中的法宝",
      data_equip_type: "900103",
      data_equip_desc: "灵气：30#r修炼境界：5",
    },
  },
];
it.each(categoryCases)(
  "preserves the $source category origin in the field ledger",
  ({ source, attrs }) => {
    const item = itemFromAttributes(attrs, 0);
    expect(item.categorySource).toBe(source);
    const snapshot = tab("道具/法宝", item.name);
    snapshot.items = [item];
    expect(fieldEvidence([snapshot])).toContainEqual({
      path: "tabs.道具/法宝.items[0].category",
      source,
      state: "observed",
    });
  },
);

it("accepts the independent complete baseline through actual readiness checks", () => {
  const detail = complete();
  expect(captureIssues(detail, true, true, listing)).toEqual([]);
  for (const name of ["坐骑", "锦衣/外观", "玩家之家"])
    expect(contentEvidence(detail, name)).toMatchObject({ state: "observed" });
});

const invalidRoleNumbers: unknown[] = [undefined, null, "0", true, -1, NaN, Infinity];
it.each(ROLE_NUMERIC_FIELDS.flatMap((field) => invalidRoleNumbers.map((raw) => ({ field, raw }))))(
  "marks missing/invalid $field.path=$raw unknown and prevents a complete save",
  ({ field, raw }) => {
    const detail = complete();
    const input = structuredClone(detail.valuation!.source);
    const parent = field.key === "holyLevel" ? input : (input.assets as Record<string, unknown>);
    if (raw === undefined) delete parent[field.key];
    else parent[field.key] = raw;
    detail.valuation = normalizeValuationSource(input);
    refreshEvidence(detail);
    expect(detail.valuation.fields.some((entry) => entry.name === field.name)).toBe(false);
    expect(detail.valuation.issues).toContain(
      `${field.name}（${field.path}）${raw === undefined ? "缺失" : "无效"}，需补采`,
    );
    expect(detail.sourceEvidence!.fields).toContainEqual({
      path: `valuation.source.${field.path}`,
      source: "official-role-parser",
      state: "unknown",
    });
    expect(
      captureIssues(detail, true, true, listing).some((issue) => issue.includes(field.path)),
    ).toBe(true);
    const stored: Listing = {
      ...listing,
      key: `${listing.serverId}:${listing.eid}`,
      url: detail.url,
      ordersn: "numeric-field-fixture",
      sellingTime: null,
      createdTime: null,
      orderTime: null,
      name: "独立字段样本",
      price: "100",
      attrs: {},
      summary: null,
    };
    const store = new CrawlStore(":memory:");
    try {
      store.observe(stored);
      expect(store.save(stored, detail)).toBe(false);
      expect(store.count()).toBe(0);
    } finally {
      store.close();
    }
  },
);
it.each([0.5, 10])(
  "rejects an out-of-contract holy level %s without inventing unascended zero",
  (holyLevel) => {
    const detail = complete();
    detail.valuation = normalizeValuationSource({ ...detail.valuation!.source, holyLevel });
    refreshEvidence(detail);
    expect(detail.valuation.fields.some((field) => field.name === "化圣层数")).toBe(false);
    expect(detail.sourceEvidence!.fields).toContainEqual({
      path: "valuation.source.holyLevel",
      source: "official-role-parser",
      state: "unknown",
    });
    expect(captureIssues(detail, true, true, listing)).toContain(
      "化圣层数（holyLevel）无效，需补采",
    );
  },
);
it.each([undefined, null, [], false, "0"])(
  "records every currency as unknown when its container is unreadable: %j",
  (assets) => {
    const detail = complete();
    detail.valuation = normalizeValuationSource({ ...detail.valuation!.source, assets });
    refreshEvidence(detail);
    for (const field of ROLE_NUMERIC_FIELDS.slice(1)) {
      expect(detail.sourceEvidence!.fields).toContainEqual({
        path: `valuation.source.${field.path}`,
        source: "official-role-parser",
        state: "unknown",
      });
      expect(
        captureIssues(detail, true, true, listing).some((issue) => issue.includes(field.path)),
      ).toBe(true);
    }
  },
);
it("preserves explicitly unascended and zero balances as observed values with separate field origins", () => {
  const detail = complete();
  for (const field of ROLE_NUMERIC_FIELDS) {
    expect(detail.valuation!.fields).toContainEqual({
      name: field.name,
      value: "0",
      tab: field.tab,
    });
    expect(detail.sourceEvidence!.fields).toContainEqual({
      path: `valuation.source.${field.path}`,
      source: "official-role-parser",
      state: "observed",
    });
  }
  expect(
    detail.sourceEvidence!.fields.some((field) => field.path === "valuation.source.assets"),
  ).toBe(false);
  expect(captureIssues(detail, true, true, listing)).toEqual([]);
});
it("does not infer required role cash/holy fields from an equipment-market identity and price", () => {
  const product = {
    serverId: "367",
    eid: "market-equip",
    category: "equip",
    price: 123,
    level: 100,
  };
  const valuation = normalizeValuationSource(product);
  for (const field of ROLE_NUMERIC_FIELDS) {
    expect(valuation.issues.some((issue) => issue.includes(`（${field.path}）`))).toBe(false);
    expect(
      fieldEvidence([], valuation).some((entry) => entry.path === `valuation.source.${field.path}`),
    ).toBe(false);
  }
});

it.each(["unknown", "old-summary"])(
  "revalidates archived numeric source instead of trusting cleared issues or %s receipts",
  (ledger) => {
    const detail = complete();
    const input = structuredClone(detail.valuation!.source);
    delete input.holyLevel;
    delete (input.assets as Record<string, unknown>).iCash;
    detail.valuation = normalizeValuationSource(input);
    detail.valuation.issues = []; // An older v10 archive never recorded these missing fields.
    refreshEvidence(detail);
    if (ledger === "old-summary")
      detail.sourceEvidence!.fields = detail
        .sourceEvidence!.fields.filter(
          (field) =>
            !ROLE_NUMERIC_FIELDS.some(
              (required) => field.path === `valuation.source.${required.path}`,
            ),
        )
        .concat({
          path: "valuation.source.assets",
          source: "official-role-parser",
          state: "observed",
        });
    const issues = captureIssues(detail, true, true, listing);
    expect(issues).toContain("化圣层数（holyLevel）缺失，需补采");
    expect(issues).toContain("现金（assets.iCash）缺失，需补采");
    const item: Listing = {
      ...listing,
      key: `${listing.serverId}:${listing.eid}`,
      url: detail.url,
      ordersn: "archived-field-fixture",
      sellingTime: null,
      createdTime: null,
      orderTime: null,
      name: "独立字段样本",
      price: "100",
      attrs: {},
      summary: null,
    };
    const store = new CrawlStore(":memory:");
    try {
      store.observe(item);
      expect(store.save(item, detail)).toBe(false);
      expect(store.count()).toBe(0);
    } finally {
      store.close();
    }
  },
);

it.each(ROLE_NUMERIC_FIELDS)(
  "requires a unique individual $path receipt even when archived values and issues are valid",
  (field) => {
    for (const kind of ["missing", "summary", "unknown", "wrong-source", "duplicate"] as const) {
      const detail = complete();
      const path = `valuation.source.${field.path}`;
      detail.sourceEvidence!.fields = detail.sourceEvidence!.fields.filter(
        (entry) => entry.path !== path,
      );
      if (kind === "summary")
        detail.sourceEvidence!.fields.push({
          path: "valuation.source.assets",
          source: "official-role-parser",
          state: "observed",
        });
      if (kind === "unknown")
        detail.sourceEvidence!.fields.push({
          path,
          source: "official-role-parser",
          state: "unknown",
        });
      if (kind === "wrong-source")
        detail.sourceEvidence!.fields.push({ path, source: "visible-text", state: "observed" });
      if (kind === "duplicate")
        detail.sourceEvidence!.fields.push(
          ...Array.from({ length: 2 }, () => ({
            path,
            source: "official-role-parser" as const,
            state: "observed" as const,
          })),
        );
      expect(captureIssues(detail, true, true, listing)).toContain(
        `${field.name}（${field.path}）逐字段来源未核验，需补采`,
      );
    }
  },
);

it("requires numeric fields for an explicit role capture even after all source groups have disappeared", () => {
  const detail = complete();
  detail.valuation = { version: 1, fields: [], issues: [], source: { ...listing } };
  refreshEvidence(detail);
  for (const field of ROLE_NUMERIC_FIELDS) {
    expect(detail.sourceEvidence!.fields).toContainEqual({
      path: `valuation.source.${field.path}`,
      source: "official-role-parser",
      state: "unknown",
    });
    expect(captureIssues(detail, true, true, listing)).toContain(
      `${field.name}（${field.path}）缺失，需补采`,
    );
  }
});

it.each([
  "wrong-eid",
  "wrong-server",
  "different-hash",
  "empty-hash",
  "non-hash",
  "null-hash",
  "numeric-stable",
  "false-stable",
  "wrong-version",
  "missing-fields",
])("rejects archived source evidence %s rather than trusting its stable claim", (kind) => {
  const detail = complete();
  const evidence = detail.sourceEvidence!;
  if (kind === "wrong-eid") evidence.eid = "another-role";
  if (kind === "wrong-server") evidence.serverId = "999";
  if (kind === "different-hash") evidence.finalRevision = "b".repeat(64);
  if (kind === "empty-hash") evidence.initialRevision = evidence.finalRevision = "";
  if (kind === "non-hash") evidence.initialRevision = evidence.finalRevision = "synthetic-revision";
  if (kind === "null-hash") evidence.initialRevision = evidence.finalRevision = null;
  if (kind === "numeric-stable") Reflect.set(evidence, "stable", 1);
  if (kind === "false-stable") evidence.stable = false;
  if (kind === "wrong-version") Reflect.set(evidence, "version", 2);
  if (kind === "missing-fields") Reflect.deleteProperty(evidence, "fields");
  const issues = captureIssues(detail, true, true, listing);
  expect(issues.some((issue) => issue.includes("详情") && issue.includes("来源"))).toBe(true);
  const store = new CrawlStore(":memory:");
  try {
    const item = itemFor(detail);
    store.observe(item);
    expect(store.save(item, detail)).toBe(false);
    expect(store.count()).toBe(0);
  } finally {
    store.close();
  }
});
it("uses independent detail URL/valuation identity without a listing and refuses a conflict or ledger-only identity", () => {
  const detail = complete();
  expect(captureIssues(detail, true)).toEqual([]);
  detail.url = "not-a-product-url";
  expect(captureIssues(detail, true)).toEqual([]); // Observed valuation identity remains independent of the ledger.
  detail.url = "https://xyq.cbg.163.com/equip?s=367&eid=another-role";
  expect(captureIssues(detail, true)).toContain("详情URL与角色来源商品身份冲突，需补采");
  detail.url = "not-a-product-url";
  detail.valuation!.source = {};
  expect(captureIssues(detail, true)).toContain("详情字段来源商品身份无法独立核验，需补采");
});
it("revalidates a stored v10 archive before it can be reused as complete", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cbg-field-contract-"));
  const file = path.join(directory, "archive.sqlite");
  const valid = complete(),
    item = itemFor(valid);
  let store = new CrawlStore(file);
  try {
    store.observe(item);
    expect(store.save(item, valid)).toBe(true);
    const archive = complete();
    delete archive.valuation!.source.holyLevel;
    delete (archive.valuation!.source.assets as Record<string, unknown>).iCash;
    archive.valuation!.issues = [];
    archive.sourceEvidence!.eid = "another-role";
    archive.sourceEvidence!.finalRevision = null;
    store.db
      .prepare("UPDATE listings SET detail_json=?,status='complete',error=NULL WHERE key=?")
      .run(JSON.stringify(archive), item.key);
    store.close();
    store = new CrawlStore(file);
    expect((store.detail(item.key) as { status: string } | undefined)?.status).toBe("failed");
    expect(store.observe(item)).toBe(false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const name of ["坐骑", "锦衣/外观", "玩家之家"]) {
  it.each([undefined, "", " \n\t "])(
    `blocks ${name} when loaded content is missing or blank despite retained navigation: %j`,
    (contentText) => {
      const detail = complete();
      const target = detail.tabs.find((entry) => entry.name === name)!;
      target.contentText = contentText;
      target.text = `价格：￥1000\n${MAIN_TABS.join("\n")}\n已选中：${name}`;
      target.fields = [];
      target.tables = [];
      target.items = [];
      refreshEvidence(detail);
      expect(contentEvidence(detail, name)).toMatchObject({ state: "unknown" });
      expect(captureIssues(detail, true, true, listing).some((issue) => issue.includes(name))).toBe(
        true,
      );
    },
  );
}

it.each([
  ["坐骑", "坐骑：加载中，请稍后"],
  ["锦衣/外观", "锦衣：加载中，请稍后"],
  ["玩家之家", "房屋：加载中，请稍后"],
  ["坐骑", "暂无坐骑信息，请稍后重试"],
  ["锦衣/外观", "暂无锦衣信息\n暂无祥瑞信息，请稍后重试"],
  ["玩家之家", "暂无房屋信息，请稍后重试"],
])("keeps %s partial for a loading or unavailable-data message: %s", (name, contentText) => {
  const detail = complete();
  const target = detail.tabs.find((entry) => entry.name === name)!;
  target.contentText = contentText;
  target.text = `价格：￥1000\n${MAIN_TABS.join("\n")}\n${contentText}`;
  target.fields = [];
  target.tables = [];
  target.items = [];
  refreshEvidence(detail);
  const issues = captureIssues(detail, true, true, listing);
  expect(contentEvidence(detail, name)).toMatchObject({ state: "unknown" });
  expect(issues.some((issue) => issue.includes(name))).toBe(true);
});

it.each([
  ["锦衣/外观", "无锦衣\n无祥瑞"],
  ["玩家之家", "无房屋\n无庭院"],
  ["坐骑", "无坐骑"],
])(
  "accepts explicit absence in %s without treating missing content as zero",
  (name, contentText) => {
    const detail = complete();
    const target = detail.tabs.find((entry) => entry.name === name)!;
    target.contentText = contentText;
    target.text = contentText;
    target.fields = [];
    target.tables = [];
    target.items = [];
    if (name === "坐骑") detail.valuation = source({});
    refreshEvidence(detail);
    expect(contentEvidence(detail, name)).toMatchObject({ state: "explicit-empty" });
    expect(captureIssues(detail, true, true, listing)).toEqual([]);
  },
);
