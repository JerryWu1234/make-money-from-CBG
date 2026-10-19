import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page, Request } from "playwright-core";
import {
  createPetSource,
  assertPetUIArguments,
  PET_SEARCH_URL,
  petObservationSource,
  petPageSource,
  petQuery,
  petQueries,
  petGrowthInput,
  petSourceFromPages,
  petEvolutionPreview,
  type PetSearchConfig,
} from "./browser-pet-source";
import { verifyPetCandidate, searchPetPricing, type PetPricingItem } from "./pet-pricing";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { pageText } from "./equipment-pricing";
import { petBlessingState, similarPetSkills } from "./pet-match";
const runtime = vi.hoisted(() => ({
  createHiddenPage: vi.fn(),
  getBrowser: vi.fn(),
  crawlDatabase: vi.fn(),
}));
vi.mock("../session", () => ({
  createHiddenPage: runtime.createHiddenPage,
  getBrowser: runtime.getBrowser,
}));
vi.mock("../crawler/controller", () => ({ crawlDatabase: runtime.crawlDatabase }));
vi.mock("../crawler/page", () => ({
  assertAvailable: vi.fn(),
  pace: async (signal: AbortSignal) => signal.throwIfAborted(),
}));
const config: PetSearchConfig = {
  names: { 2001: "画魂", 2002: "画魂", 3001: "幽灵" },
  skills: [
    [1, "须弥真言"],
    [2, "高级法术暴击"],
  ],
  highNeidans: [[9, "催心浪"]],
  lowNeidans: [[10, "灵光"]],
};
const fields = [
  ["类型", "画魂"],
  ["等级", "119"],
  ["成长", "1.28"],
  ["攻击资质", "1550 +22"],
  ["防御资质", "1400"],
  ["体力资质", "5000"],
  ["法力资质", "2800"],
  ["速度资质", "1200"],
  ["躲闪资质", "1100"],
].map(([name, value]) => ({ name, value }));
const item = (): PetPricingItem => ({
  key: "召唤兽/孩子:1",
  name: "画魂",
  level: 119,
  category: "召唤兽",
  description: fields.map(({ name, value }) => name + "：" + value).join("\n"),
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  fields,
  skills: ["须弥真言", "高级法术暴击"],
  innerSkills: [{ name: "催心浪", level: "5" }],
  equipment: [],
});
const observation = (): Parameters<typeof petObservationSource>[0] => ({
  productId: "pet-a",
  serverId: 1,
  productName: "自定义昵称",
  visibleName: "自定义昵称",
  storageType: 2,
  petStorageType: 2,
  rawPrice: "368.60",
  prices: ["￥368.60（元）"],
  selling: 1,
  body: "状态：上架中",
  fields: fields.filter((field) => field.name !== "类型"),
  parsedFields: fields,
  skills: item().skills,
  expectedSkills: item().skills,
  innerSkills: item().innerSkills,
  expectedInner: item().innerSkills,
  equipment: [],
  expectedEquipment: [],
});
const url = "https://xyq.cbg.163.com/equip?s=1&eid=pet-a";

describe("明确赐福字段状态", () => {
  it.each([
    ["赐福", "无", "absent"],
    ["是否赐福", "否", "absent"],
    ["有效赐福技能数", "0", "absent"],
    ["赐福技能数量", "0个", "absent"],
    ["赐福", "高级魔之心", "present"],
    ["有效赐福技能数", "2", "present"],
    ["赐福", "未知", "unknown"],
    ["赐福", "", "unknown"],
    ["有效赐福技能数", "0-2", "unknown"],
    ["赐福说明", "无", "unknown"],
  ])("$0=$1 -> $2", (name, value, state) => {
    expect(petBlessingState([{ name, value }]).state).toBe(state);
  });
  it("缺失字段和相互冲突值不伪装成明确无赐福", () => {
    expect(petBlessingState(fields)).toEqual({ state: "unknown", fields: [] });
    expect(
      petBlessingState([
        { name: "赐福", value: "无" },
        { name: "有效赐福技能数", value: "2" },
      ]).state,
    ).toBe("unknown");
  });
});

describe("已缓存官网 legacy 赐福预览格式", () => {
  const directory = {
    names: {
      "424": "高级魔之心",
      "324": "魔之心",
      "55424": "超级魔之心",
      "429": "地狱烈火",
      "55429": "超级地狱烈火",
    },
    mappings: {
      "424": { high_skill: 424, low_skill: 324, super_skill: 55424, name: "超级魔之心" },
      "429": { high_skill: 429, low_skill: null, super_skill: 55429, name: "超级地狱烈火" },
    },
  };
  it("官网 parser 的 | 字符串、ID数组和对象数组应核验同一完整预览", () => {
    const data = {
      ...directory,
      currentSkills: ["424", "429"],
      payloads: [
        { name: "other.EvolSkill", value: "424|429" },
        { name: "evol_skills", value: ["424", "429"] },
        {
          name: "evol_skill_list",
          value: [
            {
              skill_type: "424",
              level: 1,
              evol_type: "424",
              name: "超级魔之心（进化后获得）",
              hlightLight: true,
            },
            {
              skill_type: "429",
              level: 1,
              evol_type: "429",
              name: "超级地狱烈火（进化后获得）",
              hlightLight: true,
            },
          ],
        },
      ],
    };
    expect(petEvolutionPreview(data)).toEqual({
      supported: true,
      names: ["超级魔之心（进化后获得）", "超级地狱烈火（进化后获得）"],
    });
  });
  it("普通低级技能对应的预览是高级技能，缺少当前技能则是超级技能预览", () => {
    for (const [currentSkills, name] of [
      [["324"], "高级魔之心（进化后获得）"],
      [[], "超级魔之心（进化后获得）"],
    ] as const) {
      expect(
        petEvolutionPreview({
          ...directory,
          currentSkills: [...currentSkills],
          payloads: [{ name: "other.EvolSkill", value: "424" }],
        }),
      ).toEqual({ supported: true, names: [name] });
    }
  });
  it("仅官网EvolSkill字段falsey空值表示无预览；字符串0与非数组技能字段仍拒绝", () => {
    for (const value of [0, false, "", null])
      expect(
        petEvolutionPreview({
          ...directory,
          currentSkills: [],
          payloads: [{ name: "other.EvolSkill", value }],
        }),
      ).toEqual({ supported: true, names: [] });
    for (const [name, value] of [
      ["other.EvolSkill", "0"],
      ["evol_skill_list", 0],
      ["evol_skills", ""],
    ] as const)
      expect(
        petEvolutionPreview({ ...directory, currentSkills: [], payloads: [{ name, value }] }),
      ).toMatchObject({ supported: false, names: [] });
  });
  it("显式空原始值不能与非空派生技能同时存在，未提供原始值仍可独立核验", () => {
    for (const value of ["", null, 0, false, "0"])
      expect(
        petEvolutionPreview({
          ...directory,
          currentSkills: ["424"],
          payloads: [
            { name: "other.EvolSkill", value },
            { name: "evol_skills", value: ["424"] },
          ],
        }),
      ).toMatchObject({ supported: false, names: [] });
    expect(
      petEvolutionPreview({
        ...directory,
        currentSkills: ["424"],
        payloads: [
          { name: "other.EvolSkill", value: undefined },
          { name: "evol_skills", value: ["424"] },
        ],
      }),
    ).toEqual({ supported: true, names: ["超级魔之心（进化后获得）"] });
    expect(
      petEvolutionPreview({
        ...directory,
        currentSkills: ["424"],
        payloads: [
          { name: "other.EvolSkill", value: "424" },
          { name: "evol_skill_list", value: null },
        ],
      }),
    ).toMatchObject({ supported: false, names: [] });
  });
  it("生产来源管道核对可见预览和legacy载荷，不把未来技能当当前技能", async () => {
    const futureSkills = ["超级魔之心（进化后获得）"];
    const value = {
      ...observation(),
      skills: ["高级魔之心"],
      expectedSkills: ["高级魔之心"],
      futureSkills,
      evolution: {
        ...directory,
        currentSkills: ["424"],
        payloads: [{ name: "other.EvolSkill", value: "424" }],
      },
    };
    const page = {
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async () => value),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => 0) })),
      url: () => url,
    } as unknown as Page;
    const source = await petPageSource(page, new AbortController().signal);
    expect(source.text).toContain("技能：高级魔之心\n");
    expect(source.text).toContain("未来技能：超级魔之心（进化后获得）");
    value.futureSkills = ["伪造（进化后获得）"];
    await expect(petPageSource(page, new AbortController().signal)).rejects.toThrow(/未来技能预览/);
  });
  it("官网未明之赐占位不会误说parser格式未知，也不与无配置混用", async () => {
    const evolution = {
      ...directory,
      names: { ...directory.names, "56230": "未明之赐" },
      currentSkills: ["424"],
      payloads: [
        { name: "other.EvolSkill", value: "424|56230" },
        { name: "evol_skills", value: ["424", "56230"] },
        {
          name: "evol_skill_list",
          value: [
            {
              skill_type: "424",
              level: 1,
              evol_type: "424",
              name: "超级魔之心（进化后获得）",
              hlightLight: true,
            },
          ],
        },
      ],
    };
    expect(petEvolutionPreview(evolution)).toMatchObject({
      supported: false,
      reason: expect.stringContaining("未明之赐占位尚未揭示技能"),
    });
    const page = {
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ ...observation(), evolution })),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => 0) })),
      url: () => url,
    } as unknown as Page;
    await expect(petPageSource(page, new AbortController().signal)).rejects.toThrow(
      /未明之赐占位尚未揭示技能/,
    );
  });
  it.each([
    [{ name: "other.EvolSkill", value: "424?429" }],
    [{ name: "other.EvolSkill", value: "661" }],
    [
      { name: "other.EvolSkill", value: "424|429" },
      { name: "evol_skills", value: ["424"] },
    ],
    [
      { name: "other.EvolSkill", value: "424" },
      {
        name: "evol_skill_list",
        value: [
          {
            skill_type: "424",
            level: 1,
            evol_type: "424",
            name: "伪造（进化后获得）",
            hlightLight: true,
          },
        ],
      },
    ],
    [{ name: "evol_skill_list", value: { "424": 1 } }],
  ])("未知、缺项、不一致和无目录 ID 保持未支持", (...payloads) => {
    expect(
      petEvolutionPreview({ ...directory, currentSkills: ["424", "429"], payloads }),
    ).toMatchObject({ supported: false, names: [] });
  });
});

describe("官网宝宝查询参数", () => {
  it("明确神兽星级在严格、相近和诊断查询中保留，0星与未捕获区分", () => {
    for (const [name, level, value, expected] of [
      ["超级神羊", 99, "0", "0"],
      ["超级神狗", 119, "一星", "1"],
      ["超级神羊", 159, "2星", "2"],
      ["超级神狗", 175, "三星", "3"],
    ] as const) {
      const target = {
        ...item(),
        name,
        level,
        fields: [...fields, { name: "神兽星级", value }],
      };
      const directory = { ...config, names: { 6001: "超级神羊", 6002: "超级神狗" } };
      for (const mode of ["exact", "similar", "diagnostic"] as const) {
        expect(petQuery(target, directory, mode)).toMatchObject({
          super_sum_star: expected,
          level_min: level,
          level_max: level,
        });
        expect(petQuery({ ...target, fields }, directory, mode)).not.toHaveProperty(
          "super_sum_star",
        );
      }
    }
  });
  it("星级未知、超出已确认控件或重复冲突时不发起宽泛查询", () => {
    for (const value of ["", "未知", "4", "4星", "可能一星"])
      expect(() =>
        petQuery({ ...item(), fields: [...fields, { name: "神兽星级", value }] }, config),
      ).toThrow(/神兽星级/);
    expect(() =>
      petQuery(
        {
          ...item(),
          fields: [...fields, { name: "神兽星级", value: "0" }, { name: "神兽星级", value: "1" }],
        },
        config,
      ),
    ).toThrow(/神兽星级/);
  });
  it("特性名称仅使用唯一官网目录映射，不把效果百分比推成正负品质", () => {
    const directory = {
      ...config,
      traits: [
        [718, "灵刃"],
        [712, "顺势"],
      ] as PetSearchConfig["traits"],
    };
    for (const [name, value, expected] of [
      ["特性", "灵刃", "718"],
      ["特性类型", "顺势", "712"],
    ]) {
      const target = {
        ...item(),
        fields: [
          ...fields,
          { name, value },
          { name: "特性概率", value: "12%" },
          { name: "特性效果", value: "18%" },
        ],
      };
      for (const mode of ["exact", "similar", "diagnostic"] as const) {
        const args = petQuery(target, directory, mode);
        expect(args.texing).toBe(expected);
        expect(args).not.toHaveProperty("positive_effect");
        expect(args).not.toHaveProperty("negative_effect");
      }
    }
    expect(
      petQuery({ ...item(), fields: [...fields, { name: "特性", value: "无" }] }, directory),
    ).not.toHaveProperty("texing");
    for (const traits of [
      undefined,
      [["", "灵刃"]],
      [["not-an-id", "灵刃"]],
      [[0, "灵刃"]],
      [
        [718, "灵刃"],
        [719, "灵刃"],
      ],
    ])
      expect(() =>
        petQuery(
          { ...item(), fields: [...fields, { name: "特性类型", value: "灵刃" }] },
          { ...directory, traits: traits as PetSearchConfig["traits"] },
        ),
      ).toThrow(/特性/);
    expect(() =>
      petQuery({ ...item(), fields: [...fields, { name: "特性", value: "灵刃12%" }] }, directory),
    ).toThrow(/特性/);
  });
  it("等级与参战类别不同，不把宠物等级或数字携带等级当kindid", () => {
    const args = petQuery(
      {
        ...item(),
        fields: [...fields, { name: "携带等级", value: "105" }, { name: "参战等级", value: "105" }],
      },
      config,
    );
    expect(args.level_min).toBe(119);
    expect(args).not.toHaveProperty("kindid");
  });
  it("不同类型和等级的当前灵性不提交到官网历史灵性筛选", () => {
    for (const [name, level, type] of [
      ["幽灵", 85, "3001"],
      ["画魂", 159, "2001,2002"],
    ] as const) {
      const target = {
        ...item(),
        name,
        level,
        fields: [...fields, { name: "灵性", value: "100" }, { name: "历史灵性值", value: "96" }],
      };
      for (const mode of ["exact", "similar", "diagnostic"] as const) {
        const args = petQuery(target, config, mode);
        expect(args.type).toBe(type);
        expect(args.level_min).toBe(level);
        expect(args).not.toHaveProperty("lingxing");
      }
    }
  });
  it("实际界面提交允许技能顺序差异，但不允许遗漏条件或额外恢复筛选", () => {
    const expected = { type: "2001,2002", level_min: 99, skill: "1,2" };
    expect(() =>
      assertPetUIArguments(expected, {
        ...expected,
        type: "2002,2001",
        skill: "2,1",
        evol_skill_mode: 0,
      }),
    ).not.toThrow();
    expect(() => assertPetUIArguments(expected, { ...expected, level_min: 119 })).toThrow(
      "level_min",
    );
    expect(() => assertPetUIArguments(expected, { ...expected, price_max: 100 })).toThrow(
      "price_max",
    );
    expect(() => assertPetUIArguments(expected, { ...expected, serverid: "33" })).toThrow(
      "serverid",
    );
  });
  it("成长千分值通过官网浮点乘法和截断仍精确提交，保留严格校验", () => {
    expect(parseInt(String(parseFloat("1.009") * 1000), 10)).toBe(1008);
    for (let growth = 0; growth <= 2000; growth++) {
      const input = petGrowthInput(growth);
      const submitted = parseInt(String(parseFloat(input) * 1000), 10);
      expect(submitted, `growth=${growth}, input=${input}`).toBe(growth);
      expect(() => assertPetUIArguments({ growth }, { growth: submitted })).not.toThrow();
    }
    expect(petGrowthInput(1280)).toBe("1.280");
    for (const growth of [NaN, Infinity, -1, 1009.5])
      expect(() => petGrowthInput(growth)).toThrow("非负整数千分值");
    expect(() => assertPetUIArguments({ growth: 1009 }, { growth: 1008 })).toThrow("growth");
    try {
      assertPetUIArguments({ growth: 1009 }, { growth: 1008 });
    } catch (error) {
      expect(error).toMatchObject({ code: "PET_GROWTH_ARGUMENT_MISMATCH" });
    }
  });
  it("使用官方类型/技能/内丹ID，完整等级和成长单位，官网查询只取资质明确base", () => {
    expect(petQuery(item(), config)).toMatchObject({
      type: "2001,2002",

      level_min: 119,
      level_max: 119,
      growth: 1280,
      attack_aptitude: 1550,
      speed_aptitude_min: 1200,
      speed_aptitude_max: 1200,
      skill: "1,2",
      skill_num: 2,
      high_neidan: "9",
    });
    const args = petQuery(item(), config);
    for (const key of [
      "serverid",
      "server_id",
      "area",
      "area_id",
      "areaid",
      "cross_buy_serverid",
      "price_min",
      "price_max",
      "skill_including_advanced",
      "skill_with_suit",
    ])
      expect(args).not.toHaveProperty(key);
  });
  it("严格、相近技能子集、邻近等级和诊断均不预设服龄或服务器", () => {
    const skills = ["须弥真言", "高级法术暴击", "高级魔之心", "高级法术连击", "地狱烈火", "慧根"];
    const queries = petQueries(
      { ...item(), skills },
      {
        ...config,
        skills: skills.map((name, index) => [index + 1, name]),
      },
    );
    expect(new Set(queries.map((query) => query.matchType))).toEqual(
      new Set(["exact", "similar", "diagnostic"]),
    );
    expect(queries.length).toBeGreaterThan(4);
    for (const { args } of queries) {
      expect(args.server_type).toBeUndefined();
      for (const key of [
        "serverid",
        "server_id",
        "area",
        "area_id",
        "areaid",
        "cross_buy_serverid",
      ])
        expect(args).not.toHaveProperty(key);
    }
  });
  it("目录没有类型时明确拒绝宽泛查询；未知技能不猜ID，仍须详情核对", () => {
    expect(() => petQuery({ ...item(), name: "未知类型" }, config)).toThrow(/类型目录/);
    expect(petQuery({ ...item(), skills: ["未公开技能"] }, config)).not.toHaveProperty("skill");
    expect(petQuery({ ...item(), skills: ["未公开技能"] }, config)).not.toHaveProperty("skill_num");
  });
  it("五个当前技能与四个明确未来技能分别计数，不发送九技能误筛选", () => {
    const target = {
      ...item(),
      skills: [
        "慧根",
        "落岩",
        "高级冥思",
        "地狱烈火",
        "上古灵符",
        "超级隐身（进化后获得）",
        "超级感知（进化后获得）",
        "超级冥思（进化后获得）",
        "超级壁垒击破（进化后获得）",
      ],
    };
    const skills: PetSearchConfig["skills"] = [
      [553, "慧根"],
      [429, "落岩"],
      [315, "高级冥思"],
      [327, "地狱烈火"],
      [410, "上古灵符"],
    ];
    const query = petQuery(target, { ...config, skills });
    expect(query.skill).toBe("553,429,315,327,410");
    expect(query.skill_num).toBe(5);
    expect(target.skills).toHaveLength(9);
  });
  it("当前技能超过五个时按核心技能优先级只提交最多五个技能，并保留严格总技能数", () => {
    const skills = ["慧根", "高级魔之心", "高级法术连击", "法术暴击", "须弥真言", "地狱烈火"];
    const target = {
      ...item(),
      skills,
    };
    const directorySkills: PetSearchConfig["skills"] = [
      [315, "慧根"],
      [424, "高级魔之心"],
      [573, "高级法术连击"],
      [575, "法术暴击"],
      [661, "须弥真言"],
      [429, "地狱烈火"],
    ];
    const exact = petQuery(target, { ...config, skills: directorySkills }, "exact");
    const submittedSkills = String(exact.skill).split(",");
    expect(submittedSkills).toHaveLength(5);
    expect(submittedSkills).not.toContain("315");
    expect(submittedSkills).toEqual(expect.arrayContaining(["424", "573", "575", "661", "429"]));
    expect(exact.skill_num).toBe(6);

    const queries = petQueries(target, { ...config, skills: directorySkills });
    for (const query of queries) {
      if (query.args.skill !== undefined) {
        expect(String(query.args.skill).split(",").length).toBeLessThanOrEqual(5);
      }
    }
  });
  it("技能ID须与官网名称目录相符，未来/赐福技能不被当当前技能数量", () => {
    const target = item();
    target.skillObservations = target.skills.map((rawName, index) => ({
      rawName,
      id: String(index + 1),
      type: "cifu",
      section: "技能",
      state: "current",
    }));
    expect(petQuery(target, config)).toMatchObject({ skill: "1,2", skill_num: 2 });
    for (const state of ["future", "conditional", "unknown"] as const) {
      target.skillObservations[0].state = state;
      expect(petQuery(target, config)).toMatchObject({ skill: "2" });
      if (state === "future") expect(petQuery(target, config).skill_num).toBe(1);
      else expect(petQuery(target, config)).not.toHaveProperty("skill_num");
    }
    target.skillObservations[0].state = "current";
    target.skillObservations[0].id = "99";
    expect(petQuery(target, config)).not.toHaveProperty("skill_num");
    target.skillObservations[0].id = "1";
    delete target.skillObservations[1].id;
    expect(
      petQuery(target, { ...config, skills: [...config.skills, [3, "高级法术暴击"]] }),
    ).not.toHaveProperty("skill_num");
  });
  it("等级0可查询；不把否宝宝改成1，也不将资质的base+bonus相加", () => {
    const target = { ...item(), level: 0, fields: [...fields, { name: "是否宝宝", value: "否" }] };
    expect(petQuery(target, config)).toMatchObject({
      level_min: 0,
      level_max: 0,
      attack_aptitude: 1550,
    });
    expect(petQuery(target, config)).not.toHaveProperty("is_baobao");
    target.fields.push({ name: "宝宝", value: "是" });
    expect(petQuery(target, config)).toHaveProperty("is_baobao", 1);
  });
  it("相似筛选优先同级，有限成长资质窗口，不强制完整技能数和内丹", () => {
    expect(petQuery(item(), config, "similar")).toMatchObject({
      type: "2001,2002",
      level_min: 119,
      level_max: 119,
      attack_aptitude: 1318,
      defence_aptitude: 1190,
      physical_aptitude: 4250,
      magic_aptitude: 2380,
      speed_aptitude_min: 1020,
      speed_aptitude_max: 1380,
      growth: 1250,
      skill: "1,2",
    });
    expect(petQuery(item(), config, "similar")).not.toHaveProperty("skill_num");
    expect(petQuery(item(), config, "similar")).not.toHaveProperty("high_neidan");
    const max = item();
    max.fields = fields.map((field) =>
      field.name === "速度资质" ? { ...field, value: "10000" } : field,
    );
    expect(petQuery(max, config, "similar")).toHaveProperty("speed_aptitude_max", 10000);
    expect(petQuery({ ...item(), level: 0 }, config, "similar")).toMatchObject({
      level_min: 0,
      level_max: 0,
    });
  });
  it("官方特殊类型没有可交易查询定义时明确缺价，恶魔泡泡不替换成泡泡", () => {
    const special = { ...item(), name: "恶魔泡泡" };
    expect(() =>
      petQuery(
        special,
        {
          ...config,
          names: { 102004: "泡泡" },
          officialTypeIds: ["112058", "112073"],
        },
        "similar",
      ),
    ).toThrow(/特殊类型按规则跳过/);
  });
  it("诊断查询只取官方类型、同等级和明确宝宝flag，不携带估值筛选字段", () => {
    const target = { ...item(), fields: [...fields, { name: "是否宝宝", value: "是" }] };
    expect(petQuery(target, config, "diagnostic")).toEqual({
      type: "2001,2002",

      level_min: 119,
      level_max: 119,
      is_baobao: 1,
    });
  });
});

describe("主宝宝商品来源核对", () => {
  it("读取前等待主商品渲染；等待期间取消保持原原因且不采诊断", async () => {
    const read = vi.fn().mockResolvedValue(observation());
    const wait = vi.fn().mockResolvedValue(undefined);
    const page = {
      waitForFunction: wait,
      evaluate: read,
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => 0) })),
      url: () => url,
    } as unknown as Page;
    expect((await petPageSource(page, new AbortController().signal)).price).toBe(368.6);
    expect(wait).toHaveBeenCalledWith(expect.any(Function), expect.any(String), { timeout: 5000 });
    expect(wait.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
    const control = new AbortController();
    const cancellation = new Error("取消等待主宝宝");
    read.mockClear();
    wait.mockImplementationOnce(async () => control.abort(cancellation));
    await expect(petPageSource(page, control.signal)).rejects.toBe(cancellation);
    expect(read).not.toHaveBeenCalled();
  });
  it("渲染超时保存最小结构诊断并给出公开原因，不读取完整页面或登录状态", async () => {
    const diagnostics = { panels: [], info: [], jsonInputs: 0, mainPrices: [] };
    const timeout = Object.assign(new Error("Timeout 5000ms"), { name: "TimeoutError" });
    const page = {
      waitForFunction: vi.fn().mockRejectedValue(timeout),
      evaluate: vi.fn().mockResolvedValue(diagnostics),
    } as unknown as Page;
    await expect(petPageSource(page, new AbortController().signal)).rejects.toMatchObject({
      message: "主宝宝属性、商品信息或价格区域未加载完成",
      petDiagnostics: diagnostics,
    });
  });
  it("绑定当前URL/ID/区服、可见主价与JSON，按人民币元生成可复核来源", () => {
    const source = petObservationSource(observation(), url);
    expect(source.price).toBe(368.6);
    expect(source.text).toContain("攻击资质：1550 +22");
    const checked = verifyPetCandidate(
      item(),
      {
        url,
        title: "画魂",
        price: source.price,
        priceType: "listing",
        quote: pageText(source.html),
        verified: false,
        reason: "",
        fetchedAt: null,
        sourceHash: null,
      },
      source.html,
      "now",
    );
    expect(checked.verified).toBe(true);
    expect(checked.sourceHash).toHaveLength(64);
  });
  it.each([
    { name: "赐福", value: "无" },
    { name: "有效赐福技能数", value: "0" },
  ])("候选明确无有效赐福时可以与普通目标匹配：$name", (field) => {
    const source = petObservationSource({ ...observation(), fields: [...fields, field] }, url);
    const checked = verifyPetCandidate(
      item(),
      {
        url,
        title: "画魂",
        price: source.price,
        priceType: "listing",
        quote: source.text,
        verified: false,
        reason: "",
        fetchedAt: null,
        sourceHash: null,
      },
      source.html,
      "now",
    );
    expect(checked.verified, checked.reason).toBe(true);
  });
  it.each([
    { name: "赐福", value: "高级魔之心" },
    { name: "赐福", value: "未知" },
    { name: "有效赐福技能数", value: "2" },
  ])("候选有真实或未知赐福状态时保留阻断：$name=$value", async (field) => {
    const value = { ...observation(), fields: [...fields, field] };
    const page = {
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async () => value),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => 0) })),
      url: () => url,
    } as unknown as Page;
    await expect(petPageSource(page, new AbortController().signal)).rejects.toThrow(/赐福/);
  });
  it.each([
    { name: "赐福", value: "高级魔之心" },
    { name: "赐福", value: "未知" },
    { name: "赐福", value: "" },
    { name: "有效赐福技能数", value: "2" },
    { name: "赐福", value: "无", conflict: { name: "赐福技能数", value: "1" } },
  ])("独立比较同样保护真实、未知和冲突赐福状态：$name=$value", (field) => {
    const additions = [
      { name: field.name, value: field.value },
      ...(field.conflict ? [field.conflict] : []),
    ];
    const source = petObservationSource(
      { ...observation(), fields: [...fields, ...additions] },
      url,
    );
    for (const target of [item(), { ...item(), fields: [...fields, ...additions] }]) {
      const checked = verifyPetCandidate(
        target,
        {
          url,
          title: "画魂",
          price: source.price,
          priceType: "listing",
          quote: source.text,
          verified: false,
          reason: "",
          fetchedAt: null,
          sourceHash: null,
        },
        source.html,
        "now",
        "similar",
      );
      expect(checked.verified).toBe(false);
      expect(checked.reason).toMatch(/赐福.*(?:存在|未知)/);
    }
  });
  it("不把未知未来技能描述错误归类为已确认赐福", async () => {
    const page = {
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ ...observation(), unsupportedDescription: true })),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => 0) })),
      url: () => url,
    } as unknown as Page;
    await expect(petPageSource(page, new AbortController().signal)).rejects.toThrow(
      /未来.*描述.*原始.*可见/,
    );
  });
  it.each([
    { productId: "other" },
    { serverId: 2 },
    { productName: "别的昵称" },
    { storageType: 1 },
    { rawPrice: "36860" },
    { prices: ["￥368.60", "￥999"] },
    { petStorageType: undefined },
  ])("身份、商品类别或主价格冲突不采用：%j", (override) => {
    expect(() => petObservationSource({ ...observation(), ...override }, url)).toThrow();
  });
  it.each([
    { skills: ["须弥真言"] },
    { innerSkills: [{ name: "催心浪", level: "1" }] },
    { equipment: [{ name: "项圈", description: "等级 80\n速度 +20" }] },
    { expectedEquipment: [{ name: "项圈", description: "等级 80\n速度 +20" }] },
    { fields: fields.filter((field) => field.name !== "成长") },
    { fields: [...fields, { name: "等级", value: "129" }] },
  ])("技能/内丹/装备/属性未完整或冲突不投影成同配置：%j", (override) => {
    expect(() => petObservationSource({ ...observation(), ...override }, url)).toThrow();
  });
  it("JSON说在售但主商品显示下架时保留下架，验证器拒绝采用", () => {
    const source = petObservationSource({ ...observation(), body: "状态：已下架" }, url);
    expect(source.text).toContain("商品已下架");
    expect(
      verifyPetCandidate(
        item(),
        {
          url,
          title: "画魂",
          price: source.price,
          priceType: "listing",
          quote: source.text,
          verified: false,
          reason: "",
          fetchedAt: null,
          sourceHash: null,
        },
        source.html,
        "now",
      ).verified,
    ).toBe(false);
  });
  it("完整空技能/内丹/装备可以明确为空，非空装备保留完整属性只计一次", () => {
    const empty = {
      ...observation(),
      skills: [],
      expectedSkills: [],
      innerSkills: [],
      expectedInner: [],
    };
    expect(petObservationSource(empty, url).text).toContain("技能：无\n内丹：无\n宝宝装备：无");
    const gear = [{ name: "宝宝项圈", description: "等级：80\n速度：20" }];
    const source = petObservationSource(
      { ...observation(), equipment: gear, expectedEquipment: gear },
      url,
    );
    expect(
      verifyPetCandidate(
        { ...item(), equipment: gear },
        {
          url,
          title: "画魂",
          price: source.price,
          priceType: "listing",
          quote: pageText(source.html),
          verified: false,
          reason: "",
          fetchedAt: null,
          sourceHash: null,
        },
        source.html,
        "now",
      ).verified,
    ).toBe(true);
  });
  it("装备背景文案不造成官网属性误差，实际数值差异仍拒绝", () => {
    const gear = [
      {
        name: "嵌宝金环",
        description:
          "等级 95\n速度 +29 伤害 +45\n耐久度 307 修理失败 1次\n镶嵌效果\n+30速度 镶嵌等级：5",
      },
    ];
    const observed = {
      ...observation(),
      equipment: [
        { ...gear[0], description: "镶嵌着宝物的金环，可以提高速度。\n" + gear[0].description },
      ],
      expectedEquipment: gear,
    };
    expect(petObservationSource(observed, url).price).toBe(368.6);
    for (const description of [
      gear[0].description.replace("+29", "+30"),
      gear[0].description.replace("+30速度", "+31速度"),
    ])
      expect(() =>
        petObservationSource({ ...observed, equipment: [{ ...gear[0], description }] }, url),
      ).toThrow(/随身装备/);
  });
  it("官网饰品无需战斗属性，但可见身份、完整描述和官方饰品图标配置必须一致", () => {
    const gear = [
      { name: "吸血鬼饰品", description: "修理失败 2次\n可爱的小裙子", accessory: true },
    ];
    const observed = { ...observation(), equipment: gear, expectedEquipment: gear };
    const source = petObservationSource(observed, url);
    expect(source.html).toContain('data_equip_location="RolePetShipin"');
    expect(source.html).toContain("修理失败 2次");
    expect(source.html).not.toMatch(/等级[：:]80|速度[：:]20/);
    expect(
      verifyPetCandidate(
        { ...item(), equipment: gear },
        {
          url,
          title: "画魂",
          price: source.price,
          priceType: "listing",
          quote: pageText(source.html),
          verified: false,
          reason: "",
          fetchedAt: null,
          sourceHash: null,
        },
        source.html,
        "now",
      ).verified,
    ).toBe(true);
    for (const expectedEquipment of [
      [{ ...gear[0], accessory: false }],
      [{ ...gear[0], description: "修理失败 1次" }],
      [{ ...gear[0], name: "画魂饰品" }],
    ])
      expect(() => petObservationSource({ ...observed, expectedEquipment }, url)).toThrow(
        /随身装备/,
      );
    expect(() =>
      petObservationSource({ ...observed, equipment: [{ ...gear[0], description: "" }] }, url),
    ).toThrow(/随身装备/);
  });
});

describe("宝宝查询使用独立后台页", () => {
  let crawl: CrawlStore;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    crawl = new CrawlStore(":memory:");
    expect(crawl.acquire("collecting")).toBe(true);
    runtime.crawlDatabase.mockReturnValue(crawl.db);
  });
  afterEach(() => {
    expect(crawl.db.prepare("SELECT owner FROM crawl_lock").get()?.owner).toBe("collecting");
    crawl.close();
    vi.useRealTimers();
  });
  const pages = () => ({
    search: { close: vi.fn(async () => {}), on: vi.fn(), off: vi.fn() },
    detail: { close: vi.fn(async () => {}), goto: vi.fn() },
  });
  const open = async (control = new AbortController()) => {
    const { search, detail } = pages();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    return { source: await createPetSource(control.signal, "1"), search, detail, control };
  };
  const queryPages = (
    exactRows: boolean,
    control = new AbortController(),
    emptySimilar = false,
    marketOverrides: Record<string, string | number | undefined> = {},
    omitMarketRequest = false,
  ) => {
    const calls: Record<string, number | string>[] = [];
    let requestListener: ((request: Request) => void) | undefined;
    let currentArgs: Record<string, number | string> = {},
      currentUrl = "";
    const rows = [0, 1, 2].map((index) => ({
      url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
      name: "模拟宝宝",
      type: "2001",
    }));
    const inputValues: Record<string, string> = {};
    const selected = new Map<string, Set<string>>();
    let baby = false;
    const requestFromClick = (pageNumber: number) => {
      currentArgs = {
        type: Object.entries(config.names)
          .filter(([, name]) => name === inputValues.pet_select_box)
          .map(([id]) => id)
          .join(","),
        serverid: inputValues.ovarall_sel_server,
      };
      for (const [id, value] of Object.entries(inputValues)) {
        if (id.startsWith("txt_") && value)
          currentArgs[id.slice(4)] =
            id === "txt_growth" ? Math.trunc(Number(value) * 1000) : Number(value);
      }
      if (baby) currentArgs.is_baobao = 1;
      for (const key of ["skill", "high_neidan", "low_neidan"]) {
        const value = [
          ...(selected.get(key === "skill" ? "pet_skill_wrap" : key + "_panel") || []),
        ].join(",");
        if (value) currentArgs[key] = value;
      }
      calls.push(currentArgs);
      const requestUrl = new URL("https://xyq.cbg.163.com/cgi-bin/recommend.py");
      const parameters = {
        ...currentArgs,
        act: "recommd_by_role",
        search_type: "overall_search_pet",
        page: pageNumber,
        ...marketOverrides,
      };
      for (const [key, value] of Object.entries(parameters))
        if (value !== undefined) requestUrl.searchParams.set(key, String(value));
      if (!omitMarketRequest)
        requestListener?.({ url: () => requestUrl.href, postData: () => null } as Request);
    };
    const locator = (selector: string) => {
      const control = {
        first: () => control,
        count: async () => 1,
        isVisible: async () => true,
        fill: async (value: string) => {
          inputValues[selector.slice(1)] = value;
        },
        selectOption: async (value: string) => {
          inputValues[selector.slice(1)] = value;
        },
        setChecked: async (value: boolean) => {
          baby = value;
        },
        press: async () => requestFromClick(Number(inputValues[selector.slice(1)])),
        click: async () => {
          if (selector === "#reset_all") {
            for (const key of Object.keys(inputValues)) delete inputValues[key];
            selected.clear();
            baby = false;
          } else if (selector === "#btn_pet_search") requestFromClick(1);
          else if (selector.startsWith("#pager "))
            requestFromClick(Number(selector.match(/goto\((\d+)\)/)?.[1]));
          else if (selector.startsWith("#pet_skill_wrap")) {
            const skills = selected.get("pet_skill_wrap") || new Set<string>();
            skills.add(selector.match(/data-skill_id="(\d+)"/)![1]);
            selected.set("pet_skill_wrap", skills);
          }
        },
        all: async () => {
          const panel = selector.match(/^#(.+) > li$/)?.[1] || "";
          const ids =
            panel === "server_type_panel"
              ? ["1", "2", "3"]
              : panel === "high_neidan_panel"
                ? config.highNeidans.map(([id]) => String(id))
                : config.lowNeidans.map(([id]) => String(id));
          return ids.map((value) => ({
            evaluate: async () => ({ value, selected: selected.get(panel)?.has(value) || false }),
            click: async () => {
              const values = selected.get(panel) || new Set<string>();
              if (values.has(value)) values.delete(value);
              else values.add(value);
              selected.set(panel, values);
            },
          }));
        },
      };
      return control;
    };
    const search = {
      locator: vi.fn(locator),
      on: vi.fn((event: string, listener: (request: Request) => void) => {
        if (event === "request") requestListener = listener;
      }),
      off: vi.fn((event: string, listener: (request: Request) => void) => {
        if (event === "request" && requestListener === listener) requestListener = undefined;
      }),
      goto: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async (fn: Function, arg: unknown): Promise<unknown> => {
        if (fn.name === "readPageSnapshot")
          return {
            url: PET_SEARCH_URL,
            title: "模拟宝宝搜索",
            ready: true,
            serverAuthenticated: true,
            hasLogout: true,
            hasLogin: false,
            hasQr: false,
            hasRoles: false,
            hasDialog: false,
            serverName: "",
          };
        if (fn.name === "marketServerArea") return "1";
        if (fn.name === "selectedMarketServer")
          return { areaId: inputValues.overall_sel_area, serverid: inputValues.ovarall_sel_server };
        if (typeof arg === "string") return config;
        if (fn.toString().includes("官网宝宝表单未保存实际查询条件")) return currentArgs;
        if (typeof arg === "number") {
          const visibleRows =
            currentArgs.speed_aptitude_min === undefined ||
            exactRows ||
            (!emptySimilar && currentArgs.speed_aptitude_min !== 1200)
              ? rows
              : [];
          return { rows: visibleRows, empty: !visibleRows.length, hasNext: false };
        }
      }),
    };
    const detail = {
      close: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => 0) })),
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      url: () => currentUrl,
      evaluate: vi.fn(async () => {
        const value = observation();
        const changed = fields.map((field) =>
          field.name === "速度资质" && currentArgs.speed_aptitude_min !== 1200
            ? { ...field, value: "1280" }
            : field,
        );
        const index = Number(currentUrl.match(/sample-(\d)/)?.[1]);
        return {
          ...value,
          productId: "sample-" + index,
          rawPrice: 300 + index * 30,
          prices: ["￥" + (300 + index * 30)],
          fields: changed.filter((field) => field.name !== "类型"),
          parsedFields: changed,
        };
      }),
    };
    return {
      calls,
      search,
      detail,
      source: petSourceFromPages(
        search as unknown as Page,
        detail as unknown as Page,
        control.signal,
        "1",
      ),
    };
  };
  it("严格查询空结果才顺序发起相似窗口，读取独立详情并保留真实查询级别", async () => {
    const { source, calls, detail } = queryPages(false);
    try {
      const result = await source.findCandidates([item()], new AbortController().signal);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        level_min: 119,
        speed_aptitude_min: 1200,
        speed_aptitude_max: 1200,
      });
      expect(calls[1]).toMatchObject({
        level_min: 119,
        speed_aptitude_min: 1020,
        speed_aptitude_max: 1380,
      });
      expect(detail.goto).toHaveBeenCalledTimes(3);
      expect(result.items[0].candidates).toHaveLength(3);
      expect(
        result.items[0].candidates.every(
          (candidate) => candidate.verified && candidate.matchType === "similar",
        ),
      ).toBe(true);
      expect(result.searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ matchType: "exact", rows: 0, details: 0 }),
          expect.objectContaining({ matchType: "similar", rows: 3, details: 3 }),
        ]),
      );
    } finally {
      await source.close();
    }
  });
  it.each([
    { name: "赐福", value: "无" },
    { name: "有效赐福技能数", value: "0" },
  ])("明确无赐福不被搜索入口误跳过：$name=$value", async (field) => {
    const { source, calls } = queryPages(false);
    try {
      const result = await source.findCandidates(
        [{ ...item(), fields: [...fields, field] }],
        new AbortController().signal,
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.items[0].candidates).toHaveLength(3);
      expect(result.items[0].candidates.every((candidate) => candidate.verified)).toBe(true);
    } finally {
      await source.close();
    }
  });
  it.each([
    { name: "赐福", value: "高级魔之心" },
    { name: "有效赐福技能数", value: "1" },
    { name: "赐福", value: "未知" },
  ])("真实或未知目标赐福继续阻断，原因给出所缺内容：$name", async (field) => {
    const { source, calls } = queryPages(false);
    try {
      const result = await source.findCandidates(
        [{ ...item(), fields: [...fields, field] }],
        new AbortController().signal,
      );
      expect(calls).toHaveLength(0);
      expect(result.items[0]).toMatchObject({
        searchState: "unsupported",
        candidates: [],
        note: expect.stringMatching(/完整.*(?:有效状态|字段确认)/),
      });
    } finally {
      await source.close();
    }
  });
  it("各筛选前5条无有效样本时完成搜索，不翻页读取后排商品", async () => {
    const { source, search } = queryPages(true);
    const evaluate = search.evaluate.getMockImplementation()!;
    search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
      const result = await evaluate(fn, arg);
      return typeof arg === "number"
        ? {
            rows: Array.from({ length: 5 }, (_, index) => ({
              url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
              name: "模拟宝宝",
              type: "2001",
            })),
            empty: false,
            hasNext: true,
          }
        : result;
    });
    const target = item();
    target.fields = target.fields.map((field) =>
      field.name === "成长" ? { ...field, value: "1.0" } : field,
    );
    try {
      const result = await source.findCandidates([target], new AbortController().signal);
      expect(result.items[0]).toMatchObject({ searchState: "completed" });
      expect(result.items[0].candidates.some((candidate) => candidate.verified)).toBe(false);
      expect(search.evaluate.mock.calls.some(([, arg]) => typeof arg === "number" && arg > 1)).toBe(
        false,
      );
      expect(result.items[0].note).toContain("前5条");
    } finally {
      await source.close();
    }
  });
  it("无报价的未完成筛选页变动时，从该条件前5条重新取样", async () => {
    const first = queryPages(true);
    const target = item();
    target.fields = target.fields.map((field) =>
      field.name === "成长" ? { ...field, value: "1.0" } : field,
    );
    const now = Date.now();
    const originalEvaluate = first.search.evaluate.getMockImplementation()!;
    first.search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
      const value = await originalEvaluate(fn, arg);
      return typeof arg === "number"
        ? {
            rows: Array.from({ length: 5 }, (_, index) => ({
              url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
              name: "模拟宝宝",
              type: "2001",
            })),
            empty: false,
            hasNext: true,
          }
        : value;
    });
    const originalDetail = first.detail.evaluate.getMockImplementation()!;
    let reads = 0;
    first.detail.evaluate.mockImplementation(async () => {
      const value = await originalDetail();
      if (++reads === 3) vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
      return value;
    });
    let saved: PetPricingItem;
    try {
      const result = await first.source.findCandidates([target], new AbortController().signal);
      expect(result.items[0]).toMatchObject({
        searchState: "pending",
        searchCursor: { modeIndex: 0 },
      });
      expect(result.items[0].candidates.some((candidate) => candidate.verified)).toBe(false);
      saved = { ...target, ...result.items[0] };
      // An unfinished active page can change on the next official recommendation request.
      saved.searchCursor!.rowIndex = 2;
      saved.searchCursor!.pageRowsHash = "changed-active-page";
      saved.searchCursor!.pageHistory![0].rowsHash = "changed-active-page";
    } finally {
      vi.restoreAllMocks();
      await first.source.close();
    }
    const second = queryPages(true);
    const secondEvaluate = second.search.evaluate.getMockImplementation()!;
    second.search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
      const value = await secondEvaluate(fn, arg);
      return typeof arg === "number"
        ? {
            rows: Array.from({ length: 5 }, (_, index) => ({
              url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
              name: "模拟宝宝",
              type: "2001",
            })),
            empty: false,
            hasNext: true,
          }
        : value;
    });
    try {
      const result = await second.source.findCandidates([saved!], new AbortController().signal);
      expect(second.calls[0]).toMatchObject(petQueries(target, config)[0].args);
      expect(result.items[0].note).not.toContain("顺序已变化");
      expect(result.items[0]).toMatchObject({ searchState: "completed" });
      expect(result.searchItems).not.toContainEqual(
        expect.objectContaining({ reason: "result_order_changed" }),
      );
    } finally {
      await second.source.close();
    }
  });

  it("官方特殊类型无独立交易筛选时只核验目录并排除，不替换其他类型", async () => {
    const { source, search, calls } = queryPages(true);
    const evaluate = search.evaluate.getMockImplementation()!;
    search.evaluate.mockImplementation(async (fn: Function, arg: unknown) =>
      typeof arg === "string"
        ? { ...config, officialTypeIds: ["112058", "112073"] }
        : evaluate(fn, arg),
    );
    const target = { ...item(), name: "恶魔泡泡" };
    try {
      const result = await source.findCandidates([target], new AbortController().signal);
      expect(calls).toHaveLength(0);
      expect(result.items[0]).toMatchObject({
        searchState: "skipped",
        skipReason: "官网无独立交易筛选的特殊宝宝，未计入参考合计",
        candidates: [],
      });
      expect(result.searchItems).toContainEqual(
        expect.objectContaining({
          reason: "official_non_saleable_type",
          officialTypeIds: ["112058", "112073"],
        }),
      );
    } finally {
      await source.close();
    }
  });

  it("每页保存最终市场请求与服务器候选分布，空页也保留证据", async () => {
    const { source, search } = queryPages(false);
    try {
      const result = await source.findCandidates([item()], new AbortController().signal);
      expect(result.searchItems).toEqual([
        expect.objectContaining({
          scopeEvidence: [
            expect.objectContaining({
              mode: "exact",
              rowCount: 0,
              candidateServers: {},
              request: expect.objectContaining({
                act: "recommd_by_role",
                searchType: "overall_search_pet",
                serverType: "",
                page: 1,
                restrictions: { serverid: "1" },
              }),
            }),
          ],
        }),
        expect.objectContaining({
          scopeEvidence: [
            expect.objectContaining({
              mode: "similar",
              rowCount: 3,
              candidateServers: { "1": 3 },
              request: expect.objectContaining({
                serverType: "",
                page: 1,
                restrictions: { serverid: "1" },
              }),
            }),
          ],
        }),
      ]);
    } finally {
      await source.close();
      expect(search.off).toHaveBeenCalledWith("request", expect.any(Function));
    }
  });
  it("翻页分别确认目标单服请求并保存每页候选数量", async () => {
    const { source, search, detail } = queryPages(true);
    const evaluateSearch = search.evaluate.getMockImplementation()!;
    search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
      if (typeof arg !== "number") return evaluateSearch(fn, arg);
      const rows = (
        arg === 1
          ? [[0, 1]]
          : [
              [1, 1],
              [2, 1],
            ]
      ).map(([index, server]) => ({
        url: `https://xyq.cbg.163.com/equip?s=${server}&eid=sample-${index}`,
        name: "模拟宝宝",
        type: "2001",
      }));
      return { rows, empty: false, hasNext: arg === 1 };
    });
    const evaluateDetail = detail.evaluate.getMockImplementation()!;
    detail.evaluate.mockImplementation(async () => ({
      ...(await evaluateDetail()),
      serverId: new URL(detail.goto.mock.calls.at(-1)![0]).searchParams.get("s"),
    }));
    try {
      const result = await source.findCandidates([item()], new AbortController().signal);
      expect(result.items[0].candidates).toHaveLength(3);
      expect(result.searchItems).toEqual([
        expect.objectContaining({
          scopeEvidence: [
            expect.objectContaining({
              rowCount: 1,
              candidateServers: { "1": 1 },
              request: expect.objectContaining({ page: 1, serverType: "" }),
            }),
            expect.objectContaining({
              rowCount: 2,
              candidateServers: { "1": 2 },
              request: expect.objectContaining({ page: 2, serverType: "" }),
            }),
          ],
        }),
      ]);
    } finally {
      await source.close();
    }
  });
  it.each([
    ["缺少目标服务器", { serverid: undefined }],
    ["额外服龄限制", { server_type: "2" }],
    ["限定单服", { serverid: 33 }],
    ["限定单服别名", { server_id: 33 }],
    ["限定地区", { area: 1 }],
    ["限定地区别名", { area_id: 1 }],
    ["另一地区别名", { areaid: 1 }],
  ])("最终请求%s时拒绝候选，不依赖提交前args", async (_name, overrides) => {
    const { source, detail } = queryPages(true, new AbortController(), false, overrides);
    try {
      await expect(source.findCandidates([item()], new AbortController().signal)).rejects.toThrow();
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("单服请求返回外服行时停止，不能过滤后补样本", async () => {
    const { source, search, detail } = queryPages(true);
    const evaluate = search.evaluate.getMockImplementation()!;
    search.evaluate.mockImplementation(async (fn: Function, arg: unknown) =>
      typeof arg === "number"
        ? {
            rows: [
              {
                url: "https://xyq.cbg.163.com/equip?s=33&eid=foreign",
                name: "模拟宝宝",
                type: "2001",
              },
            ],
            empty: false,
            hasNext: false,
          }
        : evaluate(fn, arg),
    );
    try {
      await expect(source.findCandidates([item()], new AbortController().signal)).rejects.toThrow(
        "目标单服",
      );
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("只有页面成功回调而没有市场请求时，不能采纳报价", async () => {
    const { source, detail } = queryPages(true, new AbortController(), false, {}, true);
    try {
      await expect(source.findCandidates([item()], new AbortController().signal)).rejects.toThrow();
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("宝宝结果等待超时保存回调和加载状态，不读取详情或掩盖超时类型", async () => {
    const { source, search, detail } = queryPages(true);
    search.waitForFunction.mockImplementation(async (...parameters: unknown[]) => {
      const options = parameters[2] as { timeout?: number } | undefined;
      if (options?.timeout === 20000)
        throw Object.assign(new Error("page.waitForFunction: Timeout 20000ms exceeded."), {
          name: "TimeoutError",
        });
    });
    const original = search.evaluate.getMockImplementation()!;
    search.evaluate.mockImplementation(async (fn: Function, arg: unknown) =>
      fn.name === "readPetSearchWaitState"
        ? { callbackReceived: false, callbackPage: null, loadingVisible: true }
        : original(fn, arg),
    );
    try {
      await expect(
        source.findCandidates([item()], new AbortController().signal),
      ).rejects.toMatchObject({
        name: "TimeoutError",
        code: "PET_SEARCH_RESULT_TIMEOUT",
        message: expect.stringContaining("回调未收到，回调页未知，加载图标仍显示"),
      });
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("当前结果确认读完但只有两个独立商品时，返回实际件数", async () => {
    const { source, search, detail } = queryPages(false);
    const skills = ["须弥真言", "高级法术暴击", "高级魔之心", "高级法术连击", "地狱烈火", "慧根"];
    const directory = {
      ...config,
      skills: skills.map((name, index) => [index + 1, name] as [number, string]),
    };
    const original = search.evaluate.getMockImplementation()!;
    let queryCount = 0;
    search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
      if (typeof arg === "string") return directory;
      if (fn.toString().includes("官网宝宝表单未保存实际查询条件")) queryCount++;
      if (typeof arg === "number") {
        const indices = queryCount === 1 ? [] : queryCount <= 3 ? [0, 1] : [0, 1, 2];
        const rows = indices.map((index) => ({
          url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
          name: "模拟宝宝",
          type: "2001",
        }));
        return { rows, empty: !rows.length, hasNext: false };
      }
      return original(fn, arg);
    });
    detail.evaluate.mockImplementation(async () => {
      const currentUrl = detail.goto.mock.calls.at(-1)![0];
      const index = Number(currentUrl.match(/sample-(\d)/)?.[1]);
      const sampleFields = fields.map((field) =>
        field.name === "速度资质" ? { ...field, value: "1280" } : field,
      );
      return {
        ...observation(),
        productId: "sample-" + index,
        rawPrice: 300 + index * 30,
        prices: ["￥" + (300 + index * 30)],
        fields: sampleFields.filter((field) => field.name !== "类型"),
        parsedFields: sampleFields,
        skills,
        expectedSkills: skills,
      };
    });
    try {
      const result = await source.findCandidates(
        [{ ...item(), skills }],
        new AbortController().signal,
      );
      expect(queryCount).toBe(2);
      expect(result.items[0].candidates).toHaveLength(2);
      expect(new Set(result.items[0].candidates.map((entry) => entry.url)).size).toBe(2);
      expect(
        result.items[0].candidates.every(
          (entry) => entry.verified && entry.matchType === "similar",
        ),
      ).toBe(true);
      expect(detail.goto).toHaveBeenCalledTimes(2);
      expect(result.items[0].searchState).toBe("completed");
    } finally {
      await source.close();
    }
  });

  it("找到严格样本后不再放宽，不把exact金额混入similar", async () => {
    const { source, calls } = queryPages(true);
    try {
      const result = await source.findCandidates([item()], new AbortController().signal);
      expect(calls).toHaveLength(1);
      expect(
        result.items[0].candidates.every(
          (candidate) => candidate.verified && candidate.matchType === "exact",
        ),
      ).toBe(true);
    } finally {
      await source.close();
    }
  });
  it("第一页前5条无效时不读取第6条后的有效商品", async () => {
    const first = queryPages(true);
    const prepare = (value: ReturnType<typeof queryPages>) => {
      const evaluateSearch = value.search.evaluate.getMockImplementation()!;
      value.search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
        if (typeof arg !== "number") return evaluateSearch(fn, arg);
        const rows = Array.from({ length: 9 }, (_, index) => ({
          url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
          name: "模拟宝宝",
          type: "2001",
        }));
        return { rows, empty: false, hasNext: false };
      });
      const evaluateDetail = value.detail.evaluate.getMockImplementation()!;
      value.detail.evaluate.mockImplementation(async () => {
        const observed = await evaluateDetail();
        const index = Number(value.detail.goto.mock.calls.at(-1)![0].match(/sample-(\d+)/)?.[1]);
        return index < 6 ? { ...observed, skills: [], expectedSkills: [] } : observed;
      });
    };
    prepare(first);
    try {
      const result = await first.source.findCandidates([item()], new AbortController().signal);
      expect(first.detail.goto).toHaveBeenCalledTimes(5);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.items[0].candidates.filter((candidate) => candidate.verified)).toHaveLength(0);
      expect(result.items[0]).not.toHaveProperty("searchCursor");
    } finally {
      await first.source.close();
    }
  });
  it("第一页前5个相近候选无效时不扩大取样范围", async () => {
    const prepare = (value: ReturnType<typeof queryPages>) => {
      const evaluate = value.search.evaluate.getMockImplementation()!;
      value.search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
        if (typeof arg !== "number") return evaluate(fn, arg);
        const rows =
          value.calls.at(-1)?.speed_aptitude_min === 1200
            ? []
            : Array.from({ length: 8 }, (_, index) => ({
                url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
                name: "模拟宝宝",
                type: "2001",
              }));
        return { rows, empty: !rows.length, hasNext: false };
      });
      const evaluateDetail = value.detail.evaluate.getMockImplementation()!;
      value.detail.evaluate.mockImplementation(async () => {
        const observed = await evaluateDetail();
        const index = Number(value.detail.goto.mock.calls.at(-1)![0].match(/sample-(\d+)/)?.[1]);
        return index < 5 ? { ...observed, skills: [], expectedSkills: [] } : observed;
      });
    };
    const first = queryPages(false);
    prepare(first);
    try {
      const result = await first.source.findCandidates([item()], new AbortController().signal);
      expect(first.detail.goto).toHaveBeenCalledTimes(5);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.items[0].candidates.filter((candidate) => candidate.verified)).toHaveLength(0);
      expect(
        result.items[0].candidates
          .filter((candidate) => candidate.verified)
          .every((candidate) => candidate.verified && candidate.matchType === "similar"),
      ).toBe(true);
    } finally {
      await first.source.close();
    }
  });
  it("翻页预算耗尽恢复到第四页，经官网重放表单后取得报价", async () => {
    const prepare = (value: ReturnType<typeof queryPages>) => {
      const evaluate = value.search.evaluate.getMockImplementation()!;
      value.search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
        if (typeof arg !== "number") return evaluate(fn, arg);
        const rows = (arg === 4 ? [4, 5, 6] : [arg]).map((index) => ({
          url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
          name: "模拟宝宝",
          type: "2001",
        }));
        return { rows, empty: false, hasNext: arg < 4 };
      });
      const evaluateDetail = value.detail.evaluate.getMockImplementation()!;
      value.detail.evaluate.mockImplementation(async () => {
        const observed = await evaluateDetail();
        const index = Number(value.detail.goto.mock.calls.at(-1)![0].match(/sample-(\d+)/)?.[1]);
        return index > 1 && index < 4 ? { ...observed, skills: [], expectedSkills: [] } : observed;
      });
    };
    const first = queryPages(true);
    prepare(first);
    let saved: PetPricingItem;
    try {
      const result = await first.source.findCandidates([item()], new AbortController().signal);
      expect(result.items[0]).toMatchObject({
        searchState: "pending",
        searchCursor: { modeIndex: 0, pageNumber: 4, rowIndex: 0 },
      });
      saved = { ...item(), ...result.items[0] };
    } finally {
      await first.source.close();
    }
    const second = queryPages(true);
    prepare(second);
    try {
      const validation = await second.source.findCandidates([saved!], new AbortController().signal);
      expect(validation.items[0].searchState).toBe("pending");
      expect(validation.items[0].searchCursor?.historyIndex).toBe(3);
      expect(second.detail.goto).toHaveBeenCalledTimes(1);
      const result = await second.source.findCandidates(
        [{ ...item(), ...validation.items[0] }],
        new AbortController().signal,
      );
      expect(second.calls).toHaveLength(5);
      expect(second.detail.goto).toHaveBeenCalledTimes(3);
      expect(second.detail.goto.mock.calls.some(([url]) => url.endsWith("sample-6"))).toBe(false);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.queries).toHaveLength(1);
      expect(result.searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scopeEvidence: [
              expect.objectContaining({ request: expect.objectContaining({ page: 1 }) }),
              expect.objectContaining({ request: expect.objectContaining({ page: 4 }) }),
            ],
          }),
        ]),
      );
    } finally {
      await second.source.close();
    }
  });
  it("单个详情读取失败保留待重试URL，恢复时重读保存报价并清除故障", async () => {
    const first = queryPages(true);
    const evaluate = first.detail.evaluate.getMockImplementation()!;
    first.detail.evaluate.mockImplementation(async () => {
      if (first.detail.goto.mock.calls.at(-1)![0].endsWith("sample-0"))
        throw new Error("模拟详情临时故障");
      return evaluate();
    });
    let saved: ReturnType<typeof item>;
    try {
      const result = await first.source.findCandidates([item()], new AbortController().signal);
      expect(result.items[0]).toMatchObject({
        searchState: "read_failed",
        searchCursor: {
          failed: [{ url: "https://xyq.cbg.163.com/equip?s=1&eid=sample-0", modeIndex: 0 }],
        },
      });
      saved = {
        ...item(),
        candidates: result.items[0].candidates.filter((candidate) => candidate.verified),
        searchCursor: result.items[0].searchCursor,
      };
    } finally {
      await first.source.close();
    }
    const second = queryPages(true);
    try {
      const result = await second.source.findCandidates([saved!], new AbortController().signal);
      expect(second.detail.goto).toHaveBeenCalledTimes(3);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.items[0].candidates).toHaveLength(3);
      expect(result.items[0]).not.toHaveProperty("searchCursor");
    } finally {
      await second.source.close();
    }
  });
  it("前排宝宝详情失败时不跳过它采用后排报价，恢复重试后按顺序完成", async () => {
    const record = valuationRecord();
    record.listing.serverId = "1";
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
      petCount: 1,
      pets: [
        {
          index: 1,
          name: "画魂",
          fields,
          skills: item().skills.map((name, index) => ({ name, index, kind: "skill" as const })),
          innerSkills: [{ name: "催心浪", index: 0, level: "5", kind: "innerSkill" as const }],
          equipment: [],
        },
      ],
    });
    const first = queryPages(false);
    const evaluate = first.detail.evaluate.getMockImplementation()!;
    first.detail.evaluate.mockImplementation(async () => {
      if (first.detail.goto.mock.calls.at(-1)![0].endsWith("sample-0"))
        throw new Error("模拟详情临时故障");
      return evaluate();
    });
    let saved;
    try {
      saved = await searchPetPricing(record, new AbortController().signal, first.source);
      expect(saved.items[0].searchState).toBe("read_failed");
      expect(saved.items[0].similarEstimate?.sampleCount).toBe(0);
      expect(saved.searchComplete).toBe(false);
    } finally {
      await first.source.close();
    }
    const second = queryPages(false);
    try {
      const result = await searchPetPricing(
        record,
        new AbortController().signal,
        second.source,
        saved,
      );
      expect(second.calls).toHaveLength(3);
      expect(second.detail.goto).toHaveBeenCalledTimes(3);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.items[0].similarEstimate).toMatchObject({
        status: "range",
        median: 330,
        sampleCount: 3,
        range: { min: 300, max: 360 },
      });
      expect(result.searchComplete).toBe(true);
      expect(result.searchAttempts!.at(-1)!.queries).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/仅重读.*独立宝宝详情/),
          expect.stringMatching(/目标单服.*similar/),
        ]),
      );
      expect(result.searchAttempts!.at(-1)!.searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "saved_detail_refresh" }),
          expect.objectContaining({ matchType: "similar", exhausted: true }),
        ]),
      );
    } finally {
      await second.source.close();
    }
  });
  it("前五件按官网顺序保存，后续更近的配置不能挤掉前面的有效样本", async () => {
    const prepare = (value: ReturnType<typeof queryPages>) => {
      const evaluate = value.search.evaluate.getMockImplementation()!;
      value.search.evaluate.mockImplementation(async (fn: Function, arg: unknown) => {
        if (typeof arg !== "number") return evaluate(fn, arg);
        const rows =
          value.calls.at(-1)?.speed_aptitude_min === 1200
            ? []
            : Array.from({ length: 8 }, (_, index) => ({
                url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
                name: "模拟宝宝",
                type: "2001",
              }));
        return { rows, empty: !rows.length, hasNext: false };
      });
      const evaluateDetail = value.detail.evaluate.getMockImplementation()!;
      value.detail.evaluate.mockImplementation(async () => {
        const observed = await evaluateDetail();
        const index = Number(value.detail.goto.mock.calls.at(-1)![0].match(/sample-(\d+)/)?.[1]);
        const fields = observed.parsedFields.map((field: { name: string; value: string }) =>
          index < 5 && field.name === "防御资质" ? { ...field, value: "1350" } : field,
        );
        const price = index < 5 ? (index % 2 ? 900 : 100) : 400 + (index - 5) * 20;
        return {
          ...observed,
          fields: fields.filter((field: { name: string }) => field.name !== "类型"),
          parsedFields: fields,
          rawPrice: price,
          prices: ["￥" + price],
        };
      });
    };
    const first = queryPages(false);
    prepare(first);
    try {
      const result = await first.source.findCandidates([item()], new AbortController().signal);
      expect(first.detail.goto).toHaveBeenCalledTimes(5);
      expect(result.items[0].searchState).toBe("completed");
      expect(result.searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matchType: "similar",
            candidates: expect.arrayContaining([
              expect.objectContaining({ price: 100 }),
              expect.objectContaining({ price: 900 }),
            ]),
          }),
        ]),
      );
      expect(
        result.items[0].candidates
          .filter((candidate) => candidate.verified)
          .map((candidate) => candidate.price),
      ).toEqual([100, 900, 100, 900, 100]);
    } finally {
      await first.source.close();
    }
  });
  it("exact及similar均0行后最多读3个同等级诊断详情，绝不误计匹配样本", async () => {
    const { source, calls, detail } = queryPages(false, new AbortController(), true);
    try {
      const result = await source.findCandidates([item()], new AbortController().signal);
      expect(calls).toHaveLength(4);
      expect(calls[2]).toMatchObject({ level_min: 114, level_max: 124 });
      expect(calls[3]).toEqual({
        type: "2001,2002",
        serverid: "1",
        level_min: 119,
        level_max: 119,
      });
      expect(detail.goto).toHaveBeenCalledTimes(3);
      expect(result.items[0].candidates).toEqual([]);
      expect(result.items[0].diagnosticSources).toHaveLength(3);
      expect(
        result.items[0].diagnosticSources!.every(
          (candidate) => !candidate.verified && candidate.price !== null && candidate.sourceHash,
        ),
      ).toBe(true);
      expect(result.searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ matchType: "diagnostic", rows: 3, details: 3 }),
        ]),
      );
    } finally {
      await source.close();
    }
  });
  it("采集持锁时仍可查宝宝，只关闭自有页", async () => {
    const { source, search, detail } = await open();
    await source.close();
    await source.close();
    expect(runtime.getBrowser).toHaveBeenCalledExactlyOnceWith(true);
    expect(runtime.createHiddenPage).toHaveBeenCalledTimes(2);
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("预先取消时不连接或创建页面", async () => {
    const control = new AbortController();
    control.abort(new Error("停止"));
    await expect(createPetSource(control.signal, "1")).rejects.toThrow("停止");
    expect(runtime.getBrowser).not.toHaveBeenCalled();
    expect(runtime.createHiddenPage).not.toHaveBeenCalled();
  });
  it("第二页创建失败时关闭已创建的第一页", async () => {
    const { search } = pages();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage
      .mockResolvedValueOnce(search)
      .mockRejectedValueOnce(new Error("详情页失败"));
    await expect(createPetSource(new AbortController().signal, "1")).rejects.toThrow("详情页失败");
    expect(search.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("创建途中取消时清理两页", async () => {
    const { search, detail } = pages();
    const control = new AbortController();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockImplementationOnce(async () => {
      control.abort(new Error("停止"));
      return detail;
    });
    await expect(createPetSource(control.signal, "1")).rejects.toThrow("停止");
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
  });
  it("取消自动清理两页，finally close幂等且禁止后续读取", async () => {
    const { source, control, search, detail } = await open();
    control.abort(new Error("暂停"));
    await source.close();
    await source.close();
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(source.readSource(url, new AbortController().signal)).rejects.toThrow("暂停");
  });
  it("关闭等待两页实际结束，一个close失败仍关闭另一页", async () => {
    const { search, detail } = pages(),
      control = new AbortController();
    let finish!: () => void;
    search.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    detail.close.mockRejectedValueOnce(new Error("断开"));
    const source = petSourceFromPages(
      search as unknown as Page,
      detail as unknown as Page,
      control.signal,
      "1",
    );
    control.abort();
    let done = false;
    const cleanup = source.close().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(detail.close).toHaveBeenCalledOnce();
    finish();
    await cleanup;
    expect(done).toBe(true);
  });
  it("不读取任意外站，也不跟随另一商品重定向", async () => {
    const { search, detail } = pages();
    const target = { ...detail, url: () => "https://xyq.cbg.163.com/equip?s=1&eid=other" };
    const source = petSourceFromPages(
      search as unknown as Page,
      target as unknown as Page,
      new AbortController().signal,
      "1",
    );
    try {
      await expect(
        source.readSource("https://example.com/equip?s=1&eid=a", new AbortController().signal),
      ).rejects.toThrow();
      expect(detail.goto).not.toHaveBeenCalled();
      await expect(
        source.readSource(
          "https://xyq.cbg.163.com/equip?s=33&eid=foreign",
          new AbortController().signal,
        ),
      ).rejects.toThrow("目标单服");
      expect(detail.goto).not.toHaveBeenCalled();
      await expect(source.readSource(url, new AbortController().signal)).rejects.toThrow(
        /另一商品/,
      );
    } finally {
      await source.close();
    }
  });
});

it("正式相近查询按普通技能子集保留受保护技能，同级先于有限附近等级", () => {
  const skills = ["须弥真言", "高级魔之心", "高级法术连击", "法术暴击", "地狱烈火", "慧根"];
  const target = {
    ...item(),
    skills,
    level: 99,
    skillObservations: skills.map((rawName) => ({
      rawName,
      type: "cifu",
      state: "current" as const,
    })),
  };
  const directory = {
    ...config,
    skills: skills.map((name, index) => [index + 1, name] as [number, string]),
  };
  const queries = petQueries(target, directory);
  const similar = queries.filter((query) => query.matchType === "similar");
  expect(queries[0].matchType).toBe("exact");
  expect(similar.some((query) => String(query.args.skill).split(",").length === 4)).toBe(true);
  for (const query of similar) {
    expect(String(query.args.skill).split(",")).toEqual(expect.arrayContaining(["1", "2", "3"]));
    expect(query.args).not.toHaveProperty("skill_num");
    expect(query.args).not.toHaveProperty("high_neidan");
  }
  expect(similar[0].args).toMatchObject({ level_min: 99, level_max: 99 });
  expect(similar[similar.length - 1].args).toMatchObject({ level_min: 94, level_max: 104 });
  expect(similar.some((query) => String(query.args.skill).split(",").length === 5)).toBe(true);
  const sameLevel = similar.filter((query) => query.args.level_min === 99);
  const nearby = similar.filter((query) => query.args.level_min === 94);
  expect(nearby.map((query) => query.args.skill)).toEqual(
    sameLevel.map((query) => query.args.skill),
  );
});
it.each(["须弥真言", "高级法术连击", "高级魔之心"])(
  "法宠相近核验不会因普通共有技能足够而放过缺失核心：%s",
  (missing) => {
    const target = ["须弥真言", "高级法术连击", "高级魔之心", "法术暴击", "地狱烈火", "慧根"];
    expect(
      similarPetSkills(
        target,
        target.filter((skill) => skill !== missing),
      ).accepted,
    ).toBe(false);
    expect(
      similarPetSkills(
        target,
        target.filter((skill) => skill !== "慧根"),
      ).accepted,
    ).toBe(true);
  },
);

it("明确未来预览独立核对并保留，不能伪装成当前技能或丢弃配置状态", () => {
  const futureSkills = ["超级法术连击（进化后获得）"];
  const value = { ...observation(), futureSkills, expectedFutureSkills: [...futureSkills] };
  const source = petObservationSource(value, url);
  expect(source.text).toContain("未来技能：超级法术连击（进化后获得）");
  expect(source.text).toContain("技能：须弥真言、高级法术暴击\n");
  expect(() => petObservationSource({ ...value, expectedFutureSkills: [] }, url)).toThrow(
    /未来技能预览/,
  );
  const target = { ...item(), skills: [...item().skills, ...futureSkills] };
  expect(
    verifyPetCandidate(
      target,
      {
        url,
        title: "画魂",
        price: source.price,
        priceType: "listing",
        quote: source.text,
        verified: false,
        reason: "",
        fetchedAt: null,
        sourceHash: null,
      },
      source.html,
      new Date().toISOString(),
    ).verified,
  ).toBe(true);
});

// Scope failures must stop before another server's details can be read.
it("未提供目标服时宝宝source不创建页面", async () => {
  runtime.getBrowser.mockClear();
  await expect(
    createPetSource(new AbortController().signal, undefined as unknown as string),
  ).rejects.toThrow("目标服务器");
  expect(runtime.getBrowser).not.toHaveBeenCalled();
});
