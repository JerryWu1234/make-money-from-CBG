(() => {
  // Only the site's public search directories; no account/session state is enumerated.
  window.__CBGReadMarketConfig = () => {
    const g = window,
      jewelry = new URL(location.href).searchParams.get("act") === "show_overall_search_lingshi";
    const options = (id) =>
      [...document.querySelectorAll(`#${id} option`)].map((option) => [
        option.value,
        option.textContent?.trim() || "",
      ]);
    const typed = (values) =>
      Object.entries(values || {})
        .filter(([, id]) => ["string", "number"].includes(typeof id))
        .map(([name, id]) => [id, name]);
    const choices = (id) =>
      [...document.querySelectorAll(`#${id} > li`)].map((node) => {
        const value =
          node.getAttribute("data_value") ??
          node.getAttribute("data-value") ??
          node.retrieve?.("value");
        return [
          typeof value === "string" || typeof value === "number" ? value : "",
          node.textContent?.trim() || "",
        ];
      });
    const serverAreas = {};
    for (const [area, group] of Object.entries(g.server_data || {}))
      if (Array.isArray(group) && Array.isArray(group[1]))
        for (const server of group[1])
          if (Array.isArray(server) && /^[1-9]\d*$/.test(String(server[0])))
            serverAreas[String(server[0])] = area;
    const yuanshen =
      new URL(location.href).searchParams.get("act") === "show_overall_search_yuanshen";
    return {
      serverAreas,
      kinds: yuanshen
        ? choices("equip_type_check_panel")
        : (jewelry ? g.Kinds : g.EquipKinds) || [],
      effects: g.SpecialEffects || [],
      skills: g.PetSkills || g.SpecialSkills || [],
      gems: g.Gems || [],
      autoSearch: g.AUTO_SEARCH_CONFIG?.wjd_equip_equip_type || {},
      ...(yuanshen ? { namedKinds: options("attr_type") } : {}),
      addedAttrs: yuanshen
        ? choices("equip_attr_check_panel")
        : [...(g.AddedAttr1 || []), ...(g.AddedAttr2 || [])],
      suits: options("sel_short_cut").filter(([value]) => /^[1-9]\d*$/.test(value)),
      jewelrySuitEffects:
        jewelry && Array.isArray(g.SuitEffects)
          ? g.SuitEffects.filter((value) => typeof value === "string")
          : [],
      jewelrySuitChoices: options("sel_suit_effect").filter(
        ([value]) => value !== "" && value !== "0",
      ),
      jewelryPrimaryAttrs: options("sel_basic_attr_type").filter(([value]) => value !== ""),
      jewelryAddedAttrs: options("sel_add_attr1").filter(
        ([value]) => value !== "" && value !== "0",
      ),
      suitTypes: {
        added_status: typed(g.SuitAddedStatus),
        append_skill: typed(g.SuitAppendSkills),
        transform_skill: typed(g.SuitTransformSkills),
        transform_charm: typed(g.SuitTransformCharms),
      },
      names: g.SaleablePetNameInfo || {},
      highNeidans: g.HighNeidans || [],
      lowNeidans: g.LowNeidans || [],
      traits: g.TexingTypes || [],
      officialPetTypes: g.CBG_GAME_CONFIG?.pet_info || {},
      jade: g.CBG_GAME_CONFIG
        ? {
            minghun_attr: g.CBG_GAME_CONFIG.minghun_attr,
            minghun_attr_yin: g.CBG_GAME_CONFIG.minghun_attr_yin,
            minghun_attr_yang: g.CBG_GAME_CONFIG.minghun_attr_yang,
            minghun_effect: g.CBG_GAME_CONFIG.minghun_effect,
            minghun_teji: g.CBG_GAME_CONFIG.minghun_teji,
            minghun_daoju: g.CBG_GAME_CONFIG.minghun_daoju,
          }
        : undefined,
    };
  };
})();
