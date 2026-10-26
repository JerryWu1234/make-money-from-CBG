import type { Page, Response } from "playwright-core";
import { clickForInspection, hoverForInspection } from "../viewport";
import { browserConnectionFailure, classifyBrowserFailure } from "../browser-connection";
import { ListingUnavailableError, type Listing, type RoleDetail, type TabSnapshot } from "./types";
import { assertAvailable, checkAborted, pace } from "./page";
import {
  CAPTURE_VERSION,
  equipmentEmptyProof,
  hasUnconfirmedEmptyEquipment,
  itemFromAttributes,
  preserveJewelryTooltipSections,
  observedEquipmentCategory,
  equipmentNameUnresolved,
  mergeWornEquipmentLevel,
  isNonRoleEquipment,
  type WornEquipmentSource,
} from "./compact";
import { collectPets, petCaptureSummary } from "./pets";
import { captureValuation } from "./valuation-capture";
import { roleIdentityIssues } from "./role-identity";
import { IncompleteCaptureError } from "./capture-readiness";
import { readDetailIdentity } from "./detail-identity";
import { captureBrowserStep } from "../browser-evidence";
import { accessNavigationFailure } from "./access-navigation";
import { DetailReadState, readDetailRevision, cachedModelsUnchanged } from "./detail-read-state";
import { completeSchoolSkillsFromText, schoolSkillsComplete } from "./school-skills";
import { readOfficialModels } from "./official-model-page";

export const MAIN_TABS = [
  "人物/修炼",
  "技能",
  "道具/法宝",
  "召唤兽/孩子",
  "坐骑",
  "锦衣/外观",
  "玩家之家",
];

function unidentifiedEquipmentLevel(text: string): number | null {
  if (!text.split("\n").some((line) => line.trim() === "未鉴定物品")) return null;
  const levels = [
    ...new Set(
      [...text.matchAll(/(?:^|\n)\s*等级\s*[：:]?\s*(\d{1,3})(?=\s*(?:\n|$))/g)].map((match) =>
        Number(match[1]),
      ),
    ),
  ];
  return levels.length === 1 ? levels[0] : null;
}

async function capture(page: Page, name: string): Promise<TabSnapshot> {
  return page.evaluate((tabName) => {
    const root = document.querySelector<HTMLElement>("[data-cbg-detail-root]");
    if (!root) throw new Error("未找到角色详情内容区域");
    const text = root.innerText.trim();
    const fields = text
      .split(/\n|\t(?=[^\t：:]{1,40}[：:])/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = line.match(/^([^：:]{1,40})[：:]\s*(.+)$/);
        return match ? [{ name: match[1].trim(), value: match[2].trim() }] : [];
      });
    const tables = Array.from(root.querySelectorAll("table"))
      .filter((el) => el.checkVisibility())
      .map((table) =>
        Array.from(table.rows).map((row) =>
          Array.from(row.cells).map((cell) => cell.innerText.trim()),
        ),
      );
    const equipmentScopes = ["RoleUsingEquips", "RoleStoreEquips", "RoleSplitEquips", "RoleYuHun"];
    const scopes = equipmentScopes.map((id) => root.querySelector<HTMLElement>("#" + id));
    const present = scopes.filter((scope): scope is HTMLElement => Boolean(scope));
    // The official show_equips renders these containers and removes empty worn-slot icons.
    const emptyEquipment =
      /^道具\/法宝(?:\s*\/|$)/.test(tabName) &&
      Boolean(scopes[0] && scopes[1]) &&
      present.every((scope) =>
        scope.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      ) &&
      present.every((scope) =>
        Array.from(scope.querySelectorAll("img, [data_equip_name], [data-equip-name]")).every(
          (element) =>
            /\/images\/time_lock_(?:\d+|protect|huoyue)\.png(?:[?#].*)?$/i.test(
              element.getAttribute("src") || "",
            ) ||
            // Observed official model 17320 is a task consumable, not role equipment.
            (element.getAttribute("data_equip_type") === "17320" &&
              element.getAttribute("data_equip_name") === "三界密令"),
        ),
      );
    return {
      name: tabName,
      text,
      fields,
      tables,
      elements: [],
      tooltips: [],
      items: [],
      ...(/^道具\/法宝(?:\s*\/|$)/.test(tabName)
        ? {
            equipmentContainers: equipmentScopes.map((id, index) => ({
              id,
              present: !!scopes[index],
              visible:
                scopes[index]?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
                false,
              icons: Array.from(
                scopes[index]?.querySelectorAll("img, [data_equip_name], [data-equip-name]") || [],
              )
                .filter(
                  (icon) =>
                    (icon.tagName === "IMG" || !icon.querySelector("img")) &&
                    !/\/images\/time_lock_(?:\d+|protect|huoyue)\.png(?:[?#].*)?$/i.test(
                      icon.getAttribute("src") || "",
                    ),
                )
                .map((icon) => {
                  // Match inspectItems: official equipment metadata may live on the a/td
                  // around its image. Otherwise a fully read pet item leaves an anonymous
                  // image in the inventory proof and falsely looks like unread role gear.
                  const ancestors: Element[] = [icon];
                  let parent = icon.parentElement;
                  for (
                    let depth = 0;
                    depth < 2 && parent && parent !== root;
                    depth++, parent = parent.parentElement
                  )
                    ancestors.unshift(parent);
                  let name = "",
                    modelId = "";
                  for (const element of ancestors) {
                    name =
                      element.getAttribute("data_equip_name") ||
                      element.getAttribute("data-equip-name") ||
                      name;
                    modelId =
                      element.getAttribute("data_equip_type") ||
                      element.getAttribute("data-equip-type") ||
                      modelId;
                  }
                  return { name, modelId };
                }),
            })),
          }
        : {}),
      ...(emptyEquipment ? { equipmentEmptyProof: "official-containers" as const } : {}),
    };
  }, name);
}
async function inspectItems(
  page: Page,
  snapshot: TabSnapshot,
  signal: AbortSignal,
  report: (message: string) => void,
  issues?: string[],
  worn?: { listing: Listing; source: WornEquipmentSource | null },
) {
  const petItems = /^召唤兽 \d+$/.test(snapshot.name);
  const inspection = await page
    .locator(
      petItems
        ? "[data-cbg-detail-root] img[data-cbg-pet-item]:visible"
        : "[data-cbg-detail-root] img:visible",
    )
    .evaluateAll((elements) => {
      document
        .querySelectorAll("[data-cbg-inspect-index]")
        .forEach((el) => el.removeAttribute("data-cbg-inspect-index"));
      const icons = elements.filter(
        (el) =>
          !el.closest('[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"]') &&
          // Official show_lock() adds these badges next to equipment/pet icons.
          !/\/images\/time_lock_(?:\d+|protect|huoyue)\.png(?:[?#].*)?$/i.test(
            el.getAttribute("src") || "",
          ),
      );
      const models: string[] = [];
      icons.forEach((el, index) => {
        el.setAttribute("data-cbg-inspect-index", String(index));
        let model = "";
        for (
          let node: Element | null = el, depth = 0;
          node && depth < 3 && !node.hasAttribute("data-cbg-detail-root");
          node = node.parentElement, depth++
        )
          model ||=
            node.getAttribute("data_equip_type") || node.getAttribute("data-equip-type") || "";
        if (model) models.push(model);
      });
      return { count: icons.length, models };
    });
  const metadata = await readOfficialModels(page, inspection.models);
  for (const issue of metadata.issues) report("物品元数据读取异常：" + JSON.stringify(issue));
  const count = inspection.count;
  for (let index = 0; index < count; index++) {
    checkAborted(signal);
    const icon = page.locator(`[data-cbg-inspect-index="${index}"]`);
    const observations = await icon.evaluateAll((elements) =>
      elements.map((el) => {
        if (el.closest('[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"]')) return null;
        const attrs: Record<string, string> = {};
        // 装备数据和提示框标识可能在图片的 a/td 父元素上。
        const ancestors: Element[] = [el];
        let parent = el.parentElement;
        for (
          let depth = 0;
          depth < 2 && parent && !parent.hasAttribute("data-cbg-detail-root");
          depth++, parent = parent.parentElement
        )
          ancestors.unshift(parent);
        for (const node of ancestors)
          for (const a of node.attributes) {
            if (node !== el && /^(?:data_kindid|data-kindid)$/.test(a.name)) continue;
            if (/^(data[-_]|alt$|title$)/.test(a.name) && !a.name.startsWith("data-cbg-"))
              attrs[a.name.replace(/^data-/, "data_")] = a.value;
          }
        // Exact model metadata from the official page is an observed name, not a guessed mapping.
        delete attrs.data_official_model_name;
        delete attrs.data_official_model_metadata;
        const container = el.closest("[data-equip-location], [data_equip_location], [id]");
        if (
          !attrs.data_equip_location &&
          container &&
          !container.hasAttribute("data-cbg-detail-root")
        )
          attrs.data_equip_location =
            container.getAttribute("data-equip-location") ||
            container.getAttribute("data_equip_location") ||
            container.id;
        if (attrs.data_skill_type && !attrs.data_equip_level) {
          for (const node of [...ancestors].reverse()) {
            const text = (node as HTMLElement).innerText || "";
            const level = text.length < 120 && text.match(/(?:^|\n)\s*(\d{1,3})\s*(?:\n|$)/)?.[1];
            if (level) {
              attrs.data_visible_level = level;
              break;
            }
          }
        }
        return attrs;
      }),
    );
    if (observations.length !== 1)
      throw Object.assign(new Error(`详情图标 ${index + 1}/${count} 已变化，未完整读取`), {
        name: "IncompleteDetailError",
      });
    let attrs = observations[0];
    if (!attrs) continue;
    const modelMetadata = metadata.models[attrs.data_equip_type];
    if (modelMetadata) attrs.data_official_model_metadata = modelMetadata;
    let rawLevel: string | undefined;
    if (worn) {
      const merged = mergeWornEquipmentLevel(attrs, worn.listing, worn.source);
      attrs = merged.attrs;
      rawLevel = merged.rawLevel;
      if (merged.issue) issues?.push(`${snapshot.name}：${merged.issue}`);
    }
    report(`正在读取 ${snapshot.name} 的物品属性 ${index + 1}/${count}`);
    // 名称、技能类别或装备属性已在元素里时直接读取，不触发无意义的提示框。
    let item = itemFromAttributes(attrs, index);
    // 已明确不在人物装备计价范围内的物品不要求普通装备属性。
    const dedicatedNonRoleSlot =
      item.categorySource === "official-slot" && /^(?:法宝|灵宝|神器)$/.test(item.category || "");
    if (
      !petItems &&
      isNonRoleEquipment(item) &&
      (dedicatedNonRoleSlot ||
        (!equipmentNameUnresolved(item.name) && (item.description || item.attributes)))
    ) {
      snapshot.items!.push(item);
      continue;
    }
    const rawYupo =
      item.category === "上古玉魄" &&
      /^\s*\{\s*"minghun"\s*:\s*\{|<json>/i.test(attrs.data_equip_desc || "");
    const incompletePetEquipment =
      petItems &&
      item.kind === "equipment" &&
      item.location !== "RolePetShipin" &&
      !/(?:命中(?:率)?|伤害|防御|气血|魔法|速度|敏捷|力量|体质|耐力|灵力|魔力|镶嵌)\s*[：:]?\s*[+＋−-]?\d/.test(
        (item.description || "") +
          "\n" +
          Object.entries(item.attributes || {})
            .map(([key, value]) => key + " " + value)
            .join("\n"),
      );
    const incompleteEquipment =
      incompletePetEquipment ||
      (item.kind === "equipment" &&
        !isNonRoleEquipment(item) &&
        /^道具\/法宝(?:\s*\/|$)/.test(snapshot.name) &&
        !equipmentCaptureSummary([{ ...snapshot, items: [item] }], snapshot.collectedAt || "")
          .complete);
    // 官网元素可能只有等级；缺属性时仍须悬停，不能把非空描述当作已读完整。
    if (
      (attrs.data_equip_desc?.trim() &&
        !rawYupo &&
        !incompleteEquipment &&
        !item.name.startsWith("图标 ")) ||
      attrs.data_skill_type
    ) {
      if (!item.name.startsWith("图标 ")) snapshot.items!.push(item);
      continue;
    }
    // 头像仅用于切换，不作为一件待估价装备。
    if (
      attrs.data_idx !== undefined &&
      !attrs.data_equip_name &&
      !attrs.data_tip_box &&
      !attrs.data_equip_desc
    )
      continue;
    await hoverForInspection(page, icon);
    await pace(signal, 300, 200);
    const tipId = attrs.data_tip_box;
    const levelText =
      item.attributes?.等级 || item.description?.match(/(?:^|\n)\s*等级\s*[：:]?\s*(\d{1,3})/)?.[1];
    const expectedLevel = levelText && /^\d{1,3}$/.test(levelText) ? Number(levelText) : null;
    if (tipId || incompleteEquipment)
      await page
        .waitForFunction(
          ({ id, name, requireStats, expectedLevel }) => {
            const boxes = id
              ? [document.getElementById(id)]
              : Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .tips, .tooltip, #tips_box, #role_tips_box, .equip_tips',
                  ),
                );
            return boxes.some((box) => {
              const text = box?.innerText.trim() || "";
              const levels = [
                ...new Set(
                  [...text.matchAll(/(?:^|\n)\s*等级\s*[：:]?\s*(\d{1,3})(?=\s*(?:\n|$))/g)].map(
                    (match) => Number(match[1]),
                  ),
                ),
              ];
              const unidentified =
                !!name &&
                text.split("\n")[0].trim() === name &&
                text.split("\n").some((line) => line.trim() === "未鉴定物品") &&
                levels.length === 1 &&
                (expectedLevel === null || levels[0] === expectedLevel);
              return (
                box?.checkVisibility() &&
                text &&
                (!name || text.includes(name)) &&
                (!requireStats ||
                  unidentified ||
                  /(?:命中(?:率)?|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|抗物理暴击|抗法术暴击|抗固伤|固伤暴击|穿刺|狂暴|治疗能力|格挡|抵抗|抗封印)(?:等级|值)?\s*[：:]?\s*[+＋−-]?\d/.test(
                    text,
                  ))
              );
            });
          },
          {
            id: tipId || "",
            name: equipmentNameUnresolved(item.name) ? "" : item.name.trim(),
            requireStats: incompleteEquipment,
            expectedLevel,
          },
          { timeout: 4000 },
        )
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          issues?.push(`${snapshot.name}：${item.name} 的物品提示框未完整显示`);
        });
    const observedTip = await page.evaluate(
      ({ id, name }) => {
        const boxes = id
          ? [document.getElementById(id)]
          : Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .tips, .tooltip, #tips_box, #role_tips_box, .equip_tips',
              ),
            );
        const candidates = boxes.filter(
          (box): box is HTMLElement =>
            !!box?.checkVisibility() &&
            !!box.innerText.trim() &&
            (!!id || !name || box.innerText.includes(name)),
        );
        const texts = [...new Set(candidates.map((box) => box.innerText.trim()).filter(Boolean))];
        // A missing tip ID cannot justify concatenating unrelated visible tooltips.
        if (texts.length !== 1) return { text: "", names: [] as string[] };
        const names = candidates.flatMap((box) =>
          Array.from(
            box.querySelectorAll(
              "[data_equip_name], [data-equip-name], h1, h2, h3, h4, [role=heading]",
            ),
          ).map(
            (node) =>
              node.getAttribute("data_equip_name") ||
              node.getAttribute("data-equip-name") ||
              node.textContent?.trim() ||
              "",
          ),
        );
        return { text: texts[0], names: [...new Set(names)] };
      },
      { id: tipId || "", name: equipmentNameUnresolved(item.name) ? "" : item.name.trim() },
    );
    const tooltip = observedTip.text;
    if (tooltip) {
      if (
        rawLevel !== undefined &&
        [...tooltip.matchAll(/(?:^|\n)\s*等级\s*[：:]?\s*(\d{1,3})(?=\s|$)/g)].some(
          (match) => Number(match[1]) !== Number(rawLevel),
        )
      )
        issues?.push(`${snapshot.name}：原始穿戴装备等级与提示框等级不一致`);
      if (tooltip.split("\n").some((line) => line.trim() === "未鉴定物品")) {
        const level = unidentifiedEquipmentLevel(tooltip);
        if (
          tooltip.split("\n")[0].trim() !== attrs.data_equip_name ||
          level === null ||
          (expectedLevel !== null && level !== expectedLevel)
        )
          issues?.push(`${snapshot.name}：${item.name} 的未鉴定提示框名称或等级与物品不一致`);
      }
      item = itemFromAttributes(
        {
          ...attrs,
          data_equip_desc: preserveJewelryTooltipSections(tooltip, item.description || ""),
        },
        index,
      );
      if (equipmentNameUnresolved(item.name)) {
        const names = [
          ...new Set(observedTip.names.filter((name) => !equipmentNameUnresolved(name))),
        ];
        if (!names.length && !equipmentNameUnresolved(tooltip.split("\n")[0]))
          names.push(tooltip.split("\n")[0].trim());
        if (names.length === 1) {
          item.name = names[0];
          item.nameSource = "tooltip";
          item.tooltip = tooltip;
        }
      }
    }
    if (!item.description && !item.attributes && item.name.startsWith("图标 "))
      issues?.push(`${snapshot.name}：第 ${index + 1} 个物品图标没有读取到名称和属性`);
    if (item.description || item.attributes || !item.name.startsWith("图标 "))
      snapshot.items!.push(item);
  }
  await captureBrowserStep(
    page,
    { flow: "collection", stage: `物品读取完成-${snapshot.name}` },
    signal,
  );
}

async function inspectPets(
  page: Page,
  snapshot: TabSnapshot,
  signal: AbortSignal,
  report: (message: string) => void,
  collectedAt: string,
) {
  const readIssues: string[] = [];
  const result = await collectPets(
    page,
    signal,
    (name) => capture(page, name),
    (pet) => inspectItems(page, pet, signal, report, readIssues),
    () => settled(page, signal),
    report,
  );
  snapshot.pets = result.pets;
  if (result.count !== null) snapshot.petCount = result.count;
  snapshot.itemsCollectedAt = collectedAt;
  // 每只详情保存在 pets，概览不重复保留默认宝宝的属性。
  const info = snapshot.text.lastIndexOf("详细信息");
  if (info >= 0) snapshot.text = snapshot.text.slice(0, info).trim();
  snapshot.fields = [];
  snapshot.tables = [];
  return petCaptureSummary(result.count, result.pets, collectedAt, [
    ...result.issues,
    ...readIssues,
  ]);
}

export function equipmentCaptureSummary(
  tabs: TabSnapshot[],
  collectedAt: string,
  readIssues: string[] = [],
): NonNullable<RoleDetail["equipmentCapture"]> {
  const issues = [...readIssues];
  const equipmentTabs = tabs.filter((tab) => /^道具\/法宝(?:\s*\/|$)/.test(tab.name));
  if (!equipmentTabs.length) issues.push("没有读取到道具/法宝页");
  for (const tab of equipmentTabs) {
    if (!tab.items?.length && !/现金|存银|道具和法宝|暂无道具|没有装备|无装备/.test(tab.text))
      issues.push(`${tab.name}：物品内容未完整读取，无法确认装备是否为空`);
    for (const item of tab.items || []) {
      const category = observedEquipmentCategory(item.category, item.location, item.modelId);
      if (item.kind !== "equipment" || isNonRoleEquipment(item)) continue;
      if (equipmentNameUnresolved(item.name))
        issues.push(`${tab.name}：型号 ${item.modelId || "未知"} 的装备名称未完整读取`);
      if (
        category === "上古玉魄" &&
        /^\s*\{\s*"minghun"\s*:\s*\{|<json>/i.test(item.description || "")
      ) {
        issues.push(`${tab.name}：${item.name} 的玉魄属性仍为原始JSON，未读取官网展示说明`);
        continue;
      }
      const stats = Object.entries(item.attributes || {}).some(
        ([name, value]) =>
          /^(?:命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|抗物理暴击|抗法术暴击|抗固伤|固伤暴击|穿刺|狂暴|治疗能力|格挡|抵抗)(?:等级|值)?$/.test(
            name,
          ) && /\d/.test(value),
      );
      const describedStats =
        /(?:^|\n|\s)(?:命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|抗物理暴击|抗法术暴击|抗固伤|固伤暴击|穿刺|狂暴|治疗能力|格挡|抵抗)(?:等级|值)?\s*[：:]?\s*[+＋−-]?\d/.test(
          item.description || "",
        );
      const unidentifiedLevel = unidentifiedEquipmentLevel(item.description || "");
      const completeUnidentified =
        unidentifiedLevel !== null &&
        (item.attributes?.等级 === undefined || Number(item.attributes.等级) === unidentifiedLevel);
      if (!describedStats && !stats && !completeUnidentified)
        issues.push(`${tab.name}：${item.name} 的装备属性未完整读取`);
      const level =
        /^\d{1,3}$/.test(item.attributes?.等级 || "") ||
        /(?:^|[\n\s【：:])等级\s*[：:]?\s*\d{1,3}/.test(
          (item.description || "") + "\n" + (item.attributes?.装备条件 || ""),
        );
      if (!level && category !== "上古玉魄")
        issues.push(`${tab.name}：${item.name} 的装备等级未完整读取`);
    }
  }
  const emptyProof = equipmentEmptyProof(equipmentTabs);
  if (hasUnconfirmedEmptyEquipment({ tabs, raw: {}, url: "", collectedAt }))
    issues.push("人物装备库存是否为空尚未核对，需确认穿戴与随身装备区域后再计价");
  const unique = [...new Set(issues)];
  return {
    version: 1,
    collectedAt,
    complete: unique.length === 0,
    issues: unique,
    ...(emptyProof ? { emptyProof } : {}),
  };
}
async function settled(page: Page, signal: AbortSignal) {
  await page.waitForLoadState("networkidle", { timeout: 15000 });
  await pace(signal, 600, 500);
  await assertAvailable(page);
}
async function assertDetailExists(page: Page, item: Listing, response: Response | null) {
  // Access restrictions always take precedence over a missing-product response.
  await assertAvailable(page);
  const observed = await page.evaluate(() => {
    const visible = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some((el) => el.checkVisibility());
    const globals = window as Window & {
      IsLogin?: number | boolean;
      LoginInfo?: { login?: number | boolean };
    };
    const login =
      globals.IsLogin === false ||
      globals.LoginInfo?.login === false ||
      /\/(?:show_login|login)(?:\.py)?(?:\/|$)/.test(location.pathname) ||
      visible("#qrcode,#loginContainer,input[type=password]");
    // A sale/off-shelf page may still contain readable detail; it is not deletion evidence.
    const inactive =
      /商品已下架|商品已售出|(?:状态|是否上架)\s*[：:]?\s*(?:已下架|未上架|已售出)/.test(
        document.body.innerText,
      );
    const excluded =
      "aside,nav,footer,#search_result,#bottomRecommands,#recommd_list,#recommend,.recommend,.recommd,.recommandWrp,.goodsRemmds,[data-cbg-hover-tip],[id$=TipsBox],[role=tooltip]";
    // Only a standalone main error message is evidence; recommendations and unrelated prose do not count.
    const explicit = Array.from(
      document.querySelectorAll<HTMLElement>(
        "main,[role=alert],#error_msg,.error_msg,#error_box,.error_box,body",
      ),
    ).some((el) => {
      if (!el.checkVisibility() || el.closest(excluded)) return false;
      if (
        el !== document.body &&
        !el.closest("main") &&
        el.innerText.replace(/\s/g, "") !== document.body.innerText.replace(/\s/g, "")
      )
        return false;
      if (
        el === document.body &&
        Array.from(el.querySelectorAll(excluded)).some(
          (node) => node.checkVisibility() && node.textContent?.trim(),
        )
      )
        return false;
      const text = el.innerText
        .replace(/\s/g, "")
        .replace(/(?:返回上一页|返回首页|返回商品列表)+$/, "");
      return /^(?:很抱歉[，,！!]?|对不起[，,！!]?|抱歉[，,！!]?)?(?:(?:您(?:所)?(?:查看|查询|访问)的|该|此)(?:件)?)?(?:商品|物品|角色)(?:不存在|(?:已|已经)(?:不存在|被删除|删除)|被删除)(?:[，,](?:可能)?(?:已|已经)?被删除)?[。.!！]?$/.test(
        text,
      );
    });
    return { login, inactive, explicit };
  });
  if (observed.login) throw new Error("网站登录已失效，已暂停采集");
  const sameProduct = (address: string) => {
    try {
      const url = new URL(address);
      return (
        url.origin === "https://xyq.cbg.163.com" &&
        url.pathname === "/equip" &&
        url.searchParams.get("s") === item.serverId &&
        url.searchParams.get("eid") === item.eid
      );
    } catch {
      return false;
    }
  };
  if (!sameProduct(page.url()) || !response || !sameProduct(response.url()) || observed.inactive)
    return;
  if (await page.getByText(MAIN_TABS[0], { exact: true }).filter({ visible: true }).count()) return;
  const status = response.status();
  if (status === 404 || status === 410)
    throw new ListingUnavailableError(`目标详情返回 HTTP ${status}`);
  if (status >= 200 && status < 300 && observed.explicit)
    throw new ListingUnavailableError("目标详情主错误区明确显示商品不存在或已删除");
}

async function openDetail(
  page: Page,
  item: Listing,
  signal: AbortSignal,
  report: (message: string) => void,
) {
  try {
    checkAborted(signal);
    report("正在打开商品详情页…");
    const response = await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await captureBrowserStep(
      page,
      { flow: "collection", stage: "角色详情打开", key: item.key },
      signal,
    );
    await assertDetailExists(page, item, response);
    const first = page.getByText(MAIN_TABS[0], { exact: true }).filter({ visible: true }).first();
    await first.waitFor({ state: "visible", timeout: 20000 });
    for (const name of MAIN_TABS) {
      if (!(await page.getByText(name, { exact: true }).filter({ visible: true }).count()))
        throw new Error(`详情缺少「${name}」标签，未标记完整采集`);
    }
    const rooted = await first.evaluateAll((elements) => {
      if (elements.length !== 1) return false;
      const el = elements[0];
      let root = el.parentElement!;
      // 包含标签栏和实际属性面板的最小祖先；不采集顶部登录账号或整个 window。
      while (root.parentElement && root.innerText.trim().length < 160) root = root.parentElement;
      root.setAttribute("data-cbg-detail-root", "true");
      return true;
    });
    if (!rooted)
      throw Object.assign(new Error("详情标签已变化，无法确认读取范围"), {
        name: "IncompleteDetailError",
      });
  } catch (error) {
    const failure = (await accessNavigationFailure(page, error, signal)) || error;
    await captureBrowserStep(
      page,
      { flow: "collection", stage: "角色详情打开失败", key: item.key, error: failure },
      signal,
    );
    throw failure;
  }
}

async function captureMountEntries(
  page: Page,
  signal: AbortSignal,
  report: (message: string) => void,
) {
  const tabs: TabSnapshot[] = [];
  const entries = page.locator("#RoleRiders img[data_idx]:visible");
  for (let index = 0; index < (await entries.count()); index++) {
    checkAborted(signal);
    report(`正在读取第 ${index + 1} 只坐骑…`);
    await clickForInspection(entries.nth(index));
    await pace(signal, 250, 150);
    tabs.push(await capture(page, `坐骑 / 第${index + 1}只`));
    await captureBrowserStep(
      page,
      { flow: "collection", stage: `坐骑读取完成-${index + 1}` },
      signal,
    );
  }
  return tabs;
}

async function inspectEquipmentTabs(
  page: Page,
  snapshot: TabSnapshot,
  signal: AbortSignal,
  report: (message: string) => void,
  issues: string[],
  item: Listing,
) {
  const snapshots = [snapshot];
  const identity = await readDetailIdentity(page);
  const source =
    !identity.issues.length && identity.serverId === item.serverId && identity.eid === item.eid
      ? await page.evaluate(
          ({ serverId, eid }): WornEquipmentSource | null => {
            try {
              const globals = window as unknown as Record<string, unknown>;
              const decode = globals.decode_desc;
              const Parser = globals.RoleInfoParser as new (
                text: string,
                options: Record<string, unknown>,
              ) => { raw_info: Record<string, unknown> };
              const encoded =
                document.querySelector<HTMLTextAreaElement>("#equip_desc_value")?.value;
              if (typeof decode !== "function" || typeof Parser !== "function" || !encoded)
                return null;
              const raw = new Parser(decode(encoded), { resUrl: globals.ResUrl, serverId })
                .raw_info;
              if (
                !raw ||
                !raw.AllEquip ||
                typeof raw.AllEquip !== "object" ||
                Array.isArray(raw.AllEquip)
              )
                return null;
              const allEquip: Record<string, unknown> = {};
              for (const slot of ["1", "2", "3", "4", "5", "6"]) {
                if (!Object.hasOwn(raw.AllEquip, slot)) continue;
                const equipment = (raw.AllEquip as Record<string, unknown>)[slot];
                if (!equipment || typeof equipment !== "object" || Array.isArray(equipment))
                  continue;
                const fields = equipment as Record<string, unknown>;
                allEquip[slot] = {
                  iType: fields.iType,
                  cDesc: fields.cDesc,
                  ...(Object.hasOwn(fields, "obj_level") ? { obj_level: fields.obj_level } : {}),
                };
              }
              return { serverId, eid, allEquip };
            } catch {
              // 可选原档解析失败时不补字段；连接、导航等 evaluate 外部错误仍正常抛出。
              return null;
            }
          },
          { serverId: item.serverId, eid: item.eid },
        )
      : null;
  const after = source ? await readDetailIdentity(page) : null;
  const worn = {
    listing: item,
    source:
      after && !after.issues.length && after.serverId === item.serverId && after.eid === item.eid
        ? source
        : null,
  };
  await inspectItems(page, snapshot, signal, report, issues, worn);
  snapshot.itemsCollectedAt = new Date().toISOString();
  const nested = page.locator(
    '[data-cbg-detail-root] [role="tab"], [data-cbg-detail-root] [data-tab], [data-cbg-detail-root] .tab a, [data-cbg-detail-root] .tabs a',
  );
  const names = await nested.evaluateAll((elements) =>
    elements
      .filter((element) => element.checkVisibility())
      .map((element) => element.textContent?.trim() || "")
      .filter(Boolean),
  );
  for (const name of [...new Set(names)].filter((name) => !MAIN_TABS.includes(name))) {
    checkAborted(signal);
    const tab = nested.filter({ hasText: name }).filter({ visible: true }).first();
    if ((await tab.innerText()).trim() !== name) continue;
    const href = await tab.getAttribute("href");
    if (href && /^https?:|^\//.test(href)) continue;
    report(`正在读取道具/法宝 / ${name}`);
    await hoverForInspection(page, tab);
    await clickForInspection(tab);
    await settled(page, signal);
    const child = await capture(page, `道具/法宝 / ${name}`);
    await inspectItems(page, child, signal, report, issues, worn);
    child.itemsCollectedAt = new Date().toISOString();
    snapshots.push(child);
    await captureBrowserStep(
      page,
      { flow: "collection", stage: `装备子页读取完成-${name}`, key: item.key },
      signal,
    );
  }
  return snapshots;
}

/** Refresh pricing, equipment and pets; retain unrelated skill snapshots. */
export async function collectValuationDetail(
  page: Page,
  item: Listing,
  previous: RoleDetail,
  signal: AbortSignal,
  report: (message: string) => void = () => {},
) {
  try {
    await openDetail(page, item, signal, report);
    const valuation = await captureValuation(page);
    const identityIssues = roleIdentityIssues(valuation.source, item);
    if (identityIssues.length)
      throw Object.assign(new Error("详情商品身份未核验：" + identityIssues.join("；")), {
        name: "IncompleteDetailError",
      });
    const now = new Date().toISOString();
    const equipmentIssues: string[] = [];
    let petCapture: RoleDetail["petCapture"];
    const tabs = previous.tabs
      .filter(
        (tab) =>
          !/^(?:坐骑|道具\/法宝)\s*\//.test(tab.name) && !/^召唤兽\/孩子(?:\s*\/|$)/.test(tab.name),
      )
      .map((tab) => ({ ...tab, collectedAt: tab.collectedAt || previous.collectedAt }));
    for (const name of ["人物/修炼", "道具/法宝", "召唤兽/孩子", "坐骑"]) {
      checkAborted(signal);
      report("正在补采估值资料：" + name);
      await clickForInspection(
        page.getByText(name, { exact: true }).filter({ visible: true }).first(),
      );
      await settled(page, signal);
      await captureBrowserStep(
        page,
        { flow: "collection", stage: `补采标签切换-${name}`, key: item.key },
        signal,
      );
      const snapshot = { ...(await capture(page, name)), collectedAt: now };
      if (name === "道具/法宝") {
        const snapshots = await inspectEquipmentTabs(
          page,
          snapshot,
          signal,
          report,
          equipmentIssues,
          item,
        );
        tabs.push(...snapshots.slice(1).map((tab) => ({ ...tab, collectedAt: now })));
      }
      if (name === "召唤兽/孩子")
        petCapture = await inspectPets(page, snapshot, signal, report, now);
      const index = tabs.findIndex((tab) => tab.name === name);
      if (index >= 0 && name !== "道具/法宝")
        tabs[index] = {
          ...snapshot,
          items: tabs[index].items,
          itemsCollectedAt:
            tabs[index].itemsCollectedAt || tabs[index].collectedAt || previous.collectedAt,
        };
      else if (index >= 0) tabs[index] = snapshot;
      else tabs.push(snapshot);
      if (name === "坐骑")
        tabs.push(
          ...(await captureMountEntries(page, signal, report)).map((tab) => ({
            ...tab,
            collectedAt: now,
          })),
        );
    }
    await captureBrowserStep(
      page,
      { flow: "collection", stage: "补采资料读取完成", key: item.key },
      signal,
    );
    return {
      ...previous,
      captureMode: "all" as const,
      captureVersion: CAPTURE_VERSION,
      valuation,
      equipmentCapture: equipmentCaptureSummary(tabs, now, equipmentIssues),
      petCapture,
      tabs,
      collectedAt: now,
      raw: {},
    };
  } catch (error) {
    await captureBrowserStep(
      page,
      { flow: "collection", stage: "补采资料读取失败", key: item.key, error },
      signal,
    );
    throw error;
  }
}

export async function collectDetail(
  page: Page,
  item: Listing,
  signal: AbortSignal,
  report: (message: string) => void = () => {},
  readState = new DetailReadState(),
): Promise<RoleDetail> {
  await openDetail(page, item, signal, report);
  const tabs: TabSnapshot[] = [];
  const equipmentIssues: string[] = [];
  let petCapture: RoleDetail["petCapture"];
  let step = "详情";
  let raw: RoleDetail["raw"] = {};
  const reusedTabs: TabSnapshot[] = [];
  try {
    const revision = await readDetailRevision(page, item);
    readState.begin(revision);
    for (const name of MAIN_TABS) {
      step = name;
      checkAborted(signal);
      const saved = readState.get(name);
      if (saved && (await cachedModelsUnchanged(page, saved.tabs))) {
        tabs.push(...saved.tabs);
        reusedTabs.push(...saved.tabs);
        if (saved.petCapture) petCapture = saved.petCapture;
        report(`已核对商品原文未变，复用本轮完整标签：${name}`);
        continue;
      }
      const start = tabs.length;
      report(`正在读取标签 ${MAIN_TABS.indexOf(name) + 1}/${MAIN_TABS.length}：${name}`);
      const tab = page.getByText(name, { exact: true }).filter({ visible: true }).first();
      if (!(await tab.count())) throw new Error(`详情缺少「${name}」标签，未标记完整采集`);
      await pace(signal, 500, 600);
      await hoverForInspection(page, tab);
      // 仅操作已确认的详情标签，不点击购买、还价、收藏或站外链接。
      await clickForInspection(tab);
      await settled(page, signal);
      await captureBrowserStep(
        page,
        { flow: "collection", stage: `标签切换-${name}`, key: item.key },
        signal,
      );
      const snapshot = await capture(page, name);
      tabs.push(snapshot);
      if (name === "道具/法宝") {
        const snapshots = await inspectEquipmentTabs(
          page,
          snapshot,
          signal,
          report,
          equipmentIssues,
          item,
        );
        tabs.push(...snapshots.slice(1));
        await captureBrowserStep(
          page,
          { flow: "collection", stage: `标签读取完成-${name}`, key: item.key },
          signal,
        );
        if (equipmentCaptureSummary(snapshots, new Date().toISOString(), equipmentIssues).complete)
          readState.save(name, snapshots);
        continue;
      }
      if (name === "召唤兽/孩子") {
        petCapture = await inspectPets(page, snapshot, signal, report, new Date().toISOString());
      } else {
        if (name === "坐骑") tabs.push(...(await captureMountEntries(page, signal, report)));
        await inspectItems(page, snapshot, signal, report);
      }
      const nested = page.locator(
        '[data-cbg-detail-root] [role="tab"], [data-cbg-detail-root] [data-tab], [data-cbg-detail-root] .tab a, [data-cbg-detail-root] .tabs a',
      );
      const names = await nested.evaluateAll((els) =>
        els
          .filter((el) => el.checkVisibility())
          .map((el) => el.textContent?.trim() || "")
          .filter(Boolean),
      );
      for (const child of [...new Set(names)].filter((value) => !MAIN_TABS.includes(value))) {
        checkAborted(signal);
        report(`正在读取 ${name} / ${child}`);
        const childTab = nested.filter({ hasText: child }).filter({ visible: true }).first();
        const exact = (await childTab.innerText()).trim();
        if (exact !== child) continue;
        const href = await childTab.getAttribute("href");
        if (href && /^https?:|^\//.test(href)) continue;
        await hoverForInspection(page, childTab);
        await clickForInspection(childTab);
        await settled(page, signal);
        const childSnapshot = await capture(page, `${name} / ${child}`);
        tabs.push(childSnapshot);
        await inspectItems(page, childSnapshot, signal, report);
        await captureBrowserStep(
          page,
          { flow: "collection", stage: `子页读取完成-${name}-${child}`, key: item.key },
          signal,
        );
      }
      const entries = page.locator(
        "[data-cbg-detail-root] [data-child-id]:visible, [data-cbg-detail-root] .child_list li:visible",
      );
      const entryCount = await entries.count();
      for (let index = 0; index < entryCount; index++) {
        checkAborted(signal);
        report(`正在读取 ${name} 的第 ${index + 1}/${entryCount} 个条目及装备`);
        const entry = entries.nth(index);
        const href = await entry.getAttribute("href");
        if (href && /^https?:|^\//.test(href)) continue;
        await hoverForInspection(page, entry);
        await clickForInspection(entry);
        await settled(page, signal);
        const entryName = (await entry.innerText()).trim() || `第 ${index + 1} 项`;
        const entrySnapshot = await capture(page, `${name} / ${entryName}`);
        tabs.push(entrySnapshot);
        await inspectItems(page, entrySnapshot, signal, report);
        await captureBrowserStep(
          page,
          { flow: "collection", stage: `条目读取完成-${name}-${index + 1}`, key: item.key },
          signal,
        );
      }
      const group = tabs.slice(start).map(completeSchoolSkillsFromText);
      if (
        (name !== "技能" || schoolSkillsComplete(group)) &&
        (name !== "召唤兽/孩子" || petCapture?.complete)
      )
        readState.save(name, group, name === "召唤兽/孩子" ? petCapture : undefined);
    }
    await captureBrowserStep(
      page,
      { flow: "collection", stage: "全部标签读取完成", key: item.key },
      signal,
    );
    step = "商品原始资料";
    raw = await page.evaluate(() => {
      const globals = window as unknown as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      const encoded = document.querySelector<HTMLTextAreaElement>("#equip_desc_value")?.value;
      if (encoded) result.encodedRoleData = encoded;
      // 只保存商品详情的数据，不读取 Cookie、登录信息或其他页面的账户。
      for (const key of [
        "EquipInfo",
        "RoleInfo",
        "RoleData",
        "role_info",
        "role_data",
        "equip_info",
      ]) {
        const value = globals[key];
        if (value && typeof value === "object") {
          try {
            result[key] = JSON.parse(JSON.stringify(value));
          } catch {
            throw new Error(`商品原始数据 ${key} 无法完整序列化`);
          }
        }
      }
      return result;
    });
    checkAborted(signal);
    report("全部标签读取完成，正在保存详情…");
    const now = new Date().toISOString();
    step = "角色本体核验";
    const valuation = await captureValuation(page);
    if (
      revision &&
      (revision !== (await readDetailRevision(page, item)) ||
        !(await cachedModelsUnchanged(page, reusedTabs)))
    ) {
      readState.invalidate();
      throw Object.assign(
        new Error("详情读取期间商品原文或身份变化，已取消本轮标签复用，需重新核验"),
        { name: "IncompleteDetailError" },
      );
    }
    valuation.issues = [
      ...new Set([...valuation.issues, ...roleIdentityIssues(valuation.source, item)]),
    ];
    return {
      captureMode: "all" as const,
      captureVersion: CAPTURE_VERSION,
      valuation,
      equipmentCapture: equipmentCaptureSummary(tabs, now, equipmentIssues),
      petCapture,
      url: item.url,
      collectedAt: now,
      tabs,
      raw,
    };
  } catch (error) {
    const access = signal.aborted ? undefined : await accessNavigationFailure(page, error, signal);
    await captureBrowserStep(
      page,
      { flow: "collection", stage: `详情读取失败-${step}`, key: item.key, error: access || error },
      signal,
    );
    const cause = signal.aborted
      ? signal.reason
      : access || classifyBrowserFailure(page, error, signal);
    // 超时或已确认访问暂停带出部分资料；未知异常保留原错误。
    if (
      !tabs.length ||
      (!signal.aborted &&
        !access &&
        !browserConnectionFailure(cause) &&
        (!(error instanceof Error) ||
          !["TimeoutError", "IncompleteDetailError"].includes(error.name) ||
          /登录|验证码|安全验证|频繁|繁忙|权限|禁止/i.test(error.message)))
    )
      throw cause;
    const now = new Date().toISOString();
    throw new IncompleteCaptureError(
      `详情读取中断（${step}）：${cause instanceof Error ? cause.message : String(cause)}`,
      {
        captureMode: "all",
        captureVersion: CAPTURE_VERSION,
        url: item.url,
        collectedAt: now,
        tabs,
        raw,
        equipmentCapture: equipmentCaptureSummary(tabs, now, equipmentIssues),
        petCapture,
        // 未执行完本轮读取，不能附上完整本体核验凭据或借用上一轮资料。
      },
      cause,
    );
  }
}
export function onShelfFromText(text: string): boolean {
  // The current official item header says “状态：上架中”; older pages say “是否上架：已上架”.
  // Only the main product's labelled state counts, never an unrelated “上架中” in a recommendation.
  const state = text.match(/(?:是否上架|(?:^|\n)\s*状态)\s*[：:]?\s*(\S+)/)?.[1];
  return state === "已上架" || state === "上架中";
}
export async function isOnShelf(page: Page, item: Listing, signal: AbortSignal): Promise<boolean> {
  checkAborted(signal);
  const response = await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await assertDetailExists(page, item, response);
  checkAborted(signal);
  return onShelfFromText(await page.evaluate(() => document.body.innerText));
}
