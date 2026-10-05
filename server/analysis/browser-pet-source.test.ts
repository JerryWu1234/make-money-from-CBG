import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import {
  createPetSource,
  petObservationSource,
  petQuery,
  petSourceFromPages,
  type PetSearchConfig,
} from "./browser-pet-source";
import { verifyPetCandidate, type PetPricingItem } from "./pet-pricing";
import { pageText } from "./equipment-pricing";
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

describe("官网宝宝查询参数", () => {
  it("使用官方类型/技能/内丹ID，完整等级和成长单位，全服查询只取资质明确base", () => {
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
      "server_type",
      "cross_buy_serverid",
      "price_min",
      "price_max",
      "skill_including_advanced",
      "skill_with_suit",
    ])
      expect(args).not.toHaveProperty(key);
  });
  it("目录没有类型时明确拒绝宽泛查询；未知技能不猜ID，仍须详情核对", () => {
    expect(() => petQuery({ ...item(), name: "未知类型" }, config)).toThrow(/类型目录/);
    expect(petQuery({ ...item(), skills: ["未公开技能"] }, config)).not.toHaveProperty("skill");
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
});

describe("主宝宝商品来源核对", () => {
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

describe("宝宝查询拥有页面与共享采集锁", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const pages = () => ({
    search: { close: vi.fn(async () => {}) },
    detail: { close: vi.fn(async () => {}), goto: vi.fn() },
  });
  const database = (changes = 1) => {
    const acquire = vi.fn().mockReturnValue({ changes }),
      release = vi.fn();
    runtime.crawlDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => ({ run: sql.startsWith("INSERT") ? acquire : release })),
    });
    return { acquire, release };
  };
  const open = async (control = new AbortController()) => {
    const { search, detail } = pages();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    return { source: await createPetSource(control.signal), search, detail, control };
  };
  it("采集持锁或预先取消时不开Chrome/新页", async () => {
    database(0);
    await expect(createPetSource(new AbortController().signal)).rejects.toThrow(/采集/);
    const control = new AbortController();
    control.abort(new Error("停止"));
    await expect(createPetSource(control.signal)).rejects.toThrow("停止");
    expect(runtime.getBrowser).not.toHaveBeenCalled();
    expect(runtime.createHiddenPage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("只复用缓存浏览器；第二页创建失败关闭第一页并释放自己的锁", async () => {
    const { acquire, release } = database(),
      { search } = pages();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage
      .mockResolvedValueOnce(search)
      .mockRejectedValueOnce(new Error("详情页失败"));
    await expect(createPetSource(new AbortController().signal)).rejects.toThrow("详情页失败");
    expect(runtime.getBrowser).toHaveBeenCalledWith();
    expect(search.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("取消自动清理两页和锁，随后finally close幂等且禁止后续读取", async () => {
    const { release } = database();
    const { source, control, search, detail } = await open();
    control.abort(new Error("暂停"));
    await source.close();
    await source.close();
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(source.readSource(url, new AbortController().signal)).rejects.toThrow("暂停");
  });
  it("续租失败中止自有页并释放timer和锁，不继续查询", async () => {
    const { acquire, release } = database(),
      { source, detail } = await open();
    acquire.mockReturnValue({ changes: 0 });
    await vi.advanceTimersByTimeAsync(30000);
    await expect(source.findCandidates([item()], new AbortController().signal)).rejects.toThrow(
      /锁已失效/,
    );
    await source.close();
    expect(detail.goto).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
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
    );
    try {
      await expect(
        source.readSource("https://example.com/equip?s=1&eid=a", new AbortController().signal),
      ).rejects.toThrow();
      expect(detail.goto).not.toHaveBeenCalled();
      await expect(source.readSource(url, new AbortController().signal)).rejects.toThrow(
        /另一商品/,
      );
    } finally {
      await source.close();
    }
  });
});
