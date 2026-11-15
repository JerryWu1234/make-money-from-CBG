import { describe, expect, it } from "vite-plus/test";
import { collectNativeDetail, type NativeCaptureIO } from "./native-capture";
import { MAIN_TABS } from "../crawler/detail-tabs";
import { captureIssues, IncompleteCaptureError } from "../crawler/capture-readiness";
import { analysisRecord } from "../../tests/fixtures/analysis";
import type { PageSnapshot } from "./contracts";

function fixture() {
  const listing = analysisRecord("a").listing;
  let revision = "product-version-1",
    selected = "人物/修炼";
  const names = [
    "师门一式",
    "师门二式",
    "师门三式",
    "师门四式",
    "师门五式",
    "师门六式",
    "师门七式",
  ];
  const source = {
    serverId: listing.serverId,
    eid: listing.eid,
    holyLevel: 0,
    riders: {},
    advancedMount: { isJinJie: 0 },
    hasArtifact: false,
    idEffects: [],
    allSkills: Object.fromEntries(names.map((_, index) => [String(index + 1), 1])),
    assets: { iCash: 0, iSaving: 0, iLearnCash: 0, xianyu: 0 },
  };
  const assetContent: Record<string, string> = {
    坐骑: "无坐骑",
    "锦衣/外观": "无锦衣\n无祥瑞",
    玩家之家: "无房屋\n无庭院",
  };
  const snapshot = (): PageSnapshot => ({
    context: {
      schemaVersion: 1,
      runId: "run",
      queryId: "query",
      actionId: "action",
      pageId: "page",
      pageGeneration: 1,
      browserSessionEpoch: "session",
      stopEpoch: 0,
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      sourceKind: "extension-native",
    },
    url: listing.url,
    title: "synthetic public role",
    revision: "snapshot-" + selected,
    visible: true,
    loading: false,
    access: "normal",
    empty: false,
    productIdentity: { serverId: listing.serverId, eid: listing.eid },
    productRevision: revision,
    controls: {
      tabs: [...MAIN_TABS],
      subtabs: [],
      pets: [],
      mounts: [],
      children: [],
      petCount: 0,
      selectedPet: null,
      selectedMount: null,
      selectedChild: null,
      items: [],
    },
    valuationSource: source,
    detail: {
      url: listing.url,
      collectedAt: new Date().toISOString(),
      tabs: [
        {
          name: selected,
          contentText: assetContent[selected] ?? selected,
          text:
            selected === "技能"
              ? "师门技能\n" + names.map((name) => "1\n" + name).join("\n") + "\n生活技能"
              : selected === "道具/法宝"
                ? "无装备"
                : selected === "召唤兽/孩子"
                  ? "召唤兽（0/20）\n暂无召唤兽"
                  : selected,
          fields: [],
          tables: [],
          elements:
            selected === "技能"
              ? names.map((name) => ({
                  data_skill_type: "school_skill",
                  data_equip_name: name,
                  data_equip_level: "1",
                }))
              : [],
          tooltips: [],
        },
      ],
      raw: { EquipInfo: { server_id: listing.serverId, eid: listing.eid } },
    },
  });
  const io: NativeCaptureIO = {
    observer: {
      mode: "extension-native",
      snapshot: async () => snapshot(),
      waitFor: async () => snapshot(),
      evidence: async () => {
        const value = snapshot();
        return { context: value.context, revision: value.revision, snapshot: value };
      },
      close: async () => {},
    },
    query: async (target) => {
      if (target.kind === "detail-tab") selected = target.name;
      return snapshot();
    },
  };
  return {
    listing,
    io,
    snapshot,
    setRevision: (value: string) => {
      revision = value;
    },
  };
}
describe("native plain-data complete capture contract", () => {
  it("visits the same seven main tabs and passes the existing identity/skill/asset validators", async () => {
    const f = fixture();
    const result = await collectNativeDetail(f.io, f.listing, new AbortController().signal);
    expect(result.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
    expect(captureIssues(result, true, true, f.listing)).toEqual([]);
    expect(result.equipmentCapture?.emptyProof).toBe("explicit-text");
    expect(result.petCapture?.complete).toBe(true);
  });
  it("reuses identity/model/description-checked AllEquip levels for nonempty worn equipment", async () => {
    const f = fixture(),
      query = f.io.query.bind(f.io);
    const source = {
      serverId: f.listing.serverId,
      eid: f.listing.eid,
      allEquip: { "1": { iType: 123, cDesc: "防御 +100", obj_level: 120 } },
    };
    f.io.query = async (...args) => {
      const value = await query(...args);
      value.wornEquipment = source;
      if (value.detail?.tabs[0].name === "道具/法宝") {
        value.detail.tabs[0].text = "现金：0";
        value.detail.tabs[0].elements = [
          {
            data_equip_name: "测试头盔",
            data_equip_type: "123",
            data_equip_location: "role_using_equip_1",
            data_equip_desc: "防御 +100",
          },
        ];
        value.controls!.items = [
          { index: 0, name: "测试头盔", modelId: "123", location: "role_using_equip_1" },
        ];
        if (args[0].kind === "inspect-item") {
          expect(args[0]).toEqual({ kind: "inspect-item", ...value.controls!.items[0] });
          value.detail.tabs[0].tooltips = ["测试头盔\n防御 +100"];
        }
      }
      return value;
    };
    const result = await collectNativeDetail(f.io, f.listing, new AbortController().signal);
    expect(result.tabs.find((tab) => tab.name === "道具/法宝")?.items?.[0].attributes?.等级).toBe(
      "120",
    );
    expect(result.equipmentCapture?.complete).toBe(true);
    expect(result.raw.wornEquipment).toEqual(source);
    source.eid = "another-product";
    await expect(
      collectNativeDetail(f.io, f.listing, new AbortController().signal),
    ).rejects.toBeInstanceOf(IncompleteCaptureError);
  });
  it("keeps a life skill without an observed level partial instead of skipping its missing fields", async () => {
    const f = fixture();
    const query = f.io.query.bind(f.io);
    f.io.query = async (...args) => {
      const value = await query(...args);
      if (value.detail?.tabs[0].name === "技能")
        value.detail.tabs[0].elements.push({
          data_skill_type: "life_skill",
          data_equip_name: "烹饪技巧",
        });
      return value;
    };
    const result = await collectNativeDetail(f.io, f.listing, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(IncompleteCaptureError);
    expect(
      (result as IncompleteCaptureError).detail.tabs
        .find((tab) => tab.name === "技能")
        ?.items?.filter((item) => item.category === "师门技能"),
    ).toHaveLength(7);
  });
  it("reads each distinct warehouse icon when names, models and locations are identical", async () => {
    const f = fixture();
    const query = f.io.query.bind(f.io);
    const inspected: number[] = [];
    const elements = [100, 200].map((defense) => ({
      data_equip_name: "同名仓库头盔",
      data_equip_type: "900199",
      data_equip_location: "RoleStoreEquips",
      data_equip_category: "头盔",
      data_equip_desc: `等级：120#r防御：${defense}`,
    }));
    f.io.query = async (...args) => {
      const value = await query(...args);
      if (value.detail?.tabs[0].name === "道具/法宝") {
        value.detail.tabs[0].text = "道具和法宝";
        value.detail.tabs[0].elements = elements;
        value.controls!.items = elements.map((attrs, index) => ({
          index,
          name: attrs.data_equip_name,
          modelId: attrs.data_equip_type,
          location: attrs.data_equip_location,
        }));
        const target = args[0];
        if (target.kind === "inspect-item") {
          inspected.push(target.index);
          value.detail.tabs[0].tooltips = [
            `同名仓库头盔\n等级：120\n防御：${target.index === 0 ? 100 : 200}`,
          ];
        }
      }
      return value;
    };
    const result = await collectNativeDetail(f.io, f.listing, new AbortController().signal);
    expect(inspected).toEqual([0, 1]);
    expect(
      result.tabs.find((tab) => tab.name === "道具/法宝")?.items?.map((item) => item.description),
    ).toEqual(["等级：120\n防御：100", "等级：120\n防御：200"]);
    expect(captureIssues(result, true, true, f.listing)).toEqual([]);
  });
  it("keeps partial snapshots when the source version changes mid-read", async () => {
    const f = fixture();
    const query = f.io.query.bind(f.io);
    f.io.query = async (...args) => {
      if (args[0].kind === "detail-tab" && args[0].name === "技能") f.setRevision("changed");
      return query(...args);
    };
    const error = await collectNativeDetail(f.io, f.listing, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(IncompleteCaptureError);
    expect((error as IncompleteCaptureError).detail.tabs).toHaveLength(1);
    expect((error as IncompleteCaptureError).detail.valuation?.issues.join(" ")).toContain(
      "版本变化",
    );
  });
  it("does not relabel another selected tab as the requested main tab", async () => {
    const f = fixture();
    f.io.query = async () => f.snapshot();
    const error = await collectNativeDetail(f.io, f.listing, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(IncompleteCaptureError);
    expect((error as IncompleteCaptureError).detail.tabs).toHaveLength(1);
  });
});
