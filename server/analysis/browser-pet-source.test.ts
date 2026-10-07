import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import {
  createPetSource,
  PET_SEARCH_URL,
  petObservationSource,
  petPageSource,
  petQuery,
  petSourceFromPages,
  type PetSearchConfig,
} from "./browser-pet-source";
import { verifyPetCandidate, type PetPricingItem } from "./pet-pricing";
import { CrawlStore } from "../crawler/store";
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
    expect(petQuery({ ...item(), skills: ["未公开技能"] }, config)).not.toHaveProperty("skill_num");
  });
  it("真实九个可见技能只映射五个时，不发送九技能的误筛选，也不推断当前技能数是五", () => {
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
    expect(query).not.toHaveProperty("skill_num");
    expect(target.skills).toHaveLength(9);
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
      expect(petQuery(target, config)).not.toHaveProperty("skill_num");
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
  it("相似筛选保持等级/成长/技能/内丹，有限调整主要资质下限及速度窗口", () => {
    expect(petQuery(item(), config, "similar")).toMatchObject({
      type: "2001,2002",
      level_min: 119,
      level_max: 119,
      attack_aptitude: 1473,
      defence_aptitude: 1330,
      physical_aptitude: 4750,
      magic_aptitude: 2660,
      speed_aptitude_min: 1080,
      speed_aptitude_max: 1320,
      growth: 1280,
      skill: "1,2",
      skill_num: 2,
      high_neidan: "9",
    });
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
    ).toThrow(/特殊类型保留未定价/);
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
    const page = { waitForFunction: wait, evaluate: read, url: () => url } as unknown as Page;
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
    search: { close: vi.fn(async () => {}) },
    detail: { close: vi.fn(async () => {}), goto: vi.fn() },
  });
  const open = async (control = new AbortController()) => {
    const { search, detail } = pages();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    return { source: await createPetSource(control.signal), search, detail, control };
  };
  const queryPages = (
    exactRows: boolean,
    control = new AbortController(),
    emptySimilar = false,
  ) => {
    const calls: Record<string, number | string>[] = [];
    let currentArgs: Record<string, number | string> = {},
      currentUrl = "";
    const rows = [0, 1, 2].map((index) => ({
      url: `https://xyq.cbg.163.com/equip?s=1&eid=sample-${index}`,
      name: "模拟宝宝",
      type: "2001",
    }));
    const search = {
      goto: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async (fn: Function, arg: unknown) => {
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
        if (typeof arg === "string") return config;
        if (arg && typeof arg === "object" && "args" in arg) {
          currentArgs = (arg as { args: Record<string, number | string> }).args;
          calls.push(currentArgs);
        }
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
        speed_aptitude_min: 1080,
        speed_aptitude_max: 1320,
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
  it("exact及similar均0行后最多读3个同等级诊断详情，绝不误计匹配样本", async () => {
    const { source, calls, detail } = queryPages(false, new AbortController(), true);
    try {
      const result = await source.findCandidates([item()], new AbortController().signal);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual({ type: "2001,2002", level_min: 119, level_max: 119 });
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
    expect(runtime.getBrowser).toHaveBeenCalledWith();
    expect(runtime.createHiddenPage).toHaveBeenCalledTimes(2);
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("预先取消时不连接或创建页面", async () => {
    const control = new AbortController();
    control.abort(new Error("停止"));
    await expect(createPetSource(control.signal)).rejects.toThrow("停止");
    expect(runtime.getBrowser).not.toHaveBeenCalled();
    expect(runtime.createHiddenPage).not.toHaveBeenCalled();
  });
  it("第二页创建失败时关闭已创建的第一页", async () => {
    const { search } = pages();
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage
      .mockResolvedValueOnce(search)
      .mockRejectedValueOnce(new Error("详情页失败"));
    await expect(createPetSource(new AbortController().signal)).rejects.toThrow("详情页失败");
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
    await expect(createPetSource(control.signal)).rejects.toThrow("停止");
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
