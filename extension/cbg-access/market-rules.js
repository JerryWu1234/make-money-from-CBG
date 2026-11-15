(() => {
  const paths = {
    equipment: "/cgi-bin/equipquery.py?act=show_overall_search_equip",
    pet: "/cgi-bin/equipquery.py?act=show_overall_search_pet",
    "pet-gear": "/cgi-bin/xyq_overall_search.py?act=show_pet_equip_search_form",
    jewelry: "/cgi-bin/xyq_overall_search.py?act=show_overall_search_lingshi",
    yuanshen: "/cgi-bin/xyq_overall_search.py?act=show_overall_search_yuanshen",
    jade: "/cgi-bin/xyq_overall_search.py?act=show_overall_search_yupo",
  };
  const crossServerFields = [
    "user_serverid",
    "cross_buy_serverid",
    "crossbuy_serverid",
    "buy_serverid",
  ];
  const numberFields = [
    "repair_fail",
    "damage",
    "all_wakan",
    "gem_level",
    "init_defense",
    "init_damage",
    "init_damage_raw",
    "all_damage",
    "init_wakan",
    "init_hp",
    "init_dex",
    "hole_num",
    "jinglian_level",
    "suit_effect_level",
    "basic_attr_value",
    "attr_value",
    "addon_skill_chance",
    "addon_effect_chance",
    "init_attrs",
    "base_attrs1",
    "base_attrs2",
    "total_attrs",
    "minghun_effect",
    "minghun_level_min",
    "growth",
    "level_min",
    "level_max",
    "attack",
    "defense",
    "health",
    "magic",
    "speed",
    "avoid",
    "attack_aptitude",
    "defense_aptitude",
    "health_aptitude",
    "magic_aptitude",
    "speed_aptitude",
    "avoid_aptitude",
    "defence_aptitude",
    "physical_aptitude",
    "speed_aptitude_min",
    "speed_aptitude_max",
    "skill_num",
    "neidan_num",
    "lifetime",
    "price_min",
    "price_max",
    "sum_attr",
    "lingxing",
    "carrygrade",
    "strength",
    "qixue",
    "fali",
    "gongji",
    "fangyu",
    "sudu",
    "mingzhong",
    "minjie",
    "tili",
    "naili",
    "moli",
  ];
  const fieldIds = new Set([
    ...numberFields.map((name) => "txt_" + name),
    "pet_select_box",
    "speed",
    "fangyu",
    "mofa",
    "shanghai",
    "hp",
    "hit_ratio",
    "addon_minjie_reduce",
    "addon_sum_min",
    "xiang_qian_level",
    "addon_status",
    "repair_failed_times",
    "chk_is_baobao",
    "chk_attr_with_melt",
    "chk_has_eazy_effect",
    "chk_include_ext_mh_lv",
    "sel_short_cut",
    "sel_suit_effect",
    "sel_basic_attr_type",
    "sel_add_attr1",
    "sel_add_attr2",
    "sel_add_attr3",
    "sel_init_attrs",
    "sel_base_attrs1",
    "sel_base_attrs2",
    "sel_total_attrs",
    "sel_minghun_effect",
    "attr_type",
    "overall_sel_area",
    "ovarall_sel_server",
    "added_attr_logic_detail",
    "radio_short_cut",
    "radio_added_status",
    "radio_append_skill",
    "radio_transform_skill",
    "radio_transform_charm",
    "txt_added_status",
    "txt_append_skill",
    "txt_transform_skill",
    "txt_transform_charm",
  ]);
  const panels = new Set([
    "kind_check_panel",
    "kind_panel",
    "server_type_panel",
    "fair_show_panel",
    "special_effect_panel",
    "special_skill_panel",
    "gem_panel",
    "added_attr_num_panel",
    "check_mode_panel",
    "equip_type_check_panel",
    "equip_attr_check_panel",
    "yupo_type_panel",
    "special_teji",
    "special_daoju",
    "pet_skill_wrap",
    "addon_skill_box",
    "position_box",
    "EquipPosBox",
    "xiangqian_stone_attr_panel",
    "high_neidan_panel",
    "low_neidan_panel",
    "texing_panel",
    "super_sum_star",
  ]);
  const visible = (el) =>
    el instanceof HTMLElement &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const text = (el) => (el?.innerText || el?.textContent || "").trim();
  const one = (values) => {
    const found = values.filter(visible);
    if (found.length !== 1) throw new Error("unsupported:market-target-not-unique");
    return found[0];
  };
  const category = () =>
    Object.entries(paths).find(([, path]) => location.pathname + location.search === path)?.[0];
  function choices(panel, globals) {
    if (panel === "super_sum_star")
      return [...document.querySelectorAll("input.js_super_sum_star[value]")]
        .filter((node) => ["checkbox", "radio"].includes(node.type) && /^[0-3]$/.test(node.value))
        .map((node) => ({
          node,
          value: node.value,
          label: node.getAttribute("aria-label") || text(node.labels?.[0]) || node.value,
          selected: node.checked,
        }));
    const root = document.getElementById(panel);
    if (!root) return [];
    const rows = [...root.querySelectorAll("li")].filter((node) => !node.querySelector("li"));
    const nodes = rows.length ? rows : [...root.querySelectorAll("input[value], option")];
    return nodes.map((node, index) => {
      const label =
        text(node) ||
        node.getAttribute("title") ||
        node.getAttribute("aria-label") ||
        text(node.labels?.[0]) ||
        "";
      let value =
        node.getAttribute("data_value") ??
        node.getAttribute("data-value") ??
        node.getAttribute("value") ??
        node.getAttribute("data-skill_id") ??
        node.getAttribute("data-id");
      if (value === null) {
        const candidate = globals?.marketMenus?.[panel]?.[index];
        if (
          candidate &&
          candidate.index === index &&
          candidate.tag === node.tagName &&
          candidate.id === node.id &&
          candidate.label === text(node) &&
          typeof candidate.value === "string" &&
          /^[\w.,-]{0,80}$/.test(candidate.value) &&
          !/购买|支付|下单|删除|授权/.test(label)
        )
          value = candidate.value;
      }
      return {
        node,
        value: value || "",
        label,
        selected:
          node.matches(":checked,[aria-selected=true],.selected,.active,.on") ||
          node.querySelector("input:checked") !== null,
      };
    });
  }
  function select(target, globals) {
    if (target.kind === "market-expand") {
      const id = {
        "pet-skills": "btn_all_skill",
        "equipment-special-skills": "btn_all_special_skill",
      }[target.panel];
      if (!id) throw new Error("unsupported:market-expand-panel");
      return one([...document.querySelectorAll("#" + id)]);
    }
    if (target.kind === "sort") {
      const label = target.value?.match(/^(初防|初伤|初灵|初血|初敏) ASC$/)?.[1];
      if (!label) throw new Error("unsupported:market-sort");
      const cell = one(
        [...document.querySelectorAll("#search_result th")].filter((node) =>
          new RegExp(`^\\s*${label}\\s*[↑↓▲▼△▽]?\\s*$`).test(text(node)),
        ),
      );
      const links = [...cell.querySelectorAll("a")].filter(visible);
      return links.length === 1 ? links[0] : cell;
    }
    if (target.kind === "market-entry") {
      const path = paths[target.category];
      if (!path) throw new Error("unsupported:market-category");
      return one(
        [...document.querySelectorAll("a[href]")].filter((a) => {
          const u = new URL(a.href);
          return u.origin === location.origin && u.pathname + u.search === path;
        }),
      );
    }
    if (target.kind === "market-reset-server")
      return one([...document.querySelectorAll("#btn_reset_user_server")]);
    if (target.kind === "market-reset") return one([...document.querySelectorAll("#reset_all")]);
    if (target.kind === "market-submit") {
      if (category() !== target.category) throw new Error("stale:market-category");
      const id = {
        equipment: "btn_equip_search",
        pet: "btn_pet_search",
        "pet-gear": "btn_do_query",
        jewelry: "btn_lingshi_search",
        yuanshen: "btn_yuanshen_search",
        jade: "btn_yupo_search",
      }[target.category];
      return one([...document.querySelectorAll("#" + id)]);
    }
    if (target.kind === "market-field") {
      if (
        !fieldIds.has(target.field) ||
        typeof target.value !== "string" ||
        target.value.length > 80 ||
        [...target.value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("unsupported:market-field");
      const node = one(
        [...document.querySelectorAll("input, select")].filter(
          (el) => el.id === target.field && !el.disabled,
        ),
      );
      if (
        node instanceof HTMLInputElement &&
        !["text", "number", "search", "checkbox", "radio"].includes(node.type)
      )
        throw new Error("unsupported:market-field-type");
      if (
        node instanceof HTMLSelectElement &&
        ![...node.options].some((option) => option.value === target.value)
      )
        throw new Error("unsupported:market-option");
      return node;
    }
    if (target.kind === "market-choice") {
      if (
        !panels.has(target.panel) ||
        !Array.isArray(target.values) ||
        target.values.length !== 1 ||
        !/^[\w.,-]{1,80}$/.test(target.values[0])
      )
        throw new Error("unsupported:market-panel");
      return one(
        choices(target.panel, globals)
          .filter((choice) => choice.value === target.values[0])
          .map((choice) => choice.node),
      );
    }
    if (target.kind === "market-page") {
      if (!Number.isInteger(target.page) || target.page < 1)
        throw new Error("unsupported:market-page");
      return one(
        [...document.querySelectorAll("#pager_bar a, #pager a")].filter(
          (a) => text(a) === String(target.page),
        ),
      );
    }
    if (target.kind === "market-level-handle") {
      if (category() !== target.category || !["minimum", "maximum"].includes(target.handle))
        throw new Error("stale:slider-category");
      const id = target.category === "jewelry" ? "equip_level_slider" : "level_slider",
        options = globals?.marketSliders?.[id];
      if (
        !options ||
        !Array.isArray(options.range) ||
        options.range.length !== 2 ||
        ![target.value, options.grid, options.step, ...options.range].every(Number.isFinite) ||
        options.step <= 0 ||
        options.grid <= 0 ||
        target.value < options.range[0] ||
        target.value > options.range[1] ||
        (target.value - options.range[0]) % options.step !== 0
      )
        throw new Error("unsupported:slider-value");
      return one([
        ...document.querySelectorAll(
          `#${id} .${target.handle === "minimum" ? "startPoint" : "endPoint"}`,
        ),
      ]);
    }
    if (target.kind === "market-level")
      throw new Error("unsupported:slider-plan-must-use-bounded-handles");
    throw new Error("unsupported:market-operation");
  }
  function sliderProof(target, node, globals) {
    if (target.kind !== "market-level-handle") return undefined;
    const id = target.category === "jewelry" ? "equip_level_slider" : "level_slider",
      container = document.getElementById(id),
      options = globals.marketSliders?.[id];
    const original = node.getBoundingClientRect(),
      outer = container.getBoundingClientRect(),
      current = Number(text(node.querySelector(".num")).match(/\d+/)?.[0]);
    if (!Number.isFinite(current)) throw new Error("unsupported:slider-current-value");
    const rect = {
      x: target.handle === "minimum" ? original.x : original.right - 4,
      y: original.y,
      width: 4,
      height: original.height,
    };
    const from = { x: rect.x + 2, y: rect.y + rect.height / 2 },
      to = { x: from.x + ((target.value - current) / options.step) * options.grid, y: from.y };
    if (
      ![to.x, to.y].every(Number.isFinite) ||
      to.x < outer.left ||
      to.x > outer.right ||
      to.y < outer.top ||
      to.y > outer.bottom
    )
      throw new Error("unsupported:slider-endpoint-outside-control");
    return {
      rect,
      slider: {
        id,
        current,
        requested: target.value,
        minimum: options.range[0],
        maximum: options.range[1],
        step: options.step,
        grid: options.grid,
        from,
        to,
        container: { x: outer.x, y: outer.y, width: outer.width, height: outer.height },
      },
    };
  }
  function snapshot(globals, business) {
    const kind = category();
    if (!kind) return undefined;
    const args = globals.CurSearchValue?.arg || globals.QueryArgs || {};
    const conditions = {};
    for (const [key, value] of Object.entries(args))
      if (
        !["page", "order_by", "act", "search_type"].includes(key) &&
        !/cookie|token|password|fingerprint|authorization|session|signature|^fp$|^sign$/i.test(
          key,
        ) &&
        ["string", "number"].includes(typeof value)
      )
        conditions[key] = value;
    const pager = text(document.querySelector("#pager_bar, #pager")),
      page = Number(pager.match(/第\s*(\d+)\s*页/)?.[1] || args.page || 1);
    const rows = [
      ...document.querySelectorAll("#search_result a.soldImg[href], #soldList a.soldImg[href]"),
    ]
      .filter(
        (a) =>
          visible(a) &&
          (() => {
            try {
              const u = new URL(a.href);
              return (
                u.origin === location.origin &&
                u.pathname === "/equip" &&
                /^\d+$/.test(u.searchParams.get("s") || "") &&
                /^[\w-]+$/.test(u.searchParams.get("eid") || "")
              );
            } catch {
              return false;
            }
          })(),
      )
      .map((a) => {
        const image = a.querySelector("img");
        return {
          url: a.href,
          name:
            a.getAttribute("data_equip_name") ||
            image?.getAttribute("data_equip_name") ||
            image?.getAttribute("alt") ||
            text(a),
          kindId: a.getAttribute("data_kindid") || image?.getAttribute("data_kindid") || undefined,
          modelId:
            a.getAttribute("data_equip_type") ||
            image?.getAttribute("data_equip_type") ||
            undefined,
          level: a.getAttribute("data_equip_level") || undefined,
          description: a.getAttribute("data_equip_desc") || undefined,
        };
      });
    const empty = /没有符合条件/.test(
      text(document.querySelector("#query_result, #search_result")),
    );
    const last = business.at(-1),
      loading = [...document.querySelectorAll("#loading_img,.loading")].some(visible);
    const orderInfo = globals.CurSearchValue?.order_by;
    const order =
      orderInfo &&
      typeof orderInfo === "object" &&
      typeof orderInfo.key === "string" &&
      /^(?:ASC|DESC)$/i.test(String(orderInfo.sort || ""))
        ? `${orderInfo.key} ${String(orderInfo.sort).toUpperCase()}`
        : typeof args.order_by === "string"
          ? args.order_by
          : "";
    const requestOrder = typeof last?.orderBy === "string" ? last.orderBy : "";
    const normalized = (value) =>
      JSON.stringify(
        Object.entries(value || {})
          .filter(
            ([key]) => !["page", "order_by", "act", "search_type", "callback", "_"].includes(key),
          )
          .map(([key, item]) => [key, String(item)])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    const actions = {
      equipment: "overall_search_equip",
      pet: "overall_search_pet",
      "pet-gear": "overall_search_pet_equip",
      jewelry: "overall_search_lingshi",
      jade: "yupo_search",
    };
    const actualAction = last?.act === "recommd_by_role" ? last.searchType : last?.act;
    const categoryMatches =
      kind === "yuanshen"
        ? typeof actualAction === "string" && /^(?!show_)[a-z_]*yuanshen[a-z_]*$/.test(actualAction)
        : actualAction === actions[kind];
    const committed =
      categoryMatches &&
      !loading &&
      last?.success === true &&
      (!last.page || last.page === page) &&
      normalized(last.conditions) === normalized(conditions);
    const config = globals.marketConfig || {};
    const label = (node) =>
      node.getAttribute("aria-label") ||
      text(node.labels?.[0]) ||
      text(node.closest("tr")?.querySelector("th")) ||
      node.getAttribute("placeholder") ||
      "";
    const publicControls = [...document.querySelectorAll("input,select,textarea")].filter(
      (node) =>
        fieldIds.has(node.id) ||
        crossServerFields.includes(node.id) ||
        ["user_serverid", "cross_buy_serverid", "crossbuy_serverid", "buy_serverid"].includes(
          node.name,
        ),
    );
    const menuRecords = [...panels]
      .map((id) => {
        const values = choices(id, globals),
          root = document.getElementById(id) || values[0]?.node;
        return root
          ? {
              id,
              tag: root.tagName,
              label: label(root),
              visible: visible(root),
              choices: values.map(({ node, ...choice }) => ({ ...choice, visible: visible(node) })),
            }
          : null;
      })
      .filter(Boolean);
    const expanded = {};
    for (const [key, id] of [
      ["pet-skills", "pet_skill_wrap"],
      ["equipment-special-skills", "special_skill_panel"],
    ]) {
      const root = document.getElementById(id),
        rows = root ? [...root.querySelectorAll("li")] : [];
      const clipped = [root, ...(root ? [...root.querySelectorAll(".js_include_pet_skill")] : [])]
        .filter(Boolean)
        .some((node) => {
          const style = getComputedStyle(node);
          return /hidden|clip/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
        });
      expanded[key] = !!root && rows.length > 0 && !clipped && rows.every(visible);
    }
    const form = {
      hiddenControls: [...document.querySelectorAll('input[type="hidden"]')]
        .filter(
          (node) => crossServerFields.includes(node.id) || crossServerFields.includes(node.name),
        )
        .map((node) => ({ id: node.id, name: node.name, value: node.value })),
      url: location.origin + paths[kind],
      controls: publicControls.map((node) => ({
        id: node.id,
        name: node.name || "",
        tag: node.tagName,
        type: node instanceof HTMLSelectElement ? "select" : node.type || "text",
        label: label(node),
        value:
          node.type === "checkbox" || node.type === "radio" ? String(node.checked) : node.value,
        visible: visible(node),
        ...(node instanceof HTMLSelectElement
          ? {
              options: [...node.options].map((option) => ({
                value: option.value,
                label: text(option),
              })),
            }
          : {}),
      })),
      menus: menuRecords,
      buttons: [...document.querySelectorAll("button,input,a")]
        .filter((node) =>
          [
            "reset_all",
            "btn_reset_user_server",
            "btn_equip_search",
            "btn_pet_search",
            "btn_do_query",
            "btn_lingshi_search",
            "btn_yuanshen_search",
            "btn_yupo_search",
            "btn_all_skill",
            "btn_all_special_skill",
          ].includes(node.id),
        )
        .map((node) => ({
          id: node.id,
          name: node.name || "",
          tag: node.tagName,
          type: node.type || "",
          label: text(node) || node.value || "",
          visible: visible(node),
        })),
      scripts: [...document.scripts].flatMap((node) => {
        try {
          const u = new URL(node.src);
          if (
            ![
              "https://xyq.cbg.163.com",
              "https://cbg-xyq.res.netease.com",
              "https://cbg.res.netease.com",
            ].includes(u.origin) ||
            !u.pathname.endsWith(".js")
          )
            return [];
          return [u.origin + u.pathname];
        } catch {
          return [];
        }
      }),
      sliders: ["level_slider", "equip_level_slider"].flatMap((id) => {
        const node = document.getElementById(id),
          options = globals.marketSliders?.[id];
        return node
          ? [
              {
                id,
                label: label(node),
                start: text(node.querySelector(".startPoint .num")),
                end: text(node.querySelector(".endPoint .num")),
                grid: typeof options?.grid === "number" ? options.grid : null,
                step: typeof options?.step === "number" ? options.step : null,
                range: Array.isArray(options?.range) ? options.range : null,
              },
            ]
          : [];
      }),
    };
    return {
      category: kind,
      page,
      totalPages: Number(pager.match(/共\s*(\d+)\s*页/)?.[1] || page),
      order,
      requestOrder,
      expanded,
      conditions,
      rows,
      empty,
      committed,
      config,
      form,
      menus: menuRecords.map((menu) => ({
        id: menu.id,
        choices: menu.choices.map(({ visible: _visible, ...choice }) => choice),
      })),
    };
  }
  function product(globals) {
    const excluded =
      '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [id$="TipsBox"], [role="tooltip"], .equip_tips';
    const find = (selector) =>
      [...document.querySelectorAll(selector)].filter(
        (node) => visible(node) && !node.closest(excluded),
      );
    const panels = find("#equip_desc_panel"),
      infos = find("#info_panel");
    const raw = globals.equip_info || globals.EquipInfo;
    if (!raw || panels.length !== 1 || infos.length !== 1) return undefined;
    const panel = panels[0],
      info = infos[0];
    let root = panel.parentElement;
    while (root && root !== document.body && !root.contains(info)) root = root.parentElement;
    if (
      !root ||
      root === document.body ||
      root === document.documentElement ||
      root.closest(excluded) ||
      !text(panel) ||
      /加载中|正在加载/.test(text(panel))
    )
      return undefined;
    const name =
      text(info)
        .match(/(?:^|\s)ID\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/i)?.[1]
        ?.trim() ||
      (typeof raw.equip_name === "string" && text(info).includes(raw.equip_name)
        ? raw.equip_name
        : "");
    let typeDescription = "";
    try {
      const metadata = JSON.parse(globals.modelMetadata?.[String(raw.equip_type)] || "null");
      if (metadata?.records?.some((record) => record.name && record.name !== raw.equip_name))
        return undefined;
      typeDescription =
        metadata?.records?.find((record) => typeof record.desc === "string")?.desc || "";
    } catch {
      return undefined;
    }
    const prices = [...info.querySelectorAll("[data_price], [data-price], .price")]
      .filter(
        (node) =>
          visible(node) && !node.closest(excluded) && !node.closest("#equip_price_addon_info"),
      )
      .map(
        (node) => node.getAttribute("data_price") || node.getAttribute("data-price") || text(node),
      );
    if (!prices.length) return undefined;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      body = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        node.parentElement &&
        visible(node.parentElement) &&
        !node.parentElement.closest(
          excluded + ", #equip_price_addon_info, script, style, nav, header, footer",
        )
      )
        body.push(node.textContent || "");
    }
    const observation = {
      name,
      tooltip: "",
      description: text(panel),
      typeDescription,
      prices,
      rawPrice:
        typeof raw.price === "number" ||
        (typeof raw.price === "string" && /^\d+(?:\.\d+)?$/.test(raw.price.trim()))
          ? Number(raw.price)
          : null,
      body: body.join("\n"),
      selling: raw.is_selling,
      productName: raw.equip_name,
      productId: raw.eid,
      serverId: raw.serverid ?? raw.server_id,
      modelId: raw.equip_type,
      kindId: raw.kindid,
    };
    return {
      kind: /召唤兽|宝宝/.test(typeDescription) ? "pet-gear" : "equipment",
      observation,
      directPanel: true,
    };
  }
  globalThis.__CBGMarketRules = {
    paths,
    fieldIds,
    crossServerFields,
    panels,
    select,
    sliderProof,
    snapshot,
    product,
  };
})();
