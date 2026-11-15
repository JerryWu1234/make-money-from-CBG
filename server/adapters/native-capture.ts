import { MAIN_TABS } from "../crawler/detail-tabs";
import {
  CAPTURE_VERSION,
  equipmentNameUnresolved,
  isNonRoleEquipment,
  itemFromAttributes,
  mergeWornEquipmentLevel,
} from "../crawler/compact";
import { equipmentCaptureSummary } from "../crawler/equipment-capture";
import { petCaptureSummary } from "../crawler/pet-capture-summary";
import { normalizeValuationSource } from "../crawler/valuation-source";
import { completeSchoolSkillsFromText } from "../crawler/school-skills";
import { captureIssues, IncompleteCaptureError } from "../crawler/capture-readiness";
import type { Listing, PetSnapshot, RoleDetail, TabSnapshot } from "../crawler/types";
import type { ActionPlan, PageObserver, PageSnapshot, SemanticTarget } from "./contracts";
import { UnsupportedAdapterOperation } from "./contracts";

export interface NativeCaptureIO {
  observer: PageObserver;
  query(
    target: SemanticTarget,
    expected: ActionPlan["expected"],
    signal?: AbortSignal,
  ): Promise<PageSnapshot>;
}
/** Visits observed controls only. The final complete/partial decision is shared with Playwright. */
export async function collectNativeDetail(
  io: NativeCaptureIO,
  listing: Listing,
  signal: AbortSignal,
): Promise<RoleDetail> {
  const tabs: TabSnapshot[] = [],
    pets: PetSnapshot[] = [],
    issues: string[] = [];
  let current = await io.observer.snapshot(),
    initialRevision: string | undefined,
    step = "详情入口";
  let petCount: number | null = null;
  const identity = (value: PageSnapshot) =>
    value.productIdentity?.serverId === listing.serverId &&
    value.productIdentity.eid === listing.eid;
  const assemble = (): RoleDetail => {
    const now = new Date().toISOString();
    const valuation = current.valuationSource
      ? normalizeValuationSource(current.valuationSource)
      : { version: 1 as const, fields: [], source: {}, issues: ["网页没有可核验的角色解析数据"] };
    if (!initialRevision || !current.productRevision || initialRevision !== current.productRevision)
      valuation.issues.push("详情读取期间商品原文或解析器版本变化或未核验");
    return {
      captureMode: "all",
      captureVersion: CAPTURE_VERSION,
      url: listing.url,
      collectedAt: now,
      tabs: tabs.map(completeSchoolSkillsFromText),
      raw: {
        ...current.detail?.raw,
        ...(current.wornEquipment ? { wornEquipment: current.wornEquipment } : {}),
      },
      valuation,
      equipmentCapture: equipmentCaptureSummary(
        tabs,
        now,
        issues.filter((issue) => issue.startsWith("装备")),
      ),
      petCapture: petCaptureSummary(
        petCount,
        pets,
        now,
        issues.filter((issue) => issue.startsWith("召唤兽")),
      ),
    };
  };
  const inspect = async (snapshot: TabSnapshot, elements = snapshot.elements) => {
    snapshot.items = [];
    for (const [index, attributes] of elements.entries()) {
      signal.throwIfAborted();
      const merged = snapshot.name.startsWith("道具/法宝")
        ? mergeWornEquipmentLevel(attributes, listing, current.wornEquipment)
        : { attrs: attributes, issue: undefined };
      if (merged.issue) issues.push("装备：" + merged.issue);
      const observedAttrs = merged.attrs;
      let item = itemFromAttributes(observedAttrs, index);
      if (!item) continue;
      const needTooltip =
        equipmentNameUnresolved(item.name) ||
        (item.kind === "equipment" &&
          !isNonRoleEquipment(item) &&
          !item.description &&
          !Object.keys(item.attributes || {}).length);
      if (needTooltip) {
        const control = current.controls?.items.find(
          (entry) =>
            entry.modelId === (attributes.data_equip_type || "") &&
            entry.name === (attributes.data_equip_name || attributes.alt || "") &&
            entry.location === (attributes.data_equip_location || ""),
        );
        if (!control?.name) throw new UnsupportedAdapterOperation("缺少独立名称证明的详情图标悬停");
        current = await io.query({ kind: "inspect-item", ...control }, { kind: "changed" }, signal);
        const tooltip = current.detail?.tabs
          .flatMap((tab) => tab.tooltips)
          .find((value) => value.includes(control.name));
        if (!tooltip) throw new UnsupportedAdapterOperation("没有与物品身份关联的官网提示框");
        const parsed = itemFromAttributes({ ...observedAttrs, data_equip_desc: tooltip }, index);
        if (parsed) item = { ...parsed, tooltip };
      }
      snapshot.items.push(item);
    }
    if (snapshot.name.startsWith("道具/法宝")) {
      const unread = [...snapshot.items];
      for (const container of snapshot.equipmentContainers || [])
        for (const icon of container.icons) {
          if (icon.modelId === "17320" && icon.name === "三界密令") continue;
          const match = icon.modelId
            ? unread.findIndex(
                (item) =>
                  item.modelId === icon.modelId &&
                  (!icon.name || equipmentNameUnresolved(icon.name) || item.name === icon.name),
              )
            : -1;
          if (match < 0) issues.push(`装备：${container.id}存在尚未逐项读取的图标`);
          else unread.splice(match, 1);
        }
    }
    snapshot.itemsCollectedAt = new Date().toISOString();
  };
  const capture = async (name: string) => {
    if (!identity(current) || !current.detail || current.loading || current.access !== "normal")
      throw new UnsupportedAdapterOperation("当前商品身份和详情快照读取");
    if (initialRevision && current.productRevision !== initialRevision)
      throw new Error("商品原文或解析器在读取期间变化");
    const snapshot = structuredClone(current.detail.tabs[0]);
    if (!snapshot || !snapshot.name || snapshot.name === "未知标签")
      throw new UnsupportedAdapterOperation("缺少官网选中标签证明的详情读取");
    if (snapshot.name !== name && snapshot.name !== name.split(" / ")[0])
      throw new UnsupportedAdapterOperation("实际选中详情标签与采集计划不一致");
    snapshot.name = name;
    snapshot.collectedAt = new Date().toISOString();
    tabs.push(snapshot);
    await inspect(snapshot);
    return snapshot;
  };
  try {
    if (!identity(current))
      current = await io.query(
        { kind: "listing-detail", serverId: listing.serverId, eid: listing.eid },
        { kind: "detail", serverId: listing.serverId, eid: listing.eid },
        signal,
      );
    initialRevision = current.productRevision;
    for (const name of MAIN_TABS) {
      step = name;
      signal.throwIfAborted();
      if (!current.controls?.tabs.includes(name))
        throw new UnsupportedAdapterOperation(`官网「${name}」标签入口`);
      current = await io.query({ kind: "detail-tab", name }, { kind: "changed" }, signal);
      const snapshot = await capture(name);
      if (name === "召唤兽/孩子") {
        petCount = current.controls?.petCount ?? null;
        const entries = current.controls?.pets || [];
        if (petCount === null || petCount !== entries.length)
          throw new Error("召唤兽总数与可核验入口数量不一致");
        for (const entry of entries) {
          current = await io.query(
            { kind: "detail-entry", section: "pet", ...entry },
            { kind: "changed" },
            signal,
          );
          const proof = current.petProof;
          if (!proof || proof.loading) throw new Error("召唤兽详细信息区域未完整读取");
          const petTab = structuredClone(current.detail!.tabs[0]);
          await inspect(petTab, proof.elements);
          const stats = proof.text
            .split(/(?:^|\n)技能(?:\s*[（(]\s*\d+\s*[）)])?(?:\n|$)/)[0]
            .replace(/[ \t]+(?=[^\s：:]{1,20}[：:])/g, "\n");
          const fields = [
            ...stats.matchAll(/(?:^|[\n\t；])([^：:\n\t；]{1,30})[：:]\s*([^\n\t；]+)/g),
          ].map((match) => ({ name: match[1].trim(), value: match[2].trim() }));
          const items = petTab.items || [];
          const pet: PetSnapshot = {
            index: entry.index + 1,
            name:
              fields.find((field) => /^(名称|名字|宝宝)$/.test(field.name))?.value ||
              fields.find((field) => field.name === "类型")?.value ||
              entry.name,
            fields,
            skills: items.filter((item) => item.kind === "skill"),
            equipment: items.filter((item) => item.kind === "equipment"),
            innerSkills: items.filter((item) => item.kind === "innerSkill"),
          };
          for (const [key, label] of [
            ["skills", "技能"],
            ["equipment", "装备"],
            ["innerSkills", "内丹"],
          ] as const)
            if (
              !proof.sections[key] ||
              proof.counts[key] !== pet[key].length ||
              (proof.declared[key] !== null && proof.declared[key] !== pet[key].length)
            )
              issues.push(`召唤兽第${entry.index + 1}只${label}数量或空列表证据不足`);
          pets.push(pet);
        }
        snapshot.pets = pets;
        snapshot.petCount = petCount;
        snapshot.fields = [];
        snapshot.tables = [];
      }
      const subtabs = [...(current.controls?.subtabs || [])];
      for (const child of subtabs) {
        signal.throwIfAborted();
        current = await io.query(
          { kind: "detail-subtab", parent: name, name: child },
          { kind: "changed" },
          signal,
        );
        await capture(`${name} / ${child}`);
      }
      if (name === "坐骑")
        for (const entry of current.controls?.mounts || []) {
          current = await io.query(
            { kind: "detail-entry", section: "mount", ...entry },
            { kind: "changed" },
            signal,
          );
          await capture(`${name} / 第${entry.index + 1}只`);
        }
      for (const entry of current.controls?.children || []) {
        current = await io.query(
          { kind: "detail-entry", section: "child", ...entry },
          { kind: "changed" },
          signal,
        );
        await capture(`${name} / ${entry.name}`);
      }
    }
    const detail = assemble(),
      failures = captureIssues(detail, true, true, listing);
    if (failures.length)
      throw new IncompleteCaptureError(
        "角色资料未完整读取：" + failures.join("；"),
        detail,
        new Error(failures.join("；")),
      );
    return detail;
  } catch (error) {
    if (error instanceof IncompleteCaptureError) throw error;
    if (!tabs.length) throw error;
    throw new IncompleteCaptureError(
      `原生详情读取中断（${step}），已保留资料：${error instanceof Error ? error.message : String(error)}`,
      assemble(),
      error,
    );
  }
}
