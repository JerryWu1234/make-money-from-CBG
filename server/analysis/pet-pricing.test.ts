import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import type { PetSnapshot, SavedRoleRecord } from "../crawler/types";
import { compareListingPrice } from "./valuation-calculator";
import type { ValuationResult } from "./valuation-types";
import type { EquipmentCandidate } from "./equipment-pricing";
import { GLOBAL_MARKET_SCOPE_VERSION, MARKET_SEARCH_UI_VERSION } from "./market-scope";
import {
  combinePetPricing,
  petInventory,
  searchPetPricing,
  verifyPetCandidate,
} from "./pet-pricing";

const makePet = (index = 1): PetSnapshot => ({
  index,
  name: "主人自定义昵称",
  fields: [
    { name: "类型", value: "画魂" },
    { name: "等级", value: "119" },
    { name: "携带等级", value: "105" },
    { name: "是否宝宝", value: "是" },
    { name: "成长", value: "1.28" },
    { name: "攻击资质", value: "1200" },
    { name: "防御资质", value: "1400" },
    { name: "体力资质", value: "5000" },
    { name: "法力资质", value: "2800" },
    { name: "速度资质", value: "1200" },
    { name: "躲闪资质", value: "1100" },
    { name: "灵性", value: "110" },
    { name: "成品状态", value: "成品" },
    { name: "气血", value: "3000/5000" },
    { name: "寿命", value: "5000" },
    { name: "名称", value: "主人自定义昵称" },
  ],
  skills: ["须弥真言", "高级法术暴击", "高级法术波动"].map((name, index) => ({
    name,
    index,
    kind: "skill",
  })),
  innerSkills: [{ index: 0, name: "催心浪", level: "5", kind: "innerSkill" }],
  equipment: [],
});
const allocatedPet = () => {
  const pet = makePet();
  pet.fields.push(
    ...[
      ["体质", "316"],
      ["魔力", "191"],
      ["力量", "878"],
      ["耐力", "181"],
      ["敏捷", "184"],
      ["潜能", "0"],
      ["攻击", "1806"],
      ["防御", "788"],
      ["速度", "225"],
      ["法伤", "769"],
      ["法防", "769"],
    ].map(([name, value]) => ({ name, value })),
  );
  return pet;
};
const setField = (pet: PetSnapshot, name: string, value: string) => {
  pet.fields.find((field) => field.name === name)!.value = value;
  return pet;
};
const similarPet = () => {
  const pet = allocatedPet();
  for (const [name, value] of [
    ["攻击资质", "1230"],
    ["防御资质", "1380"],
    ["速度资质", "1280"],
    ["躲闪资质", "1150"],
    ["体质", "394"],
    ["力量", "800"],
    ["攻击", "1740"],
    ["防御", "820"],
    ["速度", "230"],
  ])
    setField(pet, name, value);
  return pet;
};
function recordWithPets(pets = [makePet()]): SavedRoleRecord {
  const record = valuationRecord();
  record.detail!.petCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.tabs = record.detail!.tabs.filter((tab) => tab.name !== "召唤兽/孩子");
  record.detail!.tabs.push({
    name: "召唤兽/孩子",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    pets,
    petCount: pets.length,
  });
  return record;
}
const fieldText = (pet = makePet()) =>
  pet.fields
    .filter((field) => !["气血", "寿命", "名称"].includes(field.name))
    .map((field) => field.name + "：" + field.value)
    .join("\n");
const image = (attrs: Record<string, string>) =>
  "<img " +
  Object.entries(attrs)
    .map(([key, value]) => key + "='" + value + "'")
    .join(" ") +
  ">";
function sourcePage(price = 1000, pet = makePet(), icons = false) {
  return (
    "<main><h1>召唤兽</h1><pre>" +
    fieldText(pet) +
    "</pre>" +
    (icons
      ? pet.skills
          .map((skill) => image({ data_equip_name: skill.name, data_skill_type: "cifu" }))
          .join("")
      : "<p>技能：" + (pet.skills.map((skill) => skill.name).join("、") || "无") + "</p>") +
    (icons
      ? pet.innerSkills
          .map((skill) =>
            image({
              data_equip_name: skill.name,
              data_skill_type: "neidan",
              data_equip_level: skill.level!,
            }),
          )
          .join("")
      : "<p>内丹：" +
        (pet.innerSkills.map((skill) => skill.name + "(" + skill.level + "层)").join("、") ||
          "无") +
        "</p>") +
    (pet.equipment.length
      ? pet.equipment
          .map((gear) =>
            image({
              data_equip_name: gear.name,
              data_equip_desc: gear.description!.replace(/\n/g, "#r"),
              ...(gear.location ? { data_equip_location: gear.location } : {}),
            }),
          )
          .join("")
      : "<p>宝宝装备：无</p>") +
    "<p>在售</p><p>挂牌价：¥" +
    price +
    "</p></main>"
  );
}
const candidate = (price = 1000, id = "sample-a"): EquipmentCandidate => ({
  url: "https://xyq.cbg.163.com/equip/367/" + id,
  title: "模拟测试宝宝样本",
  price,
  priceType: "listing",
  quote: "挂牌价：¥" + price,
  verified: false,
  reason: "",
  fetchedAt: null,
  sourceHash: null,
});
const response = (
  candidates = [candidate()],
  queries = ["梦幻西游电脑版 藏宝阁 全服 画魂 须弥真言"],
) => ({
  items: [{ key: "召唤兽/孩子:1", candidates, note: "", query: queries[0] }],
  queries,
  searchItems: queries.map((query, index) => ({
    id: "browser-search-" + index,
    type: "browser",
    query,
  })),
});

it("宝宝误报完成但精确组未读完时不计价，续查至穷尽后采用实际样本", async () => {
  const record = recordWithPets();
  const row = candidate(1000);
  const lookup = (exhausted: boolean) => ({
    ...response([row]),
    items: [{ key: "召唤兽/孩子:1", candidates: [row], searchState: "completed" as const }],
    searchItems: [{ key: "召唤兽/孩子:1", matchType: "exact", exhausted }],
  });
  const first = await searchPetPricing(record, new AbortController().signal, {
    findCandidates: async () => lookup(false),
    readSource: async () => sourcePage(1000),
  });
  expect(first).toMatchObject({ searchComplete: false, total: null, knownTotal: 0 });
  expect(first.items[0]).toMatchObject({ searchState: "pending", referencePrice: null });
  expect(first.items[0].issues.join("；")).not.toContain("本次结果已读完");
  const resumed = await searchPetPricing(
    record,
    new AbortController().signal,
    {
      findCandidates: async (items) => {
        expect(items[0].candidates).toHaveLength(1);
        return lookup(true);
      },
      readSource: async () => sourcePage(1000),
    },
    first,
  );
  expect(resumed).toMatchObject({ searchComplete: true, total: 1000, knownTotal: 1000 });
});
async function pricing(
  record = recordWithPets(),
  candidates = [candidate()],
  pages = new Map(candidates.map((value) => [value.url, sourcePage(value.price!)])),
) {
  const search = vi.fn().mockResolvedValue(response(candidates));
  const read = vi.fn(async (url: string) => pages.get(url)!);
  const snapshot = await searchPetPricing(record, new AbortController().signal, {
    findCandidates: search,
    readSource: read,
  });
  return { snapshot, search, read };
}
it("宝宝详情读取失败与真实空结果分别保存，恢复会重试读取失败", async () => {
  const record = recordWithPets();
  const signal = new AbortController().signal;
  const failed = await searchPetPricing(record, signal, {
    findCandidates: vi.fn().mockResolvedValue({
      ...response([]),
      items: [
        {
          key: "召唤兽/孩子:1",
          candidates: [],
          searchState: "read_failed",
          note: "18个独立详情读取失败",
        },
      ],
    }),
    readSource: vi.fn(),
  });
  expect(failed).toMatchObject({ searchComplete: false, total: null });
  expect(failed.items[0].searchState).toBe("read_failed");
  const find = vi.fn().mockResolvedValue(response([]));
  const empty = await searchPetPricing(
    record,
    signal,
    { findCandidates: find, readSource: vi.fn() },
    failed,
  );
  expect(find).toHaveBeenCalledOnce();
  expect(empty).toMatchObject({ searchComplete: true, total: null });
  expect(empty.items[0].searchState).toBe("completed");
  expect(empty.items[0].issues).not.toContain("18个独立详情读取失败");
  expect(empty.searchAttempts).toHaveLength(2);
  const readFailure = await searchPetPricing(record, signal, {
    findCandidates: vi.fn().mockResolvedValue(response()),
    readSource: vi.fn().mockRejectedValue(new Error("主商品区域未识别")),
  });
  expect(readFailure.items[0].searchState).toBe("read_failed");
  expect(readFailure.searchComplete).toBe(false);
});
const upstream = (value: number | null = 2000): ValuationResult => ({
  ...compareListingPrice(value, 4000),
  model_value: value,
  asking_price: 4000,
  known_subtotal: 2000,
  calculation_version: "price-comparison-v5",
  items: [],
  missing_fields: value === null ? ["装备尚未定价"] : [],
  pending_rules: [],
  reason: "前一步",
  next_action: "",
  bare_role_value: 1700,
  equipment_value: value === null ? null : 300,
});

it("同一宝宝的商品别名价格冲突时不任取报价，保留待重读状态", async () => {
  const rows = [
    candidate(1000),
    {
      ...candidate(2000),
      url: "https://xyq.cbg.163.com/equip?s=367&eid=sample-a",
    },
  ];
  const result = await searchPetPricing(recordWithPets(), new AbortController().signal, {
    findCandidates: async () => response(rows),
    readSource: async () => sourcePage(1000),
  });
  expect(result.items[0]).toMatchObject({ searchState: "read_failed", referencePrice: null });
  expect(result.items[0].candidates.at(-1)?.reason).toContain("报价冲突");
  expect(result.searchComplete).toBe(false);
  expect(result.total).toBeNull();
});

describe("宝宝来源核对与挂牌比价", () => {
  it("相似模式允许有界资质及普通加点和衍生性能差异，记录逐项差异", () => {
    const target = petInventory(recordWithPets([allocatedPet()])).items[0];
    const page = sourcePage(1000, similarPet());
    expect(verifyPetCandidate(target, candidate(), page, "now").verified).toBe(false);
    const verified = verifyPetCandidate(target, candidate(), page, "now", "similar");
    expect(verified).toMatchObject({ verified: true, matchType: "similar" });
    expect(verified.differences).toHaveLength(9);
    expect(verified.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining("攻击资质：目标 1200，样本 1230"),
        expect.stringContaining("力量：目标 878，样本 800"),
        expect.stringContaining("攻击：目标 1806，样本 1740"),
      ]),
    );
    expect(
      verifyPetCandidate(target, candidate(), sourcePage(1000, allocatedPet()), "now", "similar"),
    ).toMatchObject({ verified: true, matchType: "exact", differences: [] });
  });
  it.each([
    ["攻击资质", "1381"],
    ["速度资质", "1381"],
    ["攻击", "未知"],
    ["成长", "1.311"],
    ["等级", "125"],
    ["类型", "幽灵"],
    ["灵性", "109"],
    ["体质", "未知"],
  ])("相似模式拒绝超窗口或关键事实变化：%s", (name, value) => {
    const target = petInventory(recordWithPets([allocatedPet()])).items[0];
    const sample = setField(similarPet(), name, value);
    expect(
      verifyPetCandidate(target, candidate(), sourcePage(1000, sample), "now", "similar").verified,
    ).toBe(false);
  });
  it("相似模式保留资质和内丹差异，受保护技能、认证及装备包价仍须核验", () => {
    const targetPet = setField(allocatedPet(), "攻击资质", "1200 +22");
    const target = petInventory(recordWithPets([targetPet])).items[0];
    const sample = setField(similarPet(), "攻击资质", "1230 +22");
    expect(
      verifyPetCandidate(target, candidate(), sourcePage(1000, sample), "now", "similar").verified,
    ).toBe(true);
    const changed = [
      setField(structuredClone(sample), "攻击资质", "1230 +21"),
      setField(structuredClone(sample), "攻击资质", "1252"),
      { ...structuredClone(sample), skills: sample.skills.slice(1) },
      {
        ...structuredClone(sample),
        fields: [...sample.fields, { name: "认证技能", value: "雷击" }],
      },
    ];
    for (const pet of changed)
      expect(
        verifyPetCandidate(target, candidate(), sourcePage(1000, pet), "now", "similar").verified,
      ).toBe(false);
    const packageSample = {
      ...structuredClone(sample),
      innerSkills: [{ ...sample.innerSkills[0], level: "4" }],
      equipment: [
        {
          index: 0,
          kind: "equipment" as const,
          name: "宝宝项圈",
          description: "等级：85\n速度：30",
        },
      ],
    };
    const packageReference = verifyPetCandidate(
      target,
      candidate(),
      sourcePage(1000, packageSample),
      "now",
      "similar",
    );
    expect(packageReference.verified).toBe(false);
    expect(packageReference.reason).toContain("随身宝宝装备数量不匹配");
    const innerReference = verifyPetCandidate(
      target,
      candidate(),
      sourcePage(1000, { ...packageSample, equipment: [] }),
      "now",
      "similar",
    );
    expect(innerReference.verified).toBe(true);
    expect(innerReference.differences).toContainEqual(expect.stringContaining("内丹：目标"));
    const missing = structuredClone(sample);
    missing.fields = missing.fields.filter((field) => field.name !== "力量");
    expect(
      verifyPetCandidate(target, candidate(), sourcePage(1000, missing), "now", "similar").verified,
    ).toBe(false);
  });
  it("三件有效在售相似商品生成参考平均值与范围，不能写成exact金额或已核实小计", async () => {
    const record = recordWithPets([allocatedPet()]);
    const candidates = [900, 1000, 1100].map((price, index) => ({
      ...candidate(price, "similar-" + index),
      url: `https://xyq.cbg.163.com/equip?s=367&eid=similar-${index}`,
      matchType: "similar" as const,
    }));
    const pages = new Map(
      candidates.map((candidate) => [candidate.url, sourcePage(candidate.price!, similarPet())]),
    );
    const { snapshot } = await pricing(record, candidates, pages);
    expect(snapshot.items[0]).toMatchObject({
      status: "no_match",
      referencePrice: null,
      similarEstimate: {
        status: "range",
        sampleCount: 3,
        range: { min: 900, max: 1100 },
        median: 1000,
      },
    });
    expect(snapshot).toMatchObject({ total: null, knownTotal: 0 });
    expect(
      snapshot.items[0].candidates.every(
        (candidate) => candidate.verified && candidate.matchType === "similar",
      ),
    ).toBe(true);
    const result = combinePetPricing(upstream(), record, snapshot);
    expect(result).toMatchObject({
      decision: "NEED_INFO",
      pet_value: null,
      model_value: null,
      known_subtotal: 2000,
    });
    expect(result.items[0]).toMatchObject({ amount: null, confirmed: false, evidence: [] });
    const duplicate = [candidates[0], candidates[1], { ...candidates[1] }];
    expect(
      (await pricing(record, duplicate, pages)).snapshot.items[0].similarEstimate,
    ).toMatchObject({ status: "range", sampleCount: 2, average: 950 });
    const offPages = new Map(pages);
    offPages.set(candidates[2].url, pages.get(candidates[2].url)!.replace("在售", "商品已下架"));
    expect(
      (await pricing(record, candidates, offPages)).snapshot.items[0].similarEstimate,
    ).toMatchObject({ status: "range", sampleCount: 2, average: 950 });
  });
  it("不足十件且仍有详情失败时保存候选，保持未完成", async () => {
    const candidates = [900, 1000, 1100].map((price, index) => ({
      ...candidate(price, "similar-" + index),
      matchType: "similar" as const,
    }));
    const failed = { ...candidate(1200, "failed-extra"), matchType: "similar" as const };
    const read = vi.fn(async (url: string) => {
      if (url === failed.url) throw new Error("额外详情暂不可读");
      const sample = candidates.find((entry) => entry.url === url)!;
      return sourcePage(sample.price!, similarPet());
    });
    const snapshot = await searchPetPricing(
      recordWithPets([allocatedPet()]),
      new AbortController().signal,
      {
        findCandidates: vi.fn().mockResolvedValue(response([...candidates, failed])),
        readSource: read,
      },
    );
    expect(snapshot.items[0]).toMatchObject({
      searchState: "read_failed",
      referencePrice: null,
      similarEstimate: { status: "range", sampleCount: 3, median: 1000 },
    });
    expect(snapshot.searchComplete).toBe(false);
    expect(snapshot.items[0].candidates.find((entry) => entry.url === failed.url)).toMatchObject({
      verified: false,
      reason: "额外详情暂不可读",
    });
  });
  it("宽查询的真实详情诊断单独保留，即使3条均能过相似边界也不算报价区间", async () => {
    const record = recordWithPets([allocatedPet()]);
    const diagnostics = [900, 1000, 1100].map((price, index) => ({
      ...candidate(price),
      url: `https://xyq.cbg.163.com/equip?s=367&eid=diagnostic-${index}`,
      matchType: "similar" as const,
    }));
    const pages = new Map(
      diagnostics.map((candidate) => [candidate.url, sourcePage(candidate.price!, similarPet())]),
    );
    const snapshot = await searchPetPricing(record, new AbortController().signal, {
      findCandidates: vi.fn().mockResolvedValue({
        queries: ["/ exact /", "/ similar /", "/ diagnostic /"],
        items: [
          {
            key: "召唤兽/孩子:1",
            query: "/ diagnostic /",
            candidates: [],
            similarAttempted: true,
            diagnosticSources: diagnostics,
          },
        ],
      }),
      readSource: vi.fn(async (url: string) => pages.get(url)!),
    });
    expect(snapshot).toMatchObject({ total: null, knownTotal: 0 });
    expect(snapshot.items[0]).toMatchObject({
      status: "no_match",
      referencePrice: null,
      candidates: [],
      similarEstimate: { status: "insufficient", sampleCount: 0, range: null },
    });
    expect(snapshot.items[0].diagnosticSources).toHaveLength(3);
    expect(
      snapshot.items[0].diagnosticSources!.every(
        (candidate) =>
          !candidate.verified && candidate.sourceHash && candidate.reason.includes("诊断，不计价"),
      ),
    ).toBe(true);
  });
  it("失败的诊断来源保留原因，不为补价重复读取同一失败模板", async () => {
    const read = vi.fn();
    const snapshot = await searchPetPricing(recordWithPets(), new AbortController().signal, {
      findCandidates: vi.fn().mockResolvedValue({
        queries: ["/ diagnostic /"],
        items: [
          {
            key: "召唤兽/孩子:1",
            candidates: [],
            similarAttempted: true,
            diagnosticSources: [
              {
                ...candidate(),
                url: "https://xyq.cbg.163.com/equip?s=367&eid=diagnostic-failed",
                price: null,
                quote: "",
                reason: "主宝宝JSON详情未识别",
                matchType: "similar",
              },
            ],
          },
        ],
      }),
      readSource: read,
    });
    expect(read).not.toHaveBeenCalled();
    expect(snapshot.items[0].diagnosticSources![0]).toMatchObject({
      verified: false,
      price: null,
      sourceHash: null,
    });
    expect(snapshot.items[0].diagnosticSources![0].reason).toContain("主宝宝JSON详情未识别");
  });
  it("缺价的严格和相似候选保留失败原因不重读，诊断仍隔离且取消仍中止", async () => {
    const record = recordWithPets();
    const failed = (matchType: "exact" | "similar", id: string) => ({
      ...candidate(1000, id),
      price: null,
      quote: "",
      reason: "宝宝详情读取超时：" + id,
      matchType,
    });
    const result = {
      queries: ["/ exact /", "/ similar /", "/ diagnostic /"],
      items: [
        {
          key: "召唤兽/孩子:1",
          candidates: [failed("exact", "failed-exact"), failed("similar", "failed-similar")],
          similarAttempted: true,
          diagnosticSources: [failed("similar", "failed-diagnostic")],
        },
      ],
    };
    const search = vi.fn().mockResolvedValue(result);
    const read = vi.fn().mockRejectedValue(new Error("失败详情不应重读"));
    const snapshot = await searchPetPricing(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(read).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({ total: null, knownTotal: 0 });
    expect(snapshot.items[0]).toMatchObject({
      status: "no_match",
      referencePrice: null,
      similarEstimate: { status: "insufficient", sampleCount: 0, range: null },
    });
    expect(snapshot.items[0].candidates.map((value) => value.reason)).toEqual([
      "宝宝详情读取超时：failed-exact",
      "宝宝详情读取超时：failed-similar",
    ]);
    expect(snapshot.items[0].diagnosticSources).toHaveLength(1);
    expect(snapshot.items[0].diagnosticSources![0]).toMatchObject({
      verified: false,
      price: null,
      sourceHash: null,
    });
    expect(snapshot.items[0].diagnosticSources![0].reason).toContain("诊断，不计价");
    const controller = new AbortController();
    const cancellation = new Error("停止宝宝查价");
    search.mockImplementationOnce(async () => {
      controller.abort(cancellation);
      return result;
    });
    await expect(
      searchPetPricing(record, controller.signal, { findCandidates: search, readSource: read }),
    ).rejects.toBe(cancellation);
    expect(read).not.toHaveBeenCalled();
  });
  it("采集凭据与数量一致才能确认空宝宝为0；旧或数量不全不当0", async () => {
    const empty = recordWithPets([]),
      search = vi.fn(),
      read = vi.fn();
    expect(
      (
        await searchPetPricing(empty, new AbortController().signal, {
          findCandidates: search,
          readSource: read,
        })
      ).total,
    ).toBe(0);
    expect(search).not.toHaveBeenCalled();
    delete empty.detail!.petCapture;
    expect(petInventory(empty).captureComplete).toBe(false);
    expect(
      (
        await searchPetPricing(empty, new AbortController().signal, {
          findCandidates: search,
          readSource: read,
        })
      ).total,
    ).toBeNull();
    const partial = recordWithPets();
    partial.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!.petCount = 2;
    expect(petInventory(partial).issues.join(" ")).toContain("数量");
    expect(
      (
        await searchPetPricing(partial, new AbortController().signal, {
          findCandidates: search,
          readSource: read,
        })
      ).total,
    ).toBeNull();
  });

  it("缺资质或内丹层数只标未采齐，不编金额；昵称、气血和寿命不用于匹配", async () => {
    const pet = makePet();
    pet.fields = pet.fields.filter((field) => field.name !== "法力资质");
    pet.innerSkills[0].level = undefined;
    const record = recordWithPets([pet]);
    expect(petInventory(record).items[0]).toMatchObject({
      status: "incomplete",
      referencePrice: null,
    });
    const { snapshot, search } = await pricing(record);
    expect(snapshot.total).toBeNull();
    expect(search).not.toHaveBeenCalled();
    const item = petInventory(recordWithPets()).items[0];
    expect(item.name).toBe("画魂");
    expect(item.description).not.toContain("主人自定义昵称");
    expect(item.description).not.toContain("气血");
    expect(item.description).not.toContain("寿命");
    expect(verifyPetCandidate(item, candidate(), sourcePage(), "now").verified).toBe(true);
  });

  it("明确base+bonus资质保留原值，不擅自合计；模糊表达仍为不完整", async () => {
    const pet = makePet();
    pet.fields.find((field) => field.name === "攻击资质")!.value = "1550 +22";
    const record = recordWithPets([pet]);
    expect(petInventory(record).items[0].status).toBe("no_match");
    const result = await pricing(
      record,
      [candidate()],
      new Map([[candidate().url, sourcePage(1000, pet)]]),
    );
    expect(result.snapshot.total).toBe(1000);
    expect(result.snapshot.items[0].fields).toContainEqual({ name: "攻击资质", value: "1550 +22" });
    expect(
      verifyPetCandidate(
        petInventory(record).items[0],
        candidate(),
        sourcePage(1000, pet).replace("1550 +22", "1572"),
        "now",
      ).verified,
    ).toBe(false);
    pet.fields.find((field) => field.name === "攻击资质")!.value = "1550 未知加成";
    expect(petInventory(recordWithPets([pet])).items[0].status).toBe("incomplete");
  });

  it("不支持的官方类型即使未发起查询也保留具体拒绝理由", async () => {
    const result = {
      queries: [],
      items: [{ key: "召唤兽/孩子:1", candidates: [], note: "官网召唤兽类型目录未识别，不查询" }],
    };
    const read = vi.fn();
    const snapshot = await searchPetPricing(recordWithPets(), new AbortController().signal, {
      findCandidates: vi.fn().mockResolvedValue(result),
      readSource: read,
    });
    expect(snapshot.total).toBeNull();
    expect(snapshot.items[0].issues.join("；")).toContain("类型目录未识别");
    expect(read).not.toHaveBeenCalled();
  });

  it("实际搜索记录、原始回复、请求和网页hash均保存；全服匹配不限定区服", async () => {
    const { snapshot, search, read } = await pricing();
    expect(snapshot).toMatchObject({
      total: 1000,
      knownTotal: 1000,
      model: "browser",
      provider: "browser",
    });
    expect(snapshot.queries).toHaveLength(1);
    expect(snapshot.searchItems).toHaveLength(1);
    expect(snapshot.requestHash).toHaveLength(64);
    expect(snapshot.items[0].candidates[0].sourceHash).toHaveLength(64);
    expect(snapshot.rawResponse).toContain("sample-a");
    expect(snapshot.items[0].issues).toContain("仅1条挂牌样本，参考范围有限");
    expect(search).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
  });
  it.each(["旧全服范围", "旧神兽星级守护", "旧星级和特性查询", "旧无中位数策略"])(
    "%s的完成报价不复用，当前核验策略报价可复用",
    async (version) => {
      const record = recordWithPets();
      const { snapshot } = await pricing(record);
      const inventory = petInventory(record);
      // Reconstruct real older hashes, before global scope or the star-sensitive comparison guard.
      const legacyInputHash = createHash("sha256")
        .update(
          JSON.stringify({
            ...(version !== "旧全服范围"
              ? { marketScope: GLOBAL_MARKET_SCOPE_VERSION, searchUI: MARKET_SEARCH_UI_VERSION }
              : {}),
            ...(version === "旧星级和特性查询"
              ? { comparisonPolicy: "pet-sensitive-star-v1" }
              : {}),
            ...(version === "旧无中位数策略"
              ? {
                  comparisonPolicy: "pet-sensitive-star-label-v2",
                  queryPolicy: "pet-observed-star-trait-v1",
                }
              : {}),
            collectedAt: record.detail!.petCapture!.collectedAt,
            captureComplete: inventory.captureComplete,
            issues: inventory.issues,
            items: inventory.items.map(
              ({ key, name, fields, skills, skillObservations, innerSkills, equipment }) => ({
                key,
                name,
                fields,
                skills,
                ...(skillObservations ? { skillObservations } : {}),
                innerSkills,
                equipment,
              }),
            ),
          }),
        )
        .digest("hex");
      expect(inventory.inputHash).not.toBe(legacyInputHash);
      const search = vi.fn().mockResolvedValue(response([candidate(1800)]));
      const read = vi.fn().mockResolvedValue(sourcePage(1800));
      const source = { findCandidates: search, readSource: read };
      const reused = await searchPetPricing(record, new AbortController().signal, source, snapshot);
      expect(reused.total).toBe(1000);
      expect(search).not.toHaveBeenCalled();
      const legacy = { ...snapshot, inputHash: legacyInputHash };
      expect(combinePetPricing(upstream(), record, legacy).pet_value).toBeNull();
      const refreshed = await searchPetPricing(
        record,
        new AbortController().signal,
        source,
        legacy,
      );
      expect(search).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(refreshed.total).toBe(1800);
      expect(refreshed.inputHash).toBe(inventory.inputHash);
    },
  );
  it("技能状态和官方ID进入库存哈希与报价身份，不能复用另一技能状态的快照", async () => {
    const record = recordWithPets();
    const pet = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets![0];
    pet.skills[0].skillObservation = {
      rawName: pet.skills[0].name,
      id: "1",
      type: "cifu",
      section: "技能",
      state: "current",
    };
    const { snapshot } = await pricing(record);
    const before = petInventory(record).inputHash;
    expect(snapshot.items[0].skillObservations).toEqual([pet.skills[0].skillObservation]);
    pet.skills[0].skillObservation.state = "future";
    expect(petInventory(record).inputHash).not.toBe(before);
    expect(combinePetPricing(upstream(), record, snapshot).pet_value).toBeNull();
  });

  it("没有实际查询、结果格式错误或网页读取失败都不产出宝宝价格", async () => {
    const record = recordWithPets();
    for (const result of [
      response([candidate()], []),
      { ...response(), items: null },
      { ...response(), items: 42 },
      { ...response(), items: {} },
    ]) {
      const read = vi.fn();
      const snapshot = await searchPetPricing(record, new AbortController().signal, {
        findCandidates: vi.fn().mockResolvedValue(result),
        readSource: read,
      });
      expect(snapshot.total).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(snapshot.rawResponse).toBe(JSON.stringify(result));
    }
    const snapshot = await searchPetPricing(record, new AbortController().signal, {
      findCandidates: vi.fn().mockResolvedValue(response()),
      readSource: vi.fn().mockRejectedValue(new Error("网页需登录")),
    });
    expect(snapshot.total).toBeNull();
    expect(snapshot.items[0].candidates[0].reason).toContain("登录");
  });

  it("技能数相同但特殊技能、等级、成长、资质或成品状态不同均拒绝", () => {
    const item = petInventory(recordWithPets()).items[0];
    const variants = [
      sourcePage().replace("须弥真言", "净台妙谛"),
      sourcePage().replace("等级：119", "等级：129"),
      sourcePage().replace("成长：1.28", "成长：1.281"),
      sourcePage().replace("法力资质：2800", "法力资质：28000"),
      sourcePage().replace("成品状态：成品", "成品状态：胚子"),
      sourcePage().replace("催心浪(5层)", "催心浪(1层)"),
      sourcePage().replace("高级法术波动", "高级法术波动、高级神佑复生"),
      sourcePage().replace("灵性：110", "灵性：100"),
    ];
    for (const page of variants)
      expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(false);
  });

  it("完整技能和内丹可从商品原始图标属性核对，而不只相信AI的列表", () => {
    const item = petInventory(recordWithPets()).items[0];
    expect(
      verifyPetCandidate(item, candidate(), sourcePage(1000, makePet(), true), "now").verified,
    ).toBe(true);
    const page = sourcePage(1000, makePet(), true).replace(
      "data_equip_level='5'",
      "data_equip_level='1'",
    );
    expect(verifyPetCandidate(item, candidate(), page, "now").reason).toContain("内丹");
  });

  it("完整新采集可确认空技能，但网页必须明确显示无技能和无内丹", async () => {
    const pet = makePet();
    pet.skills = [];
    pet.innerSkills = [];
    const record = recordWithPets([pet]),
      item = petInventory(record).items[0];
    expect(item.status).toBe("no_match");
    expect(verifyPetCandidate(item, candidate(), sourcePage(1000, pet), "now").verified).toBe(true);
    expect(
      verifyPetCandidate(
        item,
        candidate(),
        sourcePage(1000, pet).replace("<p>技能：无</p>", ""),
        "now",
      ).verified,
    ).toBe(false);
    delete record.detail!.petCapture;
    expect(
      (
        await searchPetPricing(record, new AbortController().signal, {
          findCandidates: vi.fn(),
          readSource: vi.fn(),
        })
      ).total,
    ).toBeNull();
  });

  it("读取img父a/td的三层属性；不执行script内伪造图标", () => {
    const pet = makePet(),
      item = petInventory(recordWithPets()).items[0];
    let page = sourcePage(1000, pet, true);
    for (const skill of pet.skills) {
      page = page.replace(
        image({ data_equip_name: skill.name, data_skill_type: "cifu" }),
        "<td data_equip_name='" +
          skill.name +
          "' data_skill_type='cifu'><a><span><img src='/images/skills/a.gif'></span></a></td>",
      );
    }
    page = page.replace(
      image({ data_equip_name: "催心浪", data_skill_type: "neidan", data_equip_level: "5" }),
      "<a data_equip_name='催心浪' data_skill_type='neidan' data_equip_level='5'><img src='/images/neidan/a.gif'></a>",
    );
    page = page.replace(
      "</main>",
      "<script>var example=\"<img data_skill_type='cifu'>\";</script></main>",
    );
    expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(true);
  });

  it("额外无法命名或分类的技能/内丹/装备图标不会被忽略", () => {
    const item = petInventory(recordWithPets()).items[0];
    for (const extra of [
      "<img data_skill_type='cifu'>",
      "<img data_skill_type=cifu>",
      "<img data_skill_type='neidan' data_equip_level='5'>",
      "<img data_equip_name='额外强力' data_skill_type='unknown-premium'>",
      "<img src='/images/skills/unknown.gif'>",
      "<img data_equip_desc='等级：85#r速度：30'>",
    ]) {
      const page = sourcePage(1000, makePet(), true).replace("</main>", extra + "</main>");
      expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(false);
    }
  });

  it("完整等级字段不能误匹配携带等级；重复冲突成长不能挑匹配的一条", () => {
    const target = makePet();
    target.fields.find((field) => field.name === "携带等级")!.value = "119";
    const item = petInventory(recordWithPets([target])).items[0];
    const source = structuredClone(target);
    source.fields.find((field) => field.name === "等级")!.value = "120";
    expect(verifyPetCandidate(item, candidate(), sourcePage(1000, source), "now").verified).toBe(
      false,
    );
    const conflicting = sourcePage(1000, target).replace("</pre>", "\n成长：1.3</pre>");
    expect(verifyPetCandidate(item, candidate(), conflicting, "now").verified).toBe(false);
  });

  it("表格属性可核对，同时表格中多出的特殊属性不能漏掉", () => {
    const pet = makePet(),
      item = petInventory(recordWithPets()).items[0];
    const table =
      "<table>" +
      pet.fields
        .filter((field) => !["气血", "寿命", "名称"].includes(field.name))
        .map((field) => "<tr><td>" + field.name + "</td><td>" + field.value + "</td></tr>")
        .join("") +
      "</table>";
    const page = sourcePage().replace("<pre>" + fieldText(pet) + "</pre>", table);
    expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(true);
    const extra = page.replace("</table>", "<tr><td>特性类型</td><td>顺势</td></tr></table>");
    expect(verifyPetCandidate(item, candidate(), extra, "now").verified).toBe(false);
  });

  it.each(["exact", "similar"] as const)(
    "%s不会把未知神兽星级当初始，候选新增0星或3星均拒绝",
    (mode) => {
      const target = setField(makePet(), "类型", "超级神羊");
      const item = petInventory(recordWithPets([target])).items[0];
      for (const value of ["0", "3"]) {
        const sample = structuredClone(target);
        sample.fields.push({ name: "神兽星级", value });
        expect(
          verifyPetCandidate(item, candidate(), sourcePage(1000, sample), "now", mode).verified,
          value,
        ).toBe(false);
      }
    },
  );
  it.each(["exact", "similar"] as const)(
    "%s必须核对已捕获神兽星级，缺失或不同拒绝，相同可采用",
    (mode) => {
      const target = setField(makePet(), "类型", "超级神羊");
      target.fields.push({ name: "神兽星级", value: "0" });
      const item = petInventory(recordWithPets([target])).items[0];
      const changed = structuredClone(target);
      setField(changed, "神兽星级", "3");
      const missing = structuredClone(target);
      missing.fields = missing.fields.filter((field) => field.name !== "神兽星级");
      for (const sample of [changed, missing])
        expect(
          verifyPetCandidate(item, candidate(), sourcePage(1000, sample), "now", mode).verified,
        ).toBe(false);
      expect(
        verifyPetCandidate(item, candidate(), sourcePage(1000, target), "now", mode).verified,
      ).toBe(true);
    },
  );

  it.each([
    ["初始", "0"],
    ["一星", "1"],
    ["二星", "2"],
    ["三星", "3"],
  ])("官方星级标签%s与编号%s在两种匹配模式保持一致，原采集不改写", (label, number) => {
    for (const mode of ["exact", "similar"] as const)
      for (const [targetStar, sourceStar] of [
        [label, number],
        [number, label],
      ]) {
        const target = setField(makePet(), "类型", "超级神羊");
        target.fields.push({ name: "神兽星级", value: targetStar });
        const item = petInventory(recordWithPets([target])).items[0];
        const source = structuredClone(target);
        setField(source, "神兽星级", sourceStar);
        expect(
          verifyPetCandidate(item, candidate(), sourcePage(1000, source), "now", mode).verified,
        ).toBe(true);
        expect(target.fields.find((field) => field.name === "神兽星级")!.value).toBe(targetStar);
      }
  });

  it("未知额外进阶/认证属性、变异身份、装备未说明均拒绝套价", () => {
    const item = petInventory(recordWithPets()).items[0];
    for (const page of [
      sourcePage().replace("</pre>", "\n认证技能：泰山压顶</pre>"),
      sourcePage().replace("召唤兽</h1>", "变异召唤兽</h1>"),
      sourcePage().replace("<p>宝宝装备：无</p>", ""),
    ])
      expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(false);
  });

  it("整号、过期状态、报价与主商品价不符、不能逐字核对的引用不采纳", () => {
    const item = petInventory(recordWithPets()).items[0];
    const pages = [
      sourcePage().replace("召唤兽</h1>", "角色编号</h1>"),
      sourcePage().replace("在售", "商品已售出"),
      sourcePage(2000),
    ];
    for (const page of pages)
      expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(false);
    expect(
      verifyPetCandidate(item, { ...candidate(), quote: "卖家实际承诺1000" }, sourcePage(), "now")
        .verified,
    ).toBe(false);
    const page = sourcePage().replace("</main>", "<p>推荐其他宝宝价格：¥500</p></main>");
    expect(verifyPetCandidate(item, candidate(), page, "now").verified).toBe(false);
    expect(
      verifyPetCandidate(
        item,
        candidate(),
        "<aside>挂牌价：¥1000</aside>" + sourcePage(2000),
        "now",
      ).verified,
    ).toBe(false);
  });

  it("同商品别名链接只算一条，独立当前报价取平均值", async () => {
    const candidates = [
      candidate(900),
      { ...candidate(900), url: "https://xyq-m.cbg.163.com/equip?s=367&eid=sample-a" },
      candidate(1100, "sample-b"),
      candidate(3000, "sample-c"),
    ];
    const { snapshot, read } = await pricing(recordWithPets(), candidates);
    expect(snapshot.items[0].candidates).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(snapshot.total).toBe(1666.67);
  });

  it("两条独立宝宝报价相差一分，半分进位后可通过完整性校验并合入总价", async () => {
    const record = recordWithPets();
    const { snapshot } = await pricing(record, [
      candidate(1050.01, "cent-a"),
      candidate(1050.02, "cent-b"),
    ]);
    expect(snapshot.items[0].referencePrice).toBe(1050.02);
    expect(snapshot).toMatchObject({ knownTotal: 1050.02, total: 1050.02 });
    expect(combinePetPricing(upstream(), record, snapshot)).toMatchObject({
      pet_value: 1050.02,
      model_value: 3050.02,
    });
  });

  it("宝宝包含同装备才使用包价，随身装备不再次计价；装备不同则不采纳", async () => {
    const pet = makePet();
    pet.equipment = [
      {
        name: "宝宝项圈",
        index: 0,
        kind: "equipment",
        description: "等级：85\n速度：30\n灵力：10",
      },
    ];
    const record = recordWithPets([pet]);
    const page = sourcePage(1000, pet);
    const { snapshot } = await pricing(record, [candidate()], new Map([[candidate().url, page]]));
    expect(snapshot.total).toBe(1000);
    const result = combinePetPricing(upstream(), record, snapshot);
    expect(result.model_value).toBe(3000);
    expect(result.pet_value).toBe(1000);
    expect(result.equipment_value).toBe(300);
    expect(result.bare_role_value).toBe(1700);
    expect(result.total_cost).toBeNull();
    expect(result.max_listing_price).toBeNull();
    const changed = page.replace("速度：30", "速度：31");
    expect(
      verifyPetCandidate(petInventory(record).items[0], candidate(), changed, "now").verified,
    ).toBe(false);
  });
  it("饰品保留明确槽位与可见描述并核对同配置，不能当作战斗装备或丢弃", async () => {
    const pet = makePet();
    pet.equipment = [
      {
        name: "吸血鬼饰品",
        index: 0,
        kind: "equipment",
        location: "RolePetShipin",
        description: "修理失败 2次\n外观说明：红色披风",
      },
    ];
    const record = recordWithPets([pet]);
    const target = petInventory(record).items[0];
    expect(target.status).toBe("no_match");
    expect(target.equipment).toEqual([
      {
        name: "吸血鬼饰品",
        description: "修理失败 2次\n外观说明：红色披风",
        accessory: true,
      },
    ]);
    const page = sourcePage(1000, pet);
    const { snapshot } = await pricing(record, [candidate()], new Map([[candidate().url, page]]));
    expect(snapshot.total).toBe(1000);
    expect(verifyPetCandidate(target, candidate(), page, "now").verified).toBe(true);
    for (const changed of [
      page.replace("修理失败 2次", "修理失败 1次"),
      page.replace("红色披风", "蓝色披风"),
      page.replace("data_equip_location='RolePetShipin'", ""),
      page.replace(/<img[^>]+>/, ""),
    ])
      expect(verifyPetCandidate(target, candidate(), changed, "now").verified).toBe(false);
    pet.equipment[0].description = undefined;
    expect(petInventory(record).items[0].status).toBe("incomplete");
  });

  it("部分宝宝价格仍显示已知小计，但完整估值未知；前一步未知也不被宠物报价掩盖", async () => {
    const record = recordWithPets([makePet(), makePet(2)]);
    const { snapshot } = await pricing(record);
    expect(snapshot).toMatchObject({ total: null, knownTotal: 1000 });
    const result = combinePetPricing(upstream(), record, snapshot);
    expect(result).toMatchObject({
      decision: "NEED_INFO",
      pet_value: null,
      model_value: null,
      known_subtotal: 3000,
    });
    const completeRecord = recordWithPets();
    const { snapshot: complete } = await pricing(completeRecord);
    expect(combinePetPricing(upstream(null), completeRecord, complete)).toMatchObject({
      decision: "NEED_INFO",
      model_value: null,
      pet_value: 1000,
      known_subtotal: 3000,
    });
    const out = { ...upstream(), decision: "OUT_OF_SCOPE" as const, reason: "超出原规则" };
    expect(combinePetPricing(out, completeRecord, complete)).toMatchObject({
      decision: "OUT_OF_SCOPE",
      reason: "超出原规则",
    });
  });

  it("资料变更或报价过期不会污染历史快照或算入当前价差", async () => {
    const record = recordWithPets();
    const { snapshot } = await pricing(record);
    const before = JSON.stringify(snapshot);
    const old = {
      ...snapshot,
      searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    expect(combinePetPricing(upstream(), record, old)).toMatchObject({
      pet_value: null,
      known_subtotal: 2000,
      model_value: null,
    });
    record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets![0].skills[0].name =
      "净台妙谛";
    expect(combinePetPricing(upstream(), record, snapshot)).toMatchObject({
      pet_pricing: undefined,
      pet_value: null,
      model_value: null,
    });
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe("真实99级泪妖的相近匹配回归（只使用已保存配置，不联网）", () => {
  const savedSkills = [
    "地狱烈火",
    "慧根",
    "法术暴击",
    "超级地狱烈火（进化后获得）",
    "超级招架（进化后获得）",
    "超级法术连击（进化后获得）",
    "超级进击必杀（进化后获得）",
    "须弥真言",
    "高级法术连击",
    "高级魔之心",
  ];
  const saved = {
    fields: [
      ["类型", "泪妖"],
      ["等级", "99"],
      ["是否宝宝", "是"],
      ["体质", "118"],
      ["攻击资质", "1015"],
      ["魔力", "855"],
      ["防御资质", "1317"],
      ["攻击", "486"],
      ["力量", "109"],
      ["体力资质", "3424"],
      ["防御", "672"],
      ["耐力", "133"],
      ["法力资质", "2047"],
      ["速度", "242"],
      ["敏捷", "123"],
      ["速度资质", "1353"],
      ["法伤", "1226"],
      ["潜能", "0"],
      ["躲闪资质", "1059"],
      ["法防", "850"],
      ["成长", "1.242"],
      ["五行", "金"],
      ["已用元宵", "7"],
      ["已用千金露", "5"],
      ["已用炼兽珍经", "0"],
      ["已使用幻色丹", "是"],
      ["历史灵性值", "96"],
      ["已用清灵仙露", "7"],
    ].map(([name, value]) => ({ name, value })),
    skills: savedSkills,
    skillObservations: savedSkills.map((rawName) => ({
      rawName,
      type: "cifu",
      section: /进化后获得/.test(rawName) ? "赐福技能" : "技能",
      state: /进化后获得/.test(rawName) ? ("future" as const) : ("current" as const),
    })),
    innerSkills: [
      { name: "灵身", level: "5" },
      { name: "双星爆", level: "1" },
      { name: "灵光", level: "5" },
    ],
    equipment: [
      {
        name: "嵌宝金腕",
        description:
          "等级 95\n命中率 +13%\n耐久度 113\n耐力 +14 魔力 +13\n套装效果：附加状态高级神佑复生\n镶嵌效果\n+28灵力 镶嵌等级：7",
      },
      {
        name: "嵌宝金环",
        description:
          "等级 95\n速度 +34\n耐久度 34\n灵力 +10 耐力 +10\n套装效果：附加状态高级神佑复生\n镶嵌效果\n+42速度 镶嵌等级：7",
      },
      {
        name: "嵌宝金甲",
        description:
          "等级 95\n气血 +77 防御 +88\n耐久度 163\n魔力 +14\n套装效果：附加状态高级神佑复生\n镶嵌效果\n+64防御 镶嵌等级：8",
      },
    ],
  };
  const targetPet = (): PetSnapshot => ({
    index: 1,
    name: "泪妖",
    fields: structuredClone(saved.fields),
    skills: saved.skills.map((name, index) => ({
      name,
      index,
      kind: "skill",
      skillObservation: saved.skillObservations.find(
        (skill) => skill.rawName === name,
      ) as NonNullable<PetSnapshot["skills"][number]["skillObservation"]>,
    })),
    innerSkills: saved.innerSkills.map((skill, index) => ({ ...skill, index, kind: "innerSkill" })),
    equipment: saved.equipment.map((gear, index) => ({ ...gear, index, kind: "equipment" })),
  });
  const comparable = () => {
    const pet = targetPet();
    pet.skills = pet.skills.filter((skill) => !/进化后获得/.test(skill.name));
    pet.skills.find((skill) => skill.name === "法术暴击")!.name = "高级法术暴击";
    setField(pet, "成长", "1.250");
    setField(pet, "已用元宵", "2");
    setField(pet, "历史灵性值", "100");
    const dye = pet.fields.find((field) => field.name === "已使用幻色丹")!;
    dye.name = "已用幻色丹";
    dye.value = "否";
    pet.innerSkills[1].level = "5";
    pet.equipment[0].description = pet.equipment[0].description!.replace(
      "镶嵌等级：7",
      "镶嵌等级：6",
    );
    return pet;
  };
  it("六个当前技能和四个未来预览分开，普通技能/内丹/装备差异进入正式相近样本", () => {
    const target = petInventory(recordWithPets([targetPet()])).items[0];
    const sample = comparable();
    expect(
      verifyPetCandidate(target, candidate(), sourcePage(1000, sample), new Date().toISOString())
        .verified,
    ).toBe(false);
    const verified = verifyPetCandidate(
      target,
      candidate(),
      sourcePage(1000, sample),
      new Date().toISOString(),
      "similar",
    );
    expect(verified).toMatchObject({ verified: true, matchType: "similar" });
    expect(verified.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining("共有5项"),
        expect.stringContaining("历史灵性值：目标 96，样本 100"),
        expect.stringContaining("已使用幻色丹：目标 是，样本 否"),
        expect.stringContaining("未来进化技能预览"),
        expect.stringContaining("内丹：目标"),
        expect.stringContaining("随身装备包价差异"),
      ]),
    );
  });
  it("须弥缺失、普通共有技能不足、不同变异/认证和越界成长仍拒绝", () => {
    const target = petInventory(recordWithPets([targetPet()])).items[0];
    const missingCore = comparable();
    missingCore.skills = missingCore.skills.filter((skill) => skill.name !== "须弥真言");
    const weak = comparable();
    weak.skills = weak.skills.filter((skill) => ["须弥真言", "高级魔之心"].includes(skill.name));
    const mutation = comparable();
    mutation.fields.push({ name: "变异", value: "是" });
    const certified = comparable();
    certified.fields.push({ name: "认证技能", value: "泰山压顶" });
    const farGrowth = setField(comparable(), "成长", "1.273");
    for (const sample of [missingCore, weak, mutation, certified, farGrowth])
      expect(
        verifyPetCandidate(
          target,
          candidate(),
          sourcePage(1000, sample),
          new Date().toISOString(),
          "similar",
        ).verified,
      ).toBe(false);
  });
  it.each(["missing", "extra", "model", "level", "stats", "suit", "stone"])(
    "相近宝宝包价不能采用不兼容随身装备：%s",
    (kind) => {
      const target = petInventory(recordWithPets([targetPet()])).items[0];
      const sample = comparable();
      if (kind === "missing") sample.equipment = [];
      if (kind === "extra") sample.equipment.push({ ...sample.equipment[0], index: 3 });
      if (kind === "model") sample.equipment[0].name = "其他护腕";
      if (kind === "level")
        sample.equipment[0].description = sample.equipment[0].description!.replace(
          "等级 95",
          "等级 115",
        );
      if (kind === "stats")
        sample.equipment[0].description = sample.equipment[0].description!.replace(
          "命中率 +13%",
          "命中率 +30%",
        );
      if (kind === "suit")
        sample.equipment[0].description = sample.equipment[0].description!.replace(
          "高级神佑复生",
          "高级反震",
        );
      if (kind === "stone")
        sample.equipment[0].description = sample.equipment[0].description!.replace(
          "镶嵌等级：6",
          "镶嵌等级：3",
        );
      const result = verifyPetCandidate(
        target,
        candidate(),
        sourcePage(1000, sample),
        new Date().toISOString(),
        "similar",
      );
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("随身宝宝装备");
    },
  );
  it("目标普通技能包含地狱烈火时，样本认证地狱烈火在相似模式下作为有效样本并记录差异", () => {
    const target = petInventory(recordWithPets([targetPet()])).items[0];
    const sameCert = comparable();
    sameCert.fields.push({ name: "认证技能", value: "地狱烈火" });
    const verified = verifyPetCandidate(
      target,
      candidate(),
      sourcePage(1000, sameCert),
      new Date().toISOString(),
      "similar",
    );
    expect(verified.verified).toBe(true);
    expect(verified.differences).toContainEqual(
      expect.stringContaining("认证技能：目标普通技能包含地狱烈火，样本认证地狱烈火"),
    );
  });
  it("三个不同独立挂牌产生正式相近区间，宝宝包价不重复加随身装备", async () => {
    const record = recordWithPets([targetPet()]);
    const candidates = [1200, 1300, 1400].map((price, index) => ({
      ...candidate(price, "tear-" + index),
      matchType: "similar" as const,
    }));
    const pages = new Map(
      candidates.map((entry) => [entry.url, sourcePage(entry.price!, comparable())]),
    );
    const result = await pricing(record, candidates, pages);
    expect(result.snapshot.items[0]).toMatchObject({
      status: "no_match",
      referencePrice: null,
      similarEstimate: { status: "range", sampleCount: 3, range: { min: 1200, max: 1400 } },
    });
    expect(
      result.snapshot.items[0].candidates.every(
        (entry) => entry.verified && entry.matchType === "similar",
      ),
    ).toBe(true);
    expect(result.snapshot.knownTotal).toBe(0);
    expect(result.snapshot.total).toBeNull();
  });
});

it("仅另一只明确缺字段时，已完整宝宝仍查价并保留部分小计，完整总价未知", async () => {
  const incomplete = makePet(2);
  incomplete.fields = incomplete.fields.filter((field) => field.name !== "成长");
  const record = recordWithPets([makePet(1), incomplete]);
  record.detail!.petCapture!.complete = false;
  record.detail!.petCapture!.issues = ["第 2 只召唤兽成长未完整读取"];
  const { snapshot, search } = await pricing(record);
  expect(search).toHaveBeenCalledOnce();
  expect(search.mock.calls[0][0]).toHaveLength(1);
  expect(snapshot.items[0].status).toBe("priced");
  expect(snapshot.items[1].status).toBe("incomplete");
  expect(snapshot).toMatchObject({ captureComplete: false, knownTotal: 1000, total: null });
  expect(combinePetPricing(upstream(), record, snapshot)).toMatchObject({
    pet_value: null,
    model_value: null,
    decision: "NEED_INFO",
  });
});

it("宝宝总数未知、不一致、重复序号或未识别的捕获问题仍不能绕过总清单守护", async () => {
  const incomplete = makePet(2);
  incomplete.fields = incomplete.fields.filter((field) => field.name !== "成长");
  for (const kind of [
    "unknown-count",
    "different-count",
    "duplicate-key",
    "unknown-issue",
    "old-capture",
  ]) {
    const record = recordWithPets([makePet(1), structuredClone(incomplete)]);
    record.detail!.petCapture!.complete = false;
    const tab = record.detail!.tabs.find((value) => value.name === "召唤兽/孩子")!;
    if (kind === "unknown-count") delete tab.petCount;
    if (kind === "different-count") tab.petCount = 3;
    if (kind === "duplicate-key") tab.pets![1].index = 1;
    if (kind === "unknown-issue") record.detail!.petCapture!.issues = ["详细信息区域未确认"];
    if (kind === "old-capture") delete record.detail!.petCapture;
    const { snapshot, search } = await pricing(record);
    expect(search).not.toHaveBeenCalled();
    expect(snapshot.total).toBeNull();
    expect(snapshot.knownTotal).toBe(0);
    expect(snapshot.searchComplete).toBe(true);
    expect(snapshot.items.some((item) => item.searchState === "pending")).toBe(false);
    expect(combinePetPricing(upstream(), record, snapshot).model_value).toBeNull();
  }
});
