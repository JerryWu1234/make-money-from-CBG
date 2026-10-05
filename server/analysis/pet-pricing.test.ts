import { describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import type { PetSnapshot, SavedRoleRecord } from "../crawler/types";
import { compareListingPrice } from "./valuation-calculator";
import type { ValuationResult } from "./valuation-types";
import type { EquipmentCandidate } from "./equipment-pricing";
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

describe("宝宝来源核对与挂牌比价", () => {
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

  it("同商品别名链接只算一条，独立当前报价取中位数", async () => {
    const candidates = [
      candidate(900),
      { ...candidate(900), url: "https://xyq-m.cbg.163.com/equip?s=367&eid=sample-a" },
      candidate(1100, "sample-b"),
      candidate(3000, "sample-c"),
    ];
    const { snapshot, read } = await pricing(recordWithPets(), candidates);
    expect(snapshot.items[0].candidates).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(snapshot.total).toBe(1100);
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
