import type { Page } from "playwright-core";
import type { PetSnapshot, TabSnapshot } from "./types";
import { hoverForInspection } from "../viewport";

export async function collectPets(
  page: Page,
  signal: AbortSignal,
  capture: (name: string) => Promise<TabSnapshot>,
  inspect: (snapshot: TabSnapshot) => Promise<void>,
  settled: () => Promise<void>,
  report: (message: string) => void,
): Promise<{ count: number; pets: PetSnapshot[] }> {
  const discovered = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-cbg-detail-root]")!;
    const title = /召唤兽\s*[（(]\s*(\d+)\s*\/\s*\d+\s*[）)]/;
    const visible = (el: Element) =>
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !el.closest('[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"]');
    const isTitle = (el: Element) =>
      new RegExp(`^${title.source}$`).test(el.textContent?.trim() || "");
    const heading = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
      (el) => visible(el) && isTitle(el) && !Array.from(el.children).some(isTitle),
    );
    const match = (heading?.textContent || root.innerText).match(title);
    const candidates = (scope: Element) => {
      // small 头像是切换入口，详情大图不属于入口；范围必须跟随召唤兽标题。
      const portraits = Array.from(
        scope.querySelectorAll(
          'img[data_idx][src*="/pets/small/"], img[data-idx][src*="/pets/small/"]',
        ),
      ).filter(visible);
      const fallback = Array.from(
        scope.querySelectorAll("[data-pet-id], #pet_list li, #summon_list li, .pet_list li"),
      ).filter(visible);
      return portraits.length
        ? portraits
        : fallback.filter((el) => !fallback.some((other) => other !== el && el.contains(other)));
    };
    let scope: Element = heading?.parentElement || root;
    while (scope !== root && match?.[1] !== "0" && !candidates(scope).length && scope.parentElement)
      scope = scope.parentElement;
    // Some pages put section titles directly in text nodes inside a shared wrapper.
    // Bound the pet entries by the following section title, rather than treating the
    // entire shared parent (including children and the selected pet preview) as a list.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement && visible(node.parentElement)) textNodes.push(node);
    }
    const marker = textNodes
      .map((node) => node.textContent || "")
      .join("")
      .match(title);
    const boundary = /^(?:孩子|特殊宠物|召唤兽心得技能)(?:\s*[（(][^）)]*[）)])?\s*$/;
    let section: Range | undefined;
    if (marker) {
      let remaining = marker.index! + marker[0].length;
      let titleIndex = 0;
      while (titleIndex < textNodes.length - 1 && remaining > textNodes[titleIndex].length)
        remaining -= textNodes[titleIndex++].length;
      const end = textNodes
        .slice(titleIndex + 1)
        .find((node) => boundary.test(node.textContent?.trim() || ""));
      if (end) {
        section = document.createRange();
        section.setStart(textNodes[titleIndex], remaining);
        section.setEnd(end, 0);
      }
    }
    const elements = section
      ? candidates(root).filter((el) => section!.intersectsNode(el))
      : candidates(scope);
    root
      .querySelectorAll("[data-cbg-pet-index]")
      .forEach((el) => el.removeAttribute("data-cbg-pet-index"));
    elements.forEach((el, index) => el.setAttribute("data-cbg-pet-index", String(index)));
    return {
      expected: match ? Number(match[1]) : null,
      count: elements.length,
      scope: `${scope.tagName}#${scope.id}`,
      boundedBySectionTitles: Boolean(section),
      entries: elements.slice(0, 30).map((el) => ({
        index:
          el.getAttribute("data_idx") ||
          el.getAttribute("data-idx") ||
          el.getAttribute("data-pet-id"),
        id: el.id,
        parent: `${el.parentElement?.tagName}#${el.parentElement?.id}`,
        container: el.closest("ul, ol, section")?.id || "",
      })),
    };
  });
  report(
    `召唤兽数量核对：页面标注 ${discovered.expected ?? "未知"} 只，识别到 ${discovered.count} 个切换入口`,
  );
  if (discovered.expected !== null && discovered.expected !== discovered.count)
    report(`召唤兽入口结构：${JSON.stringify(discovered)}`);
  if (discovered.expected !== null && discovered.expected !== discovered.count)
    throw Object.assign(
      new Error(
        `召唤兽数量不一致：页面标注 ${discovered.expected} 只，召唤兽区域识别到 ${discovered.count} 个切换入口，详情待重试`,
      ),
      { name: "IncompleteDetailError" },
    );
  const pets: PetSnapshot[] = [];
  for (let index = 0; index < discovered.count; index++) {
    signal.throwIfAborted();
    report(`正在读取第 ${index + 1}/${discovered.count} 只召唤兽的资质、技能及装备…`);
    const entry = page.locator(`[data-cbg-pet-index="${index}"]`);
    await hoverForInspection(page, entry);
    await entry.evaluate((el) => (el as HTMLElement).click());
    await settled();
    const snapshot = await capture(`召唤兽 ${index + 1}`);
    await inspect(snapshot);
    const start = snapshot.text.lastIndexOf("详细信息");
    const body = start >= 0 ? snapshot.text.slice(start + 4) : snapshot.text;
    const stats = body
      .split(/(?:^|\n)技能(?:\n|$)/)[0]
      .replace(/[ \t]+(?=[^\s：:]{1,20}[：:])/g, "\n");
    const fields = [
      ...stats.matchAll(/(?:^|[\n\t；])([^：:\n\t；]{1,30})[：:]\s*([^\n\t；]+)/g),
    ].map((match) => ({ name: match[1].trim(), value: match[2].trim() }));
    if (!fields.some((field) => /类型|名称|宝宝/.test(field.name)))
      throw Object.assign(new Error(`第 ${index + 1} 只召唤兽没有可识别的属性，未标记采集成功`), {
        name: "IncompleteDetailError",
      });
    const items = snapshot.items || [];
    pets.push({
      index: index + 1,
      name:
        fields.find((field) => /^(名称|名字|宝宝)$/.test(field.name))?.value ||
        fields.find((field) => field.name === "类型")?.value ||
        `召唤兽 ${index + 1}`,
      fields,
      skills: items.filter((item) => item.kind === "skill"),
      equipment: items.filter((item) => item.kind === "equipment"),
      innerSkills: items.filter((item) => item.kind === "innerSkill"),
    });
  }
  return { count: discovered.expected ?? discovered.count, pets };
}
