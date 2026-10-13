import { describe, expect, it } from "vite-plus/test";
import type { SavedRoleRecord, TabSnapshot } from "../crawler/types";
import {
  buildRoleMarketReference,
  compareRoleConfiguration,
  roleCore,
  roleSourceHash,
  type RoleMarketCandidate,
} from "./role-market";
const now = Date.now();
const tab = (name: string): TabSnapshot => ({
  name,
  text: "",
  fields: [],
  tables: [],
  elements: [],
  tooltips: [],
  items: [],
});
function record(id = "target", price = 5000): SavedRoleRecord {
  const identity = "33:" + id,
    url = "https://xyq.cbg.163.com/equip?s=33&eid=" + id,
    collectedAt = new Date(now).toISOString();
  const person = tab("人物/修炼");
  person.fields = [
    { name: "级别", value: "89" },
    { name: "门派", value: "神木林" },
    { name: "飞升/渡劫/化圣", value: "未飞升" },
  ];
  person.tables = [
    [
      "攻击修炼",
      "法术修炼",
      "防御修炼",
      "抗法修炼",
      "攻击控制力",
      "防御控制力",
      "法术控制力",
      "抗法控制力",
    ].map((name) => [name + "：", "13/20"]),
  ];
  const skills = tab("技能");
  skills.items = ["强壮", "神速", "强身术"].map((name, index) => ({
    index,
    name,
    kind: "skill",
    level: name === "强身术" ? "120" : "26",
  }));
  const equipment = tab("道具/法宝");
  equipment.equipmentEmptyProof = "official-containers";
  const pets = tab("召唤兽/孩子");
  pets.pets = [];
  pets.petCount = 0;
  return {
    status: "complete",
    error: null,
    listing: {
      key: identity,
      serverId: "33",
      serverAge: "older",
      eid: id,
      ordersn: id,
      url,
      name: "模拟角色",
      price: String(price),
      attrs: {},
      summary: {},
      sellingTime: null,
      createdTime: null,
      orderTime: null,
    },
    detail: {
      url,
      collectedAt,
      raw: {},
      tabs: [person, skills, equipment, pets, tab("坐骑"), tab("锦衣/外观"), tab("玩家之家")],
      equipmentCapture: {
        version: 1,
        complete: true,
        collectedAt,
        issues: [],
        emptyProof: "official-containers",
      },
      petCapture: { version: 1, complete: true, collectedAt, issues: [] },
    },
  };
}
function candidate(
  id: string,
  price: number,
  overrides: Partial<RoleMarketCandidate> = {},
): RoleMarketCandidate {
  const item = record(id, price);
  return {
    key: item.listing.key,
    url: item.listing.url,
    title: item.listing.name,
    price,
    active: true,
    serverAge: "older",
    fetchedAt: new Date(now).toISOString(),
    sourceHash: roleSourceHash(item),
    verified: true,
    reasons: [],
    differences: [],
    record: item,
    ...overrides,
  };
}
function withPet(id = "target") {
  const value = record(id);
  const snapshot = value.detail!.tabs[3];
  snapshot.petCount = 1;
  snapshot.pets = [
    {
      index: 1,
      name: "泪妖",
      fields: [
        { name: "类型", value: "泪妖" },
        { name: "等级", value: "99" },
        { name: "成长", value: "1.242" },
        { name: "是否宝宝", value: "是" },
        ...["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((name) => ({
          name,
          value: "1500",
        })),
      ],
      skills: [
        { index: 0, name: "须弥真言", kind: "skill" },
        { index: 1, name: "高级魔之心", kind: "skill" },
        { index: 2, name: "高级法术连击", kind: "skill" },
      ],
      innerSkills: [{ index: 0, name: "灵光", kind: "innerSkill", level: "5" }],
      equipment: [
        {
          index: 0,
          name: "测试宝宝装备",
          kind: "equipment",
          description: "等级95\n速度34\n耐久度100",
        },
      ],
    },
  ];
  return value;
}
describe("整号挂牌比较", () => {
  it("绑定宝宝不能由可交易宝宝配置覆盖整体价格", () => {
    const target = withPet(),
      source = withPet("source");
    target.detail!.tabs[3].pets![0].fields.push({ name: "交易限制", value: "绑定不可交易" });
    expect(compareRoleConfiguration(target, source).verified).toBe(false);
    expect(compareRoleConfiguration(target, source).reasons.join("；")).toContain(
      "绑定或交易限制不同",
    );
    source.detail!.tabs[3].pets![0].fields.push({ name: "交易限制", value: "绑定不可交易" });
    expect(compareRoleConfiguration(target, source).verified).toBe(true);
  });
  it("从真实角色字段和修炼表格读取完整核心证据", () => {
    expect(roleCore(record())).toMatchObject({
      level: 89,
      school: "神木林",
      training: { 法术修炼: 13, 抗法控制力: 13 },
      skills: { 强壮: 26, 强身术: 120 },
    });
    expect(compareRoleConfiguration(record(), record("source")).verified).toBe(true);
  });
  it("缺少修炼不转换为0", () => {
    const source = record("source");
    source.detail!.tabs[0].tables = [];
    expect(compareRoleConfiguration(record(), source)).toMatchObject({ verified: false });
    expect(compareRoleConfiguration(record(), source).reasons.join("；")).toContain("缺少完整数值");
  });
  it("攻击修炼差异完整记录，超过3不能遗漏", () => {
    const target = record(),
      source = record("source");
    source.detail!.tabs[0].tables[0][0][1] = "10/20";
    expect(compareRoleConfiguration(target, source)).toMatchObject({
      verified: true,
      differences: expect.arrayContaining(["攻击修炼：13 → 10"]),
    });
    source.detail!.tabs[0].tables[0][0][1] = "20/20";
    expect(compareRoleConfiguration(target, source).verified).toBe(false);
  });
  it("未证明为空的装备库存不能作为空角色采纳", () => {
    const source = record("source");
    delete source.detail!.equipmentCapture!.emptyProof;
    delete source.detail!.tabs[2].equipmentEmptyProof;
    expect(compareRoleConfiguration(record(), source).verified).toBe(false);
  });
  it("法修差3可比较并披露，差4拒绝", () => {
    const source = record("source");
    source.detail!.tabs[0].tables[0][1][1] = "10/20";
    expect(compareRoleConfiguration(record(), source)).toMatchObject({
      verified: true,
      differences: expect.arrayContaining(["法术修炼：13 → 10"]),
    });
    source.detail!.tabs[0].tables[0][1][1] = "9/20";
    expect(compareRoleConfiguration(record(), source).verified).toBe(false);
  });
  it("专用与可交易剑不能混用整号报价，只接受同专用状态", () => {
    const target = record(),
      source = record("source");
    for (const item of [target, source])
      item.detail!.tabs[2].items = [
        {
          index: 0,
          name: "碧玉剑",
          category: "人物装备 · 武器",
          kind: "equipment",
          description:
            "等级80\n伤害381\n命中346\n锻炼等级8\n宝石太阳石" +
            (item === target ? "\n玩家46377146专用\n神木林专用" : ""),
        },
      ];
    const match = compareRoleConfiguration(target, source);
    expect(match.verified).toBe(false);
    expect(match.reasons.join("；")).toContain("专用");
    source.detail!.tabs[2].items![0].description =
      "等级80\n伤害200\n命中346\n锻炼等级8\n宝石太阳石";
    expect(compareRoleConfiguration(target, source).verified).toBe(false);
  });
  it.each(["认证", "变异", "进阶灵性", "赐福", "转生次数"])(
    "宝宝敏感状态%s缺失或不同不能验证",
    (name) => {
      const target = withPet(),
        source = withPet("source");
      expect(compareRoleConfiguration(target, source).verified).toBe(true);
      source.detail!.tabs[3].pets![0].fields.push({ name, value: "1" });
      expect(compareRoleConfiguration(target, source).verified).toBe(false);
    },
  );
  it.each([
    [undefined, "0", false],
    ["0", undefined, false],
    ["0", "3", false],
    ["3", "0", false],
    ["0", "0", true],
    ["3", "3", true],
    ["初始", "0", true],
    ["一星", "1", true],
    ["2", "二星", true],
    ["三星", "3星", true],
    ["四星", "四星", false],
  ] as const)(
    "神兽星级目标%s、来源%s必须有同值证据，未知不等于0星",
    (targetStar, sourceStar, verified) => {
      const target = withPet(),
        source = withPet("source");
      for (const [value, star] of [
        [target, targetStar],
        [source, sourceStar],
      ] as const) {
        const pet = value.detail!.tabs[3].pets![0];
        pet.name = "超级神羊";
        pet.fields.find((field) => field.name === "类型")!.value = "超级神羊";
        if (star !== undefined) pet.fields.push({ name: "神兽星级", value: star });
      }
      const match = compareRoleConfiguration(target, source);
      expect(match.verified).toBe(verified);
      if (!verified) expect(match.reasons.join("；")).toContain("神兽星级缺失或不同");
    },
  );
  it("宝宝内丹层数、随身装备属性、未来技能与未知当前状态均需核验", () => {
    const target = withPet();
    const lowNeidan = withPet("source");
    lowNeidan.detail!.tabs[3].pets![0].innerSkills[0].level = "1";
    expect(compareRoleConfiguration(target, lowNeidan).reasons.join("；")).toContain(
      "内丹名称或层数",
    );
    const weakGear = withPet("source");
    weakGear.detail!.tabs[3].pets![0].equipment[0].description = "等级30\n速度10\n耐久度100";
    expect(compareRoleConfiguration(target, weakGear).verified).toBe(false);
    const future = withPet("source");
    future.detail!.tabs[3].pets![0].skills.push({
      index: 3,
      name: "超级魔之心（进化后获得）",
      kind: "skill",
    });
    expect(compareRoleConfiguration(target, future).reasons.join("；")).toContain("未来赐福技能");
    const unknown = withPet("source");
    unknown.detail!.tabs[3].pets![0].skills[0].skillObservation = {
      rawName: "须弥真言",
      state: "unknown",
      type: "cifu",
    };
    expect(compareRoleConfiguration(target, unknown).reasons.join("；")).toContain("技能当前状态");
  });
  it("同名玉魄属性和到期不同不会仅按件数接受", () => {
    const target = record(),
      source = record("source");
    for (const value of [target, source])
      value.detail!.tabs[2].items = [
        {
          index: 0,
          name: "阳玉魄",
          kind: "equipment",
          category: "上古玉魄",
          description: "法术伤害结果9\n奇袭法术0.5%\n到期2026-11-01",
        },
      ];
    expect(compareRoleConfiguration(target, source).verified).toBe(true);
    source.detail!.tabs[2].items![0].description = "法术伤害结果9\n奇袭法术0.5%\n到期2026-12-01";
    expect(compareRoleConfiguration(target, source).reasons.join("；")).toContain("奇袭/到期条件");
  });
  it("三个独立鲜活在售整体样本给挂牌范围，不添加资产小计", () => {
    const result = buildRoleMarketReference(
      [candidate("a", 5000), candidate("b", 5200), candidate("c", 5500)],
      "33:target",
      now,
    );
    expect(result).toMatchObject({
      status: "range",
      sampleCount: 3,
      range: { min: 5000, max: 5500 },
      median: 5200,
    });
    expect(result.scope).toContain("不与资产小计相加");
  });
  it.each([
    { active: false },
    { verified: false },
    { fetchedAt: new Date(now - 86_400_000).toISOString() },
    { sourceHash: "forged" },
    { price: 6000 },
    { url: "https://example.org/equip?s=33&eid=c" },
  ])("排除缺失有效证据样本 %j", (overrides) => {
    expect(
      buildRoleMarketReference(
        [candidate("a", 5000), candidate("b", 5200), candidate("c", 5500, overrides)],
        "33:target",
        now,
      ),
    ).toMatchObject({ status: "insufficient", sampleCount: 2, range: null });
  });
  it("目标自身与重复样本不凑3条，分散报价不形成完整参考", () => {
    expect(
      buildRoleMarketReference(
        [
          candidate("target", 5000),
          candidate("a", 5000),
          candidate("a", 5000),
          candidate("b", 5200),
        ],
        "33:target",
        now,
      ),
    ).toMatchObject({ status: "insufficient", sampleCount: 2 });
    expect(
      buildRoleMarketReference(
        [candidate("a", 5000), candidate("b", 5200), candidate("c", 9000)],
        "33:target",
        now,
      ),
    ).toMatchObject({ status: "dispersed", range: null });
  });
});
