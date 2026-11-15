// Read-only extraction mirrors the browser principal-pet observation. No page markers are written.
(() => {
  function principalRegions(globals, excluded) {
    const visible = (node) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !node.closest(excluded);
    let infos = Array.from(document.querySelectorAll("#info_panel")).filter(visible);
    let inputs = Array.from(document.querySelectorAll("#equip_desc_value")).filter(
      (node) => !node.closest(excluded),
    );
    let legacyPanel;
    // Observed official prepay page: one direct pet panel in goodsInfo, with pet_desc textarea.
    if (!infos.length && !inputs.length) {
      const panels = Array.from(document.querySelectorAll("#pet_attr_panel")).filter(visible);
      const descriptions = Array.from(document.querySelectorAll("textarea#pet_desc")).filter(
        (node) => !node.closest(excluded),
      );
      const info = panels[0]?.parentElement;
      if (
        panels.length !== 1 ||
        descriptions.length !== 1 ||
        !info?.matches(".infoList.goodsInfo") ||
        !visible(info)
      )
        return false;
      legacyPanel = panels[0];
      infos = [info];
      inputs = descriptions;
    }
    const g = globals;
    if (
      !(g.equip || g.EquipInfo) ||
      infos.length !== 1 ||
      inputs.length !== 1 ||
      !inputs[0].value.trim()
    )
      return false;
    const panels = Array.from(document.querySelectorAll("#equip_desc_panel")).filter(visible);
    if (panels.length > 1) return false;
    let panel = panels[0] || legacyPanel;
    if (!panel) {
      const hasStats = (node) => {
        const text = node.innerText.replace(/\s/g, "");
        return (
          ["成长", "攻击资质", "防御资质", "体力资质", "法力资质", "速度资质"].every((name) =>
            text.includes(name),
          ) && /躲[闪避]资质/.test(text)
        );
      };
      let region = infos[0].parentElement;
      while (region && region !== document.body && region !== document.documentElement) {
        const tables = Array.from(region.querySelectorAll("table, dl")).filter(
          (node) => visible(node) && hasStats(node),
        );
        const leaves = tables.filter(
          (node) => !tables.some((other) => other !== node && node.contains(other)),
        );
        if (leaves.length > 1) return false;
        if (leaves.length === 1) {
          let candidate = leaves[0];
          while (candidate && candidate !== region && !candidate.contains(infos[0])) {
            const text = candidate.innerText.replace(/\s/g, "");
            if (
              text.length <= 20_000 &&
              /技能/.test(text) &&
              /内丹/.test(text) &&
              /装备/.test(text)
            ) {
              panel = candidate;
              break;
            }
            candidate = candidate.parentElement;
          }
          break;
        }
        region = region.parentElement;
      }
    }
    if (
      !panel ||
      !visible(panel) ||
      !panel.innerText.trim() ||
      /加载中|正在加载/.test(panel.innerText) ||
      !infos[0].innerText.trim()
    )
      return false;
    const priceReady = Array.from(
      infos[0].querySelectorAll(".price, [data_price], [data-price]"),
    ).some(
      (node) =>
        visible(node) &&
        !node.closest("#equip_price_addon_info") &&
        (node.innerText.trim() ||
          node.getAttribute("data_price") ||
          node.getAttribute("data-price")),
    );
    return priceReady ? { panel, info: infos[0], input: inputs[0] } : undefined;
  }
  globalThis.__CBGPetProductObservation = (envelope) => {
    const globals = {
      ...envelope,
      equip: envelope.equip_info,
      ...envelope.petConfig,
      CBG_GAME_CONFIG: envelope.petConfig?.CBG_GAME_CONFIG || {},
      StorageStype: envelope.StorageStype || {},
    };
    const excluded =
      '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .equip_tips';
    const g = globals;
    const raw = g.equip || g.EquipInfo;
    const visible = (node) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !node.closest(excluded);
    const principal = principalRegions(globals, excluded);
    if (!principal) return undefined;
    const { panel, info, input } = principal;
    let root = panel?.parentElement;
    while (root && root !== document.body && info && !root.contains(info))
      root = root.parentElement;
    if (
      !raw ||
      !panel ||
      !info ||
      !root ||
      !visible(panel) ||
      !visible(info) ||
      root === document.body ||
      root === document.documentElement ||
      !root.contains(info) ||
      root.closest(excluded)
    )
      throw new Error("官网独立宝宝主商品区域未识别，未采用推荐内容");
    if (/加载中|正在加载|展开全部(?:技能|装备|内丹)/.test(panel.innerText))
      throw new Error("宝宝详情尚未展开完整");
    const pet = globals.parsedPet;
    if (
      !pet ||
      !Array.isArray(pet.all_skills) ||
      !Array.isArray(pet.neidan) ||
      !Array.isArray(pet.equip_list)
    )
      throw new Error("官网主宝宝完整描述未确认");
    const fieldName = (name) =>
      name
        .trim()
        .replace(/\s/g, "")
        .replace(/[：:]$/, "")
        .replace(/^成长率$/, "成长")
        .replace(/^躲避资质$/, "躲闪资质");
    const fields = [];
    const add = (name, value) => {
      name = fieldName(name);
      value = value.replace(/\s+/g, " ").trim();
      if (name && (value || /赐福/.test(name))) fields.push({ name, value });
    };
    const structuredRegions = new Set();
    for (const label of panel.querySelectorAll("th, td, dt")) {
      const value = label.nextElementSibling;
      if (
        value instanceof HTMLElement &&
        visible(label) &&
        visible(value) &&
        /^(?:TD|DD)$/.test(value.tagName) &&
        (label.tagName === "TH" || label.tagName === "DT" || /[：:]\s*$/.test(label.innerText))
      ) {
        add(label.innerText, value.innerText);
        const region = label.closest("table, dl");
        if (region) structuredRegions.add(region);
      }
    }
    // Parsed tables already include bonus spans; the text fallback would split them into conflicting values.
    const principalText = (region) => {
      let text = region.innerText;
      for (const tip of region.querySelectorAll(excluded)) text = text.replace(tip.innerText, "");
      return text;
    };
    let fallbackText = principalText(panel);
    for (const region of structuredRegions)
      fallbackText = fallbackText.replace(region.innerText, "");
    const fieldText = fallbackText.split(
      /(?:^|\n)\s*(?:赐福技能|技能|内丹|(?:召唤兽|宝宝)?装备)\s*(?:[（(:：]|\n|$)/,
    )[0];
    for (const match of fieldText
      .replace(/[ \t]+(?=[^\s：:\n]{1,20}[：:])/g, "\n")
      .matchAll(/(?:^|[\n\t；])([^：:\n\t；]{1,30})[：:]\s*([^\n\t；]+)/g))
      add(match[1], match[2]);
    // The bound product information region may hold the only visible level.
    for (const region of [panel, info])
      for (const match of principalText(region).matchAll(
        /(?:^|\s)等级\s*[：:]\s*(\d{1,3})(?=\s|$)/g,
      ))
        add("等级", match[1]);
    const type = g.CBG_GAME_CONFIG?.pet_info?.[String(pet.type_id)];
    if (typeof type !== "string" || !type) throw new Error("官网主宝宝类型目录未识别");
    const parsedFields = [
      { name: "类型", value: type },
      ...[
        ["等级", "pet_grade"],
        ["成长", "growth"],
        ["攻击资质", "attack_aptitude"],
        ["防御资质", "defence_aptitude"],
        ["体力资质", "physical_aptitude"],
        ["法力资质", "magic_aptitude"],
        ["速度资质", "speed_aptitude"],
        ["躲闪资质", "avoid_aptitude"],
      ].map(([name, key]) => {
        const bonus = name.endsWith("资质") ? pet[key.replace("_aptitude", "_ext")] : undefined;
        return { name, value: String(pet[key] ?? "") + (bonus ? " +" + String(bonus) : "") };
      }),
    ];
    if (parsedFields.some((field) => !field.value)) throw new Error("官网主宝宝关键数据缺失");
    const icons = Array.from(panel.querySelectorAll("img"))
      .filter(visible)
      .map((icon) => {
        const attrs = {};
        let node = icon;
        for (let depth = 0; depth < 3 && node && node !== panel; depth++, node = node.parentElement)
          for (const attr of node.attributes)
            if (attr.name.startsWith("data"))
              attrs[attr.name.replace(/^data-/, "data_")] ||= attr.value;
        return { attrs, src: icon.getAttribute("src") || "" };
      });
    const skillNames = icons
      .filter(
        ({ attrs, src }) =>
          attrs.data_skill_type === "cifu" ||
          (!attrs.data_skill_type &&
            /\/skill\//.test(src) &&
            !!(attrs.data_equip_name || attrs.data_store_name)),
      )
      .map(({ attrs }) => attrs.data_equip_name || attrs.data_store_name || "");
    // Explicit evolution previews are not current skills; their configuration remains unpriced.
    const futureSkill = (name) => /[（(]进化后获得[）)]/.test(name.replace(/\s/g, ""));
    const futureSkills = skillNames.filter(futureSkill);
    const skills = skillNames.filter((name) => !futureSkill(name));
    const expectedSkills = pet.all_skills.map(
      (id) => g.CBG_GAME_CONFIG?.pet_skill_desc?.[String(id)]?.name || "",
    );
    if (skills.some((name) => !name) || expectedSkills.some((name) => !name))
      throw new Error("官网主宝宝技能名称未完整识别");
    const innerSkills = icons
      .filter(({ attrs }) => attrs.data_skill_type === "neidan")
      .map(({ attrs }) => ({
        name: attrs.data_equip_name || attrs.data_store_name || "",
        level: attrs.data_equip_level || "",
      }));
    const expectedInner = pet.neidan.map((skill) => ({
      name: typeof skill.name === "string" ? skill.name : "",
      level:
        typeof skill.level === "number" || typeof skill.level === "string"
          ? String(skill.level)
          : "",
    }));
    const equipment = icons
      .filter(({ attrs, src }) => !attrs.data_skill_type && /\/(?:equip|pet_shipin)\//.test(src))
      .map(({ attrs, src }) => ({
        name: attrs.data_equip_name || attrs.data_cbg_pet_gear_name || "",
        description: attrs.data_cbg_pet_gear_description || attrs.data_equip_desc || "",
        accessory: /\/images\/pet_shipin\//.test(src),
      }));
    const expectedEquipment = pet.equip_list.filter(Boolean).map((gear) => ({
      name: typeof gear.name === "string" ? gear.name : "",
      description: typeof gear.desc === "string" ? gear.desc : "",
      accessory: typeof gear.icon === "string" && /\/images\/pet_shipin\//.test(gear.icon),
    }));
    const certification = String(pet.sp_skill_id ?? pet.sp_skill ?? "0");
    if (certification !== "0") {
      const name = g.CBG_GAME_CONFIG?.pet_skill_desc?.[certification]?.name;
      if (!name) throw new Error("认证技能未完整识别");
      if (!fields.some((field) => field.name === "认证技能")) add("认证技能", name);
    }
    // Return only public pet configuration and the directory entries needed to verify it.
    const payloads = [
      { name: "evol_skill_list", value: pet.evol_skill_list },
      { name: "evol_skills", value: pet.evol_skills },
      { name: "other.EvolSkill", value: pet.other?.EvolSkill },
      { name: "other.evol_skills", value: pet.other?.evol_skills },
    ];
    const evolutionIds = new Set(
      payloads
        .flatMap(({ value }) =>
          Array.isArray(value)
            ? value.map((row) => String(row && typeof row === "object" ? row.skill_type : row))
            : typeof value === "string"
              ? value.split("|")
              : [],
        )
        .filter((id) => /^[1-9]\d*$/.test(id)),
    );
    const mappings = {};
    const directoryIds = new Set(evolutionIds);
    for (const id of evolutionIds) {
      const mapping = g.CBG_GAME_CONFIG?.pet_skill_high_to_other_level_mapping?.[id];
      if (!mapping || typeof mapping !== "object") continue;
      mappings[id] = {
        high_skill: mapping.high_skill,
        low_skill: mapping.low_skill,
        super_skill: mapping.super_skill,
        name: mapping.name,
      };
      for (const value of [mapping.high_skill, mapping.low_skill, mapping.super_skill])
        if (/^[1-9]\d*$/.test(String(value))) directoryIds.add(String(value));
    }
    const names = {};
    for (const id of directoryIds) {
      const name = g.CBG_GAME_CONFIG?.pet_skill_desc?.[id]?.name;
      if (typeof name === "string" && name) names[id] = name;
    }
    // Status text comes only from the two bound principal regions, not their broader wrapper.
    const body = [info, panel]
      .map((region) => {
        const copy = region.cloneNode(true);
        copy
          .querySelectorAll(
            excluded + ", #equip_price_addon_info, script, style, nav, header, footer",
          )
          .forEach((node) => node.remove());
        return copy.textContent || "";
      })
      .join("\n");
    return {
      evolution: { payloads, currentSkills: pet.all_skills, names, mappings },
      futureSkills,
      expectedFutureSkills: [],
      productId: raw.eid,
      serverId: raw.serverid ?? raw.server_id,
      productName: raw.equip_name,
      visibleName:
        info.innerText
          .match(
            input?.id === "pet_desc"
              ? /(?:^|\s)名称\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/
              : /(?:^|\s)ID\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/i,
          )?.[1]
          ?.trim() || "",
      storageType: raw.storage_type,
      petStorageType: g.StorageStype?.pet,
      rawPrice: raw.price,
      prices: Array.from(info.querySelectorAll("[data_price], [data-price], .price"))
        .filter((node) => visible(node) && !node.closest("#equip_price_addon_info"))
        .map(
          (node) =>
            node.getAttribute("data_price") || node.getAttribute("data-price") || node.innerText,
        ),
      selling: raw.is_selling,
      body,
      fields,
      parsedFields,
      skills,
      expectedSkills,
      innerSkills,
      expectedInner,
      equipment,
      expectedEquipment,
    };
  };
})();
