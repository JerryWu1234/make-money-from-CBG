import type { Page } from "playwright-core";
import { hoverForInspection } from "../viewport";
import type { Listing, RoleDetail, TabSnapshot } from "./types";
import { assertAvailable, checkAborted, pace } from "./page";
import { CAPTURE_VERSION, coreEquipmentDescription, itemFromAttributes } from "./compact";
import { collectPets } from "./pets";

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
) {
  const count = await page.locator("[data-cbg-detail-root] img:visible").evaluateAll((elements) => {
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
    const item = itemFromAttributes(attrs, index);
    if (attrs.data_equip_desc !== undefined || attrs.data_skill_type) {
      if (!item.name.startsWith("图标 ")) snapshot.items!.push(item);
      continue;
    }
    // 头像仅用于切换，不作为一件待估价装备。
    if (attrs.data_idx !== undefined && !attrs.data_equip_name) continue;
    await hoverForInspection(page, icon);
    await pace(signal, 300, 200);
    const tipId = attrs.data_tip_box;
    if (tipId)
      await page.waitForFunction(
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
      );
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
      item.description = coreEquipmentDescription(tooltip);
      if (item.name.startsWith("图标 ")) item.name = tooltip.split("\n")[0];
    }
    if (item.description || item.attributes || !item.name.startsWith("图标 "))
      snapshot.items!.push(item);
  }
}
async function settled(page: Page, signal: AbortSignal) {
  await page.waitForLoadState("networkidle", { timeout: 15000 });
  await pace(signal, 600, 500);
  await assertAvailable(page);
}
export async function collectDetail(
  page: Page,
  item: Listing,
  signal: AbortSignal,
  report: (message: string) => void = () => {},
): Promise<RoleDetail> {
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
  const tabs: TabSnapshot[] = [];
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
    if (name === "召唤兽/孩子") {
      const result = await collectPets(
        page,
        signal,
        (name) => capture(page, name),
        (snapshot) => inspectItems(page, snapshot, signal, report),
        () => settled(page, signal),
        report,
      );
      snapshot.pets = result.pets;
      snapshot.petCount = result.count;
      // 默认显示的第一只已保存在 pets，不重复放在总览里。
      const info = snapshot.text.lastIndexOf("详细信息");
      if (info >= 0) snapshot.text = snapshot.text.slice(0, info).trim();
      snapshot.fields = [];
      snapshot.tables = [];
    } else {
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
  return {
    captureVersion: CAPTURE_VERSION,
    url: item.url,
    collectedAt: new Date().toISOString(),
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
