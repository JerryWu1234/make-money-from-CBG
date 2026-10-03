import type { Page } from "playwright-core";
import { hoverForInspection } from "../viewport";
import type { Listing, RoleDetail, TabSnapshot } from "./types";
import { assertAvailable, checkAborted, pace } from "./page";
import { CAPTURE_VERSION, itemFromAttributes } from "./compact";
import { collectPets, petCaptureSummary } from "./pets";
import { captureValuation } from "./valuation-capture";

export const MAIN_TABS = [
  "人物/修炼",
  "技能",
  "道具/法宝",
  "召唤兽/孩子",
  "坐骑",
  "锦衣/外观",
  "玩家之家",
];

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
    return { name: tabName, text, fields, tables, elements: [], tooltips: [], items: [] };
  }, name);
}
async function inspectItems(
  page: Page,
  snapshot: TabSnapshot,
  signal: AbortSignal,
  report: (message: string) => void,
  issues?: string[],
) {
  const petItems = /^召唤兽 \d+$/.test(snapshot.name);
  const count = await page
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
        (el) => !el.closest('[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"]'),
      );
      icons.forEach((el, index) => el.setAttribute("data-cbg-inspect-index", String(index)));
      return icons.length;
    });
  for (let index = 0; index < count; index++) {
    checkAborted(signal);
    const icon = page.locator(`[data-cbg-inspect-index="${index}"]`);
    const attrs = await icon.evaluate((el) => {
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
          if (/^(data[-_]|alt$|title$)/.test(a.name) && !a.name.startsWith("data-cbg-"))
            attrs[a.name.replace(/^data-/, "data_")] = a.value;
        }
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
    });
    if (!attrs) continue;
    report(`正在读取 ${snapshot.name} 的物品属性 ${index + 1}/${count}`);
    // 名称、技能类别或装备属性已在元素里时直接读取，不触发无意义的提示框。
    let item = itemFromAttributes(attrs, index);
    if (attrs.data_equip_desc?.trim() || attrs.data_skill_type) {
      if (!item.name.startsWith("图标 ")) snapshot.items!.push(item);
      continue;
    }
    // 头像仅用于切换，不作为一件待估价装备。
    if (attrs.data_idx !== undefined && !attrs.data_equip_name) continue;
    await hoverForInspection(page, icon);
    await pace(signal, 300, 200);
    const tipId = attrs.data_tip_box;
    if (tipId)
      await page
        .waitForFunction(
          ({ id, name }) => {
            const box = document.getElementById(id);
            return (
              box?.checkVisibility() &&
              box.innerText.trim() &&
              (!name || box.innerText.includes(name))
            );
          },
          { id: tipId, name: attrs.data_equip_name || "" },
          { timeout: 4000 },
        )
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          issues?.push(`${snapshot.name}：${item.name} 的物品提示框未完整显示`);
        });
    const tooltip = await page.evaluate((id) => {
      const boxes = id
        ? [document.getElementById(id)]
        : Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .tips, .tooltip, #tips_box, #role_tips_box, .equip_tips',
            ),
          );
      return [
        ...new Set(
          boxes
            .filter((box) => box?.checkVisibility())
            .map((box) => box!.innerText.trim())
            .filter(Boolean),
        ),
      ].join("\n");
    }, tipId || "");
    if (tooltip) {
      item = itemFromAttributes({ ...attrs, data_equip_desc: tooltip }, index);
      if (item.name.startsWith("图标 ")) item.name = tooltip.split("\n")[0];
    }
    if (!item.description && !item.attributes && item.name.startsWith("图标 "))
      issues?.push(`${snapshot.name}：第 ${index + 1} 个物品图标没有读取到名称和属性`);
    if (item.description || item.attributes || !item.name.startsWith("图标 "))
      snapshot.items!.push(item);
  }
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
      if (
        item.kind !== "equipment" ||
        /法宝|灵宝|道具|材料|消耗品|召唤兽装备/.test(item.category || "")
      )
        continue;
      const stats = Object.entries(item.attributes || {}).some(
        ([name, value]) =>
          /^(?:命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|治疗能力|格挡|抵抗)(?:等级)?$/.test(
            name,
          ) && /\d/.test(value),
      );
      const describedStats =
        /(?:^|\n|\s)(?:命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|治疗能力|格挡|抵抗)(?:等级)?\s*[：:]?\s*[+＋−-]?\d/.test(
          item.description || "",
        );
      if (!describedStats && !stats) issues.push(`${tab.name}：${item.name} 的装备属性未完整读取`);
      const level =
        /^\d{1,3}$/.test(item.attributes?.等级 || "") ||
        /等级\s*[：:]?\s*\d{1,3}/.test(
          (item.description || "") + "\n" + (item.attributes?.装备条件 || ""),
        );
      if (!level) issues.push(`${tab.name}：${item.name} 的装备等级未完整读取`);
    }
  }
  const unique = [...new Set(issues)];
  return { version: 1, collectedAt, complete: unique.length === 0, issues: unique };
}
async function settled(page: Page, signal: AbortSignal) {
  await page.waitForLoadState("networkidle", { timeout: 15000 });
  await pace(signal, 600, 500);
  await assertAvailable(page);
}
async function openDetail(
  page: Page,
  item: Listing,
  signal: AbortSignal,
  report: (message: string) => void,
) {
  checkAborted(signal);
  report("正在打开商品详情页…");
  await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await assertAvailable(page);
  const first = page.getByText(MAIN_TABS[0], { exact: true }).filter({ visible: true }).first();
  await first.waitFor({ state: "visible", timeout: 20000 });
  for (const name of MAIN_TABS) {
    if (!(await page.getByText(name, { exact: true }).filter({ visible: true }).count()))
      throw new Error(`详情缺少「${name}」标签，未标记完整采集`);
  }
  await first.evaluate((el) => {
    let root = el.parentElement!;
    // 包含标签栏和实际属性面板的最小祖先；不采集顶部登录账号或整个 window。
    while (root.parentElement && root.innerText.trim().length < 160) root = root.parentElement;
    root.setAttribute("data-cbg-detail-root", "true");
  });
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
    await entries.nth(index).evaluate((el) => (el as HTMLElement).click());
    await pace(signal, 250, 150);
    tabs.push(await capture(page, `坐骑 / 第${index + 1}只`));
  }
  return tabs;
}

async function inspectEquipmentTabs(
  page: Page,
  snapshot: TabSnapshot,
  signal: AbortSignal,
  report: (message: string) => void,
  issues: string[],
) {
  const snapshots = [snapshot];
  await inspectItems(page, snapshot, signal, report, issues);
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
    await tab.evaluate((element) => (element as HTMLElement).click());
    await settled(page, signal);
    const child = await capture(page, `道具/法宝 / ${name}`);
    await inspectItems(page, child, signal, report, issues);
    child.itemsCollectedAt = new Date().toISOString();
    snapshots.push(child);
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
  await openDetail(page, item, signal, report);
  const valuation = await captureValuation(page);
  if (
    valuation.source.eid &&
    (valuation.source.eid !== item.eid || valuation.source.serverId !== item.serverId)
  )
    throw Object.assign(new Error("详情商品身份不一致，已停止补采"), {
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
    await page
      .getByText(name, { exact: true })
      .filter({ visible: true })
      .first()
      .evaluate((el) => (el as HTMLElement).click());
    await settled(page, signal);
    const snapshot = { ...(await capture(page, name)), collectedAt: now };
    if (name === "道具/法宝") {
      const snapshots = await inspectEquipmentTabs(page, snapshot, signal, report, equipmentIssues);
      tabs.push(...snapshots.slice(1).map((tab) => ({ ...tab, collectedAt: now })));
    }
    if (name === "召唤兽/孩子") petCapture = await inspectPets(page, snapshot, signal, report, now);
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
  return {
    ...previous,
    captureVersion: CAPTURE_VERSION,
    valuation,
    equipmentCapture: equipmentCaptureSummary(tabs, now, equipmentIssues),
    petCapture,
    tabs,
    collectedAt: now,
    raw: {},
  };
}

export async function collectDetail(
  page: Page,
  item: Listing,
  signal: AbortSignal,
  report: (message: string) => void = () => {},
): Promise<RoleDetail> {
  await openDetail(page, item, signal, report);
  const tabs: TabSnapshot[] = [];
  const equipmentIssues: string[] = [];
  let petCapture: RoleDetail["petCapture"];
  for (const name of MAIN_TABS) {
    checkAborted(signal);
    report(`正在读取标签 ${MAIN_TABS.indexOf(name) + 1}/${MAIN_TABS.length}：${name}`);
    const tab = page.getByText(name, { exact: true }).filter({ visible: true }).first();
    if (!(await tab.count())) throw new Error(`详情缺少「${name}」标签，未标记完整采集`);
    await pace(signal, 500, 600);
    await hoverForInspection(page, tab);
    // 仅操作已确认的详情标签，不点击购买、还价、收藏或站外链接。
    await tab.evaluate((el) => (el as HTMLElement).click());
    await settled(page, signal);
    const snapshot = await capture(page, name);
    tabs.push(snapshot);
    if (name === "道具/法宝") {
      const snapshots = await inspectEquipmentTabs(page, snapshot, signal, report, equipmentIssues);
      tabs.push(...snapshots.slice(1));
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
      await childTab.evaluate((el) => (el as HTMLElement).click());
      await settled(page, signal);
      const childSnapshot = await capture(page, `${name} / ${child}`);
      tabs.push(childSnapshot);
      await inspectItems(page, childSnapshot, signal, report);
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
      await entry.evaluate((el) => (el as HTMLElement).click());
      await settled(page, signal);
      const entryName = (await entry.innerText()).trim() || `第 ${index + 1} 项`;
      const entrySnapshot = await capture(page, `${name} / ${entryName}`);
      tabs.push(entrySnapshot);
      await inspectItems(page, entrySnapshot, signal, report);
    }
  }
  const raw = await page.evaluate(() => {
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
  return {
    captureVersion: CAPTURE_VERSION,
    valuation: await captureValuation(page),
    equipmentCapture: equipmentCaptureSummary(tabs, now, equipmentIssues),
    petCapture,
    url: item.url,
    collectedAt: now,
    tabs,
    raw,
  };
}
export function onShelfFromText(text: string): boolean {
  return text.match(/是否上架\s*[：:]?\s*(\S+)/)?.[1] === "已上架";
}
export async function isOnShelf(page: Page, item: Listing, signal: AbortSignal): Promise<boolean> {
  checkAborted(signal);
  await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await assertAvailable(page);
  checkAborted(signal);
  return onShelfFromText(await page.locator("body").innerText());
}
