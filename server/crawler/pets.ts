import type { Page } from "playwright-core";
import type { PetSnapshot, RoleDetail, TabSnapshot } from "./types";
import { hoverForInspection } from "../viewport";

export function petCaptureSummary(
  count: number | null,
  pets: PetSnapshot[],
  collectedAt: string,
  readIssues: string[] = [],
): NonNullable<RoleDetail["petCapture"]> {
  const issues = [...readIssues];
  if (count === null) issues.push("召唤兽总数未确认，不能按没有宝宝处理");
  else if (count !== pets.length)
    issues.push(`召唤兽数量不一致：确认 ${count} 只，读取 ${pets.length} 只`);
  for (const pet of pets) {
    const field = (name: string) => pet.fields.find((entry) => entry.name === name)?.value;
    const names = pet.fields.map((entry) => entry.name.trim());
    if (new Set(names).size !== names.length)
      issues.push(`第 ${pet.index} 只召唤兽属性重复，需要核对`);
    if (!(field("类型") || field("种类"))) issues.push(`第 ${pet.index} 只召唤兽类型未完整读取`);
    for (const name of [
      "等级",
      "成长",
      "攻击资质",
      "防御资质",
      "体力资质",
      "法力资质",
      "速度资质",
      "躲闪资质",
    ]) {
      const value = field(name)?.trim();
      const numeric = name.endsWith("资质")
        ? /^\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?$/
        : /^\d+(?:\.\d+)?$/;
      if (!value || !numeric.test(value) || (name === "成长" && Number(value) <= 0))
        issues.push(`第 ${pet.index} 只召唤兽${name}未完整读取`);
    }
    for (const skill of [...pet.skills, ...pet.innerSkills]) {
      if (!skill.name || skill.name.startsWith("图标 "))
        issues.push(`第 ${pet.index} 只召唤兽技能或内丹名称未完整读取`);
      if (skill.kind === "innerSkill" && !/^\d+$/.test(skill.level || ""))
        issues.push(`第 ${pet.index} 只召唤兽${skill.name}的内丹层数未完整读取`);
    }
    for (const equipment of pet.equipment) {
      const description =
        (equipment.description || equipment.tooltip || "") +
        "\n" +
        Object.entries(equipment.attributes || {})
          .map(([name, value]) => `${name} ${value}`)
          .join("\n");
      // Official RolePetShipin is a cosmetic slot; it has no required combat level or stats.
      if (
        !equipment.name ||
        equipment.name.startsWith("图标 ") ||
        (equipment.location === "RolePetShipin"
          ? !description.trim()
          : !/(?:等级|装备条件)\s*[：:]?\s*\d/.test(description) ||
            !/(?:命中(?:率)?|伤害|防御|气血|魔法|速度|敏捷|力量|体质|耐力|灵力|魔力|法术|抵抗|附加|镶嵌)\s*[：:]?\s*[+＋−-]?\d/.test(
              description,
            ))
      )
        issues.push(`第 ${pet.index} 只召唤兽${equipment.name}的装备属性未完整读取`);
    }
  }
  const unique = [...new Set(issues)];
  return { version: 1, collectedAt, complete: unique.length === 0, issues: unique };
}

export async function collectPets(
  page: Page,
  signal: AbortSignal,
  capture: (name: string) => Promise<TabSnapshot>,
  inspect: (snapshot: TabSnapshot) => Promise<void>,
  settled: () => Promise<void>,
  report: (message: string) => void,
): Promise<{ count: number | null; pets: PetSnapshot[]; issues: string[] }> {
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
  const issues: string[] = [];
  for (let index = 0; index < discovered.count; index++) {
    signal.throwIfAborted();
    report(`正在读取第 ${index + 1}/${discovered.count} 只召唤兽的资质、技能及装备…`);
    const entry = page.locator(`[data-cbg-pet-index="${index}"]`);
    await hoverForInspection(page, entry);
    await entry.evaluate((el) => (el as HTMLElement).click());
    await settled();
    const proof = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-cbg-detail-root]")!;
      root
        .querySelectorAll("[data-cbg-pet-item]")
        .forEach((el) => el.removeAttribute("data-cbg-pet-item"));
      const visible = (el: Element) =>
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        !el.closest('[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"]');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (node.parentElement && visible(node.parentElement)) nodes.push(node);
      }
      let markerIndex = -1;
      nodes.forEach((node, index) => {
        if (/详细信息/.test(node.textContent || "")) markerIndex = index;
      });
      if (markerIndex < 0) return null;
      const marker = nodes[markerIndex];
      const range = document.createRange();
      range.setStart(marker, (marker.textContent || "").lastIndexOf("详细信息") + 4);
      const end = nodes
        .slice(markerIndex + 1)
        .find((node) =>
          /^(?:孩子|特殊宠物|召唤兽心得技能)(?:\s*[（(][^）)]*[）)])?\s*$/.test(
            node.textContent?.trim() || "",
          ),
        );
      if (end) range.setEndBefore(end);
      else range.setEnd(root, root.childNodes.length);
      const selected = nodes.slice(markerIndex + 1).filter((node) => range.intersectsNode(node));
      const text = selected
        .map((node) => node.textContent?.trim() || "")
        .filter(Boolean)
        .join("\n");
      const counts = { skills: 0, equipment: 0, innerSkills: 0 };
      const icons: Record<keyof typeof counts, { name: string; modelId: string; src: string }[]> = {
        skills: [],
        equipment: [],
        innerSkills: [],
      };
      for (const icon of root.querySelectorAll("img")) {
        if (
          !visible(icon) ||
          !range.intersectsNode(icon) ||
          /\/pets\/(?:big|small)\//.test(icon.getAttribute("src") || "") ||
          /\/images\/time_lock_(?:\d+|protect|huoyue)\.png(?:[?#]|$)/.test(
            icon.getAttribute("src") || "",
          )
        )
          continue;
        icon.setAttribute("data-cbg-pet-item", "true");
        const section = selected
          .filter(
            (node) => (node.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          )
          .map((node) => node.textContent?.trim() || "")
          .filter((text) => /^(?:赐福技能|(?:召唤兽)?技能|内丹)(?:\s*[（(]\d+[）)])?$/.test(text))
          .at(-1)
          ?.replace(/\s*[（(]\d+[）)]$/, "");
        if (section) icon.setAttribute("data_cbg_skill_section", section);
        else icon.removeAttribute("data_cbg_skill_section");
        const attrs: Record<string, string> = {};
        let current: Element | null = icon;
        for (
          let depth = 0;
          depth < 3 && current && current !== root;
          depth++, current = current.parentElement
        )
          for (const attr of current.attributes)
            if (attr.name.startsWith("data"))
              attrs[attr.name.replace(/^data-/, "data_")] ||= attr.value;
        const skill = attrs.data_skill_type;
        let kind: keyof typeof counts | undefined;
        if (skill === "neidan") kind = "innerSkills";
        else if (skill) kind = "skills";
        else if (attrs.data_equip_name || attrs.data_tip_box || attrs.data_equip_desc)
          kind = "equipment";
        if (kind) {
          counts[kind]++;
          icons[kind].push({
            name: attrs.data_equip_name || "",
            modelId: attrs.data_equip_type || "",
            src: icon.getAttribute("src") || "",
          });
        }
      }
      const declared = (label: string) => {
        const match = text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[（(]\\s*(\\d+)\\s*[）)]`));
        return match ? Number(match[1]) : null;
      };
      return {
        text,
        counts,
        icons,
        sections: {
          skills:
            counts.skills > 0 ||
            /(?:^|\n)\s*(?:召唤兽)?技能(?:\s*[（(:：]|\s*$)/m.test(text) ||
            /(?:无|没有|暂无)技能/.test(text),
          equipment:
            counts.equipment > 0 ||
            /(?:^|\n)\s*(?:召唤兽|宝宝)?装备(?:\s*[（(:：]|\s*$)/m.test(text) ||
            /(?:无|没有|暂无)(?:宝宝)?装备/.test(text),
          innerSkills:
            counts.innerSkills > 0 ||
            /(?:^|\n)\s*(?:召唤兽)?内丹(?:\s*[（(:：]|\s*$)/m.test(text) ||
            /(?:无|没有|暂无)内丹/.test(text),
        },
        declared: {
          skills: declared("技能"),
          equipment: declared("装备"),
          innerSkills: declared("内丹"),
        },
        loading: /正在(?:加载|读取)|加载中|展开全部(?:技能|装备|内丹)/.test(text),
      };
    });
    const snapshot = await capture(`召唤兽 ${index + 1}`);
    await inspect(snapshot);
    if (!proof) issues.push(`第 ${index + 1} 只召唤兽详细信息区域未确认`);
    const start = snapshot.text.lastIndexOf("详细信息");
    const body = proof?.text ?? (start >= 0 ? snapshot.text.slice(start + 4) : snapshot.text);
    const stats = body
      .split(/(?:^|\n)技能(?:\s*[（(]\s*\d+\s*[）)])?(?:\n|$)/)[0]
      .replace(/[ \t]+(?=[^\s：:]{1,20}[：:])/g, "\n");
    const fields = [
      ...stats.matchAll(/(?:^|[\n\t；])([^：:\n\t；]{1,30})[：:]\s*([^\n\t；]+)/g),
    ].map((match) => ({ name: match[1].trim(), value: match[2].trim() }));
    if (!fields.some((field) => /类型|名称|宝宝/.test(field.name)))
      throw Object.assign(new Error(`第 ${index + 1} 只召唤兽没有可识别的属性，未标记采集成功`), {
        name: "IncompleteDetailError",
      });
    const items = snapshot.items || [];
    const pet: PetSnapshot = {
      index: index + 1,
      name:
        fields.find((field) => /^(名称|名字|宝宝)$/.test(field.name))?.value ||
        fields.find((field) => field.name === "类型")?.value ||
        `召唤兽 ${index + 1}`,
      fields,
      skills: items.filter((item) => item.kind === "skill"),
      equipment: items.filter((item) => item.kind === "equipment"),
      innerSkills: items.filter((item) => item.kind === "innerSkill"),
    };
    if (proof) {
      if (proof.loading) issues.push(`第 ${index + 1} 只召唤兽详情仍在加载或未展开`);
      for (const [key, label] of [
        ["skills", "技能"],
        ["equipment", "装备"],
        ["innerSkills", "内丹"],
      ] as const) {
        if (!proof.sections[key])
          issues.push(`第 ${index + 1} 只召唤兽${label}区域未确认，不能按空列表处理`);
        if (pet[key].length !== proof.counts[key]) {
          issues.push(`第 ${index + 1} 只召唤兽${label}图标未完整读取`);
          report(
            "召唤兽图标核对异常：" +
              JSON.stringify({
                pet: index + 1,
                section: key,
                expected: proof.counts[key],
                captured: pet[key].length,
                icons: proof.icons[key],
                capturedItems: pet[key].map((item) => ({ name: item.name, modelId: item.modelId })),
              }),
          );
        }
        if (proof.declared[key] !== null && pet[key].length !== proof.declared[key])
          issues.push(`第 ${index + 1} 只召唤兽${label}数量与页面不一致`);
      }
    }
    pets.push(pet);
  }
  return { count: discovered.expected, pets, issues };
}
