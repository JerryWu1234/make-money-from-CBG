(() => {
  if (globalThis.__cbgIsolatedObserver) return;
  const pageId = crypto.randomUUID();
  let generation = 1,
    globals = {},
    hasMainRender = false,
    business = [],
    revision = 0,
    lastUrl = location.href,
    lastFingerprint = "";
  const nodes = new Map();
  let stopped = true,
    observing = false,
    lifecycle = 0,
    observerToken = null,
    timer = null,
    delayed = null,
    lastSentAt = 0,
    pending = false,
    actionContext = null,
    bindingContext = null,
    listCommitSequence = 0,
    lastListCommit = null,
    marketAction = null;
  const marketRequests = new Map();
  const trustedClick = (event) => {
    if (
      !event.isTrusted ||
      !marketAction ||
      marketAction.actionId !== actionContext?.actionId ||
      !event.composedPath().includes(marketAction.node)
    )
      return;
    marketAction.activationTime = event.timeStamp;
    marketAction.activatedAt = new Date().toISOString();
    marketAction.requestId = null;
    marketAction.responseEventId = null;
  };
  const visible = (el) =>
    el instanceof HTMLElement &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const text = (el) => (el?.innerText || el?.textContent || "").trim();
  const allowed = () =>
    location.origin === "https://xyq.cbg.163.com" &&
    !/login|pay|order|purchase|account/i.test(location.pathname);
  const MAIN_TABS = [
    "人物/修炼",
    "技能",
    "道具/法宝",
    "召唤兽/孩子",
    "坐骑",
    "锦衣/外观",
    "玩家之家",
  ];
  function rootNode() {
    const first = [...document.querySelectorAll("a,li,span,button")].find(
      (el) => visible(el) && text(el) === MAIN_TABS[0],
    );
    if (!first) return null;
    let root = first.parentElement;
    while (root?.parentElement && text(root).length < 160) root = root.parentElement;
    return root;
  }
  function contentText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const values = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!visible(node.parentElement) || !node.textContent?.trim()) continue;
      let excluded = false;
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (
          el.matches(
            'nav,header,script,style,textarea,[role="tooltip"],[id$="TipsBox"],[data-cbg-hover-tip]',
          ) ||
          new Set(
            [...el.querySelectorAll("a,button,li")]
              .map(text)
              .filter((value) => MAIN_TABS.includes(value)),
          ).size >= 4
        ) {
          excluded = true;
          break;
        }
      }
      const value = node.textContent.trim();
      if (!excluded && !MAIN_TABS.includes(value)) values.push(value);
    }
    return values.join("\n");
  }
  function attrs(el) {
    const result = {};
    const ancestors = [];
    for (let node = el, depth = 0; node && depth < 3; node = node.parentElement, depth++)
      ancestors.unshift(node);
    for (const node of ancestors)
      for (const attr of node.attributes)
        if (/^(data[-_]|alt$|title$)/.test(attr.name))
          result[attr.name.replace(/^data-/, "data_")] = attr.value;
    const container = el.closest("[data-equip-location], [data_equip_location], [id]");
    if (container)
      result.data_equip_location ||=
        container.getAttribute("data-equip-location") ||
        container.getAttribute("data_equip_location") ||
        container.id;
    return result;
  }
  const entries = (root, section) =>
    !root
      ? []
      : [
          ...root.querySelectorAll(
            section === "pet"
              ? 'img[data_idx][src*="/pets/small/"], img[data-idx][src*="/pets/small/"], [data-pet-id], #pet_list li, #summon_list li, .pet_list li'
              : section === "mount"
                ? "#RoleRiders img[data_idx]"
                : "[data-child-id], .child_list li",
          ),
        ].filter(visible);
  const selected = (values) => {
    const found = values.findIndex(
      (el) =>
        el.getAttribute("aria-selected") === "true" ||
        /(?:^|\s)(?:active|selected|on|current)(?:\s|$)/.test(el.className || "") ||
        /(?:^|\s)(?:active|selected|on|current)(?:\s|$)/.test(el.parentElement?.className || ""),
    );
    return found < 0 ? null : found;
  };
  const itemNodes = (root) =>
    root
      ? [...root.querySelectorAll("img, [data_equip_name], [data-equip-name]")].filter(
          (el) =>
            visible(el) &&
            (el.tagName === "IMG" || !el.querySelector("img")) &&
            !el.closest('[role="tooltip"], [id$="TipsBox"]') &&
            !/\/pets\/(?:big|small)\//.test(el.getAttribute("src") || "") &&
            !/time_lock_/.test(el.getAttribute("src") || ""),
        )
      : [];
  function capture(force = false) {
    if (!observing || stopped || !allowed()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastFingerprint = "";
      generation++;
      nodes.clear();
      globals = {};
      hasMainRender = false;
      business = [];
      marketAction = null;
      marketRequests.clear();
    }
    const body = document.body?.innerText || "";
    const pager = text(document.querySelector("#pager_bar"));
    const page = Number(pager.match(/第\s*(\d+)\s*页/)?.[1] || globals.QueryArgs?.page || 1);
    const items = [...document.querySelectorAll("#soldList a.soldImg[href]")].map((a, index) => ({
      href: a.href,
      attrs: attrs(a),
      summary: a.querySelector("textarea")?.value || null,
      raw:
        globals.QueryResult?.find((item) => String(item.game_ordersn) === attrs(a).data_ordersn) ||
        globals.QueryResult?.[index] ||
        {},
    }));
    const raw = {};
    const marketSnapshot = globalThis.__CBGMarketRules?.snapshot(
      globals,
      business,
      marketAction?.actionId === actionContext?.actionId ? marketAction : null,
    );
    for (const name of [
      "EquipInfo",
      "RoleInfo",
      "RoleData",
      "role_info",
      "role_data",
      "equip_info",
    ])
      if (globals[name]) raw[name] = globals[name];
    const identities = [globals.EquipInfo, globals.equip_info].filter(
      (value) => value && typeof value === "object" && !Array.isArray(value),
    );
    const identityConflict =
      identities.length > 1 &&
      identities.some(
        (value) =>
          String(value.server_id || value.serverid || "") !==
            String(identities[0].server_id || identities[0].serverid || "") ||
          String(value.eid || "") !== String(identities[0].eid || ""),
      );
    const identity = identityConflict ? null : identities[0];
    const root = rootNode();
    const mainNodes = root
      ? [...root.querySelectorAll("a,li,span,button")].filter(
          (el) =>
            visible(el) &&
            MAIN_TABS.includes(text(el)) &&
            ![...el.children].some((child) => text(child) === text(el)),
        )
      : [];
    const childNodes = root
      ? [...root.querySelectorAll('[role="tab"], [data-tab], .tab a, .tabs a')].filter(
          (el) =>
            visible(el) &&
            !MAIN_TABS.includes(text(el)) &&
            text(el).length < 30 &&
            !/^https?:|^\//.test(el.getAttribute("href") || ""),
        )
      : [];
    const tabNodes = [...new Set([...mainNodes, ...childNodes])];
    const activeNodes = tabNodes.filter(
      (el) =>
        el.getAttribute("aria-selected") === "true" ||
        /(?:^|\s)(?:active|selected|on|current)(?:\s|$)/.test(el.className || "") ||
        /(?:^|\s)(?:active|selected|on|current)(?:\s|$)/.test(el.parentElement?.className || ""),
    );
    const active = activeNodes.find((el) => MAIN_TABS.includes(text(el)));
    const subactive = activeNodes.find((el) => !MAIN_TABS.includes(text(el)));
    const tabName = text(active) + (subactive ? " / " + text(subactive) : "");
    const fields = root
      ? [...root.querySelectorAll("tr")].filter(visible).flatMap((tr) => {
          const cells = [...tr.querySelectorAll("th,td")].map(text);
          return cells.length === 2 ? [{ name: cells[0], value: cells[1] }] : [];
        })
      : [];
    const icons = itemNodes(root),
      elements = icons.slice(0, 300).map((el, index) => {
        const a = attrs(el);
        a.data_cbg_observed_index = String(index);
        if (globals.modelMetadata?.[a.data_equip_type])
          a.data_official_model_metadata = globals.modelMetadata[a.data_equip_type];
        return a;
      });
    const equipmentContainers = [
      "RoleUsingEquips",
      "RoleStoreEquips",
      "RoleSplitEquips",
      "RoleYuHun",
    ].map((id) => {
      const node = root?.querySelector("#" + id);
      return {
        id,
        present: !!node,
        visible: visible(node),
        icons: (node
          ? [...node.querySelectorAll("img, [data_equip_name], [data-equip-name]")].filter(
              (el) =>
                (el.tagName === "IMG" || !el.querySelector("img")) &&
                !/time_lock_/.test(el.getAttribute("src") || ""),
            )
          : []
        ).map((el) => {
          const a = attrs(el);
          return { name: a.data_equip_name || "", modelId: a.data_equip_type || "" };
        }),
      };
    });
    const petEntries = entries(root, "pet"),
      mountEntries = entries(root, "mount"),
      childEntries = entries(root, "child");
    const petCount = text(root).match(/召唤兽\s*[（(]\s*(\d+)\s*\/\s*\d+\s*[）)]/);
    const controls = {
      tabs: [...new Set(tabNodes.map(text).filter((name) => MAIN_TABS.includes(name)))],
      subtabs: [...new Set(tabNodes.map(text).filter((name) => name && !MAIN_TABS.includes(name)))],
      pets: petEntries.map((node, index) => ({
        index,
        name: node.getAttribute("alt") || text(node) || `召唤兽${index + 1}`,
      })),
      mounts: mountEntries.map((node, index) => ({
        index,
        name: node.getAttribute("alt") || text(node) || `坐骑${index + 1}`,
      })),
      children: childEntries.map((node, index) => ({
        index,
        name: text(node) || `孩子${index + 1}`,
      })),
      petCount: petCount ? Number(petCount[1]) : null,
      selectedPet: selected(petEntries),
      selectedMount: selected(mountEntries),
      selectedChild: selected(childEntries),
      items: elements.map((a, index) => ({
        index,
        name: a.data_equip_name || a.alt || "",
        modelId: a.data_equip_type || "",
        location: a.data_equip_location || "",
      })),
    };
    let petProof;
    if (root && text(active) === "召唤兽/孩子") {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
        nodes = [];
      while (walker.nextNode())
        if (visible(walker.currentNode.parentElement)) nodes.push(walker.currentNode);
      let markerIndex = -1;
      nodes.forEach((node, index) => {
        if (/详细信息/.test(node.textContent || "")) markerIndex = index;
      });
      if (markerIndex >= 0) {
        const range = document.createRange(),
          marker = nodes[markerIndex];
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
        const selectedNodes = nodes
          .slice(markerIndex + 1)
          .filter((node) => range.intersectsNode(node));
        const body = selectedNodes
          .map((node) => node.textContent?.trim() || "")
          .filter(Boolean)
          .join("\n");
        const petElements = icons
          .filter((node) => range.intersectsNode(node))
          .map((node) => {
            const a = attrs(node);
            a.data_cbg_observed_index = String(icons.indexOf(node));
            const section = selectedNodes
              .filter(
                (textNode) =>
                  (textNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
              )
              .map((textNode) => textNode.textContent?.trim() || "")
              .filter((label) =>
                /^(?:赐福技能|(?:召唤兽)?技能|内丹)(?:\s*[（(]\d+[）)])?$/.test(label),
              )
              .at(-1)
              ?.replace(/\s*[（(]\d+[）)]$/, "");
            if (section) a.data_cbg_skill_section = section;
            if (globals.modelMetadata?.[a.data_equip_type])
              a.data_official_model_metadata = globals.modelMetadata[a.data_equip_type];
            return a;
          });
        const counts = { skills: 0, equipment: 0, innerSkills: 0 };
        for (const a of petElements) {
          if (a.data_skill_type === "neidan") counts.innerSkills++;
          else if (a.data_skill_type) counts.skills++;
          else if (a.data_equip_name || a.data_tip_box || a.data_equip_desc) counts.equipment++;
        }
        const has = (name) =>
          new RegExp(`(?:^|\\n)\\s*(?:召唤兽|宝宝)?${name}(?:\\s*[（(:：]|\\s*$)`, "m").test(
            body,
          ) || new RegExp(`(?:无|没有|暂无)(?:宝宝)?${name}`).test(body);
        const declared = (name) => {
          const match = body.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*[（(]\\s*(\\d+)\\s*[）)]`));
          return match ? Number(match[1]) : null;
        };
        petProof = {
          text: body,
          elements: petElements,
          counts,
          sections: {
            skills: counts.skills > 0 || has("技能"),
            equipment: counts.equipment > 0 || has("装备"),
            innerSkills: counts.innerSkills > 0 || has("内丹"),
          },
          declared: {
            skills: declared("技能"),
            equipment: declared("装备"),
            innerSkills: declared("内丹"),
          },
          loading: /正在(?:加载|读取)|加载中|展开全部(?:技能|装备|内丹)/.test(body),
        };
      }
    }
    const formValues = {};
    const roleQueryControls = {};
    const roleQueryDimensions = {};
    const roleServerControls = [
      ...document.querySelectorAll(
        'form input[name="serverid"],form select[name="serverid"],input#serverid,select#serverid',
      ),
    ].filter(visible);
    if (roleServerControls.length === 1) roleQueryDimensions.serverid = roleServerControls[0].value;
    else if (roleServerControls.length > 1) roleQueryDimensions.serverid = "unsupported";
    const roleAgeLabels = ["1年以内服", "1到3年服", "3年以上服"];
    const roleAgeOptions = ["#server_type", "#server_type_panel"]
      .map((selector) => [...document.querySelectorAll(`${selector} li`)].filter(visible))
      .filter((options) => options.length > 0);
    if (roleAgeOptions.length === 1)
      roleQueryDimensions.server_type = roleAgeOptions[0]
        .filter((node) => node.classList.contains("on"))
        .map((node) =>
          String(
            roleAgeLabels.indexOf(text(node).replace(/\s/g, "").replace("1年内服", "1年以内服")) +
              1,
          ),
        )
        .sort()
        .join(",");
    else if (roleAgeOptions.length > 1) roleQueryDimensions.server_type = "unsupported";
    for (const field of ["price_min", "price_max", "level_min", "level_max"]) {
      const controls = [
        ...document.querySelectorAll(`form input[name="${field}"],input#${field}`),
      ].filter(
        (node) =>
          visible(node) &&
          ["text", "number", "search"].includes(node.type) &&
          !node.disabled &&
          !node.readOnly &&
          !node.closest('[inert],[aria-disabled="true"]'),
      );
      if (controls.length === 1) {
        const node = controls[0];
        roleQueryControls[field] = {
          value: node.value,
          min: node.min,
          max: node.max,
          step: node.step || (node.type === "number" ? "1" : "any"),
        };
      }
    }
    for (const field of [
      "price_min",
      "price_max",
      "level_min",
      "level_max",
      ...(globalThis.__CBGMarketRules?.fieldIds || []),
      ...(globalThis.__CBGMarketRules?.crossServerFields || []),
    ]) {
      const input =
        document.getElementById(field) || document.querySelector(`form input[name="${field}"]`);
      if (input)
        formValues[field] =
          input.type === "checkbox" || input.type === "radio" ? String(input.checked) : input.value;
    }
    for (const id of ["level_slider", "equip_level_slider"]) {
      const slider = document.getElementById(id);
      if (slider) {
        formValues.level_min =
          text(slider.querySelector(".startPoint .num")).match(/\d+/)?.[0] || "";
        formValues.level_max = text(slider.querySelector(".endPoint .num")).match(/\d+/)?.[0] || "";
      }
    }
    const valuationSource = globals.valuationSource
      ? {
          ...globals.valuationSource,
          collectedAt: new Date().toISOString(),
          askingPrice: text(root)
            .match(/价格[：:]\s*[￥¥]\s*([\d,.]+)/)?.[1]
            ?.replaceAll(",", ""),
        }
      : undefined;
    let marketProduct;
    try {
      const pet = globals.parsedPet ? globalThis.__CBGPetProductObservation?.(globals) : undefined;
      marketProduct = pet
        ? { kind: "pet", observation: pet }
        : globalThis.__CBGMarketRules?.product(globals);
    } catch {
      /* Missing principal-product evidence stays unavailable to the validator. */
    }
    if (identityConflict) marketProduct = undefined;
    const infoPanels = [
      ...document.querySelectorAll("#info_panel, #equip_info, .equipInfo"),
    ].filter(
      (node) =>
        visible(node) && !node.closest("#recommend,.recommend,#bottomRecommands,#search_result"),
    );
    const states = infoPanels.flatMap((node) =>
      [...text(node).matchAll(/(?:是否上架|(?:^|\n)\s*状态)\s*[：:]?\s*(\S+)/g)].map(
        (match) => match[1],
      ),
    );
    const productState =
      states.length === 1
        ? ["已上架", "上架中"].includes(states[0])
          ? "selling"
          : /已下架|已售出|已删除|不存在/.test(states[0])
            ? "unavailable"
            : "unknown"
        : "unknown";
    const associated = nodes.get(actionContext?.actionId),
      targetRect = associated?.node?.isConnected ? associated.node.getBoundingClientRect() : null;
    const hasLogout = [...document.querySelectorAll('a[href*="act=logout"]')].some(
      (node) => visible(node) && new URL(node.href).origin === location.origin,
    );
    const hasLogin = [
      ...document.querySelectorAll('#loginContainer,#qrcode,input[type="password"]'),
    ].some(visible);
    const authenticated =
      globals.authState === false || hasLogin
        ? false
        : globals.authState === true && hasLogout
          ? true
          : undefined;
    const snapshot = {
      pageId,
      pageGeneration: generation,
      observedAt: new Date().toISOString(),
      url: location.href.split("#")[0],
      title: document.title,
      revision: `${pageId}:${generation}:${revision}`,
      visible: document.visibilityState === "visible",
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio },
      loading:
        !hasMainRender ||
        document.readyState !== "complete" ||
        [
          ...document.querySelectorAll(
            ".loading, #loading, #LoadingCover, #LoadingImg, #loading_img",
          ),
        ].some(visible),
      access: [
        ...document.querySelectorAll(
          ".yidun_popup,.geetest_panel,#captcha_container,#ajax_guard_ne_captcha",
        ),
      ].some(visible)
        ? "verification"
        : globals.authState === false ||
            [...document.querySelectorAll("#loginContainer,#qrcode,input[type=password]")].some(
              visible,
            )
          ? "login"
          : /系统繁忙|访问过于频繁|请求过于频繁/.test(body)
            ? "busy"
            : hasMainRender
              ? "normal"
              : "unknown",
      listing:
        hasMainRender && document.querySelector("#soldList") && !marketSnapshot
          ? {
              page,
              totalPages: Number(pager.match(/共\s*(\d+)\s*页/)?.[1] || page),
              order: String(globals.QueryArgs?.order_by || ""),
              serverType: String(globals.QueryArgs?.server_type || ""),
              items,
            }
          : undefined,
      productIdentity: identity
        ? {
            serverId: String(identity.server_id || identity.serverid || ""),
            eid: String(identity.eid || ""),
          }
        : undefined,
      detail: root
        ? {
            url: location.href,
            collectedAt: new Date().toISOString(),
            tabs: [
              {
                name: tabName || "未知标签",
                text: text(root),
                contentText: contentText(root),
                fields: [
                  ...fields,
                  ...text(root)
                    .split(/\n|\t/)
                    .flatMap((line) => {
                      const match = line.trim().match(/^([^：:]{1,40})[：:]\s*(.+)$/);
                      return match ? [{ name: match[1].trim(), value: match[2].trim() }] : [];
                    }),
                ],
                equipmentContainers,
                tables: [...root.querySelectorAll("table")].map((table) =>
                  [...table.rows].map((row) => [...row.cells].map(text)),
                ),
                elements,
                tooltips: [...document.querySelectorAll('[role="tooltip"], [id$="TipsBox"]')]
                  .filter(visible)
                  .map(text),
              },
            ],
            raw,
            productText: text(root),
          }
        : undefined,
      controls,
      formValues,
      roleQueryControls,
      roleQueryDimensions,
      valuationSource,
      wornEquipment: globals.wornEquipment,
      petProof,
      actionContext,
      bindingContext,
      productRevision: globals.productRevision,
      market: marketSnapshot,
      marketProduct,
      productState,
      authenticated: hasMainRender ? authenticated : undefined,
      targetObservation: targetRect
        ? {
            actionId: actionContext.actionId,
            rect: {
              x: targetRect.x,
              y: targetRect.y,
              width: targetRect.width,
              height: targetRect.height,
            },
          }
        : undefined,
      empty: /没有符合条件/.test(text(document.querySelector("#query_result"))),
      business: business.slice(-12),
      queryArgs: globals.QueryArgs || {},
      listingCommit: lastListCommit,
    };
    snapshot.listingCommitted =
      !!snapshot.listing &&
      !snapshot.loading &&
      Number(globals.QueryArgs?.page || page) === page &&
      Array.isArray(globals.QueryResult) &&
      globals.QueryResult.length === items.length &&
      (items.length > 0 || snapshot.empty);
    const fingerprint = JSON.stringify(snapshot, (name, value) =>
      ["observedAt", "receivedAt", "collectedAt", "revision"].includes(name) ? undefined : value,
    );
    const now = Date.now(),
      changed = fingerprint !== lastFingerprint;
    if (changed) {
      lastFingerprint = fingerprint;
      revision++;
      snapshot.revision = `${pageId}:${generation}:${revision}`;
    }
    if (!changed && !force && now - lastSentAt < 4000) return;
    lastSentAt = now;
    chrome.runtime.sendMessage({ kind: "snapshot", payload: snapshot }).catch(() => {});
    clearTimeout(timer);
    const epoch = lifecycle;
    timer = setTimeout(() => {
      timer = null;
      if (observing && !stopped && epoch === lifecycle) {
        mainControl("capture");
        capture(true);
      }
    }, 4000);
  }

  const changed = (records) => {
    if (!observing || stopped) return;
    if (
      Array.isArray(records) &&
      records.some((record) => {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const sold = element?.closest("#soldList");
        const rootReplaced =
          record.type === "childList" &&
          [...record.addedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.id === "soldList" || node.querySelector("#soldList")),
          );
        return (
          rootReplaced ||
          (sold &&
            (record.type === "childList" ||
              (record.type === "attributes" &&
                /^(href|data[-_])/.test(record.attributeName || ""))))
        );
      })
    )
      lastListCommit = {
        actionId: actionContext?.actionId || null,
        sequence: ++listCommitSequence,
      };
    if (!pending) {
      pending = true;
      const epoch = lifecycle;
      delayed = setTimeout(() => {
        delayed = null;
        pending = false;
        if (observing && !stopped && epoch === lifecycle) {
          mainControl("capture");
          capture();
        }
      }, 100);
    }
  };
  const observer = new MutationObserver(changed);
  const mainControl = (command, force = false) =>
    window.postMessage(
      { channel: "cbg-observer-control-v1", command, token: observerToken, force },
      location.origin,
    );
  const passiveMessage = (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== "cbg-passive-v1" ||
      !observing ||
      stopped ||
      event.data.observerToken !== observerToken
    )
      return;
    try {
      if (JSON.stringify(event.data).length > 220000) return;
      const value = event.data.value;
      if (value?.kind === "render") {
        globals = value.globals || {};
        hasMainRender = true;
        capture();
      } else if (
        ["fetch", "xhr", "jsonp"].includes(value?.kind) &&
        [
          "/cgi-bin/recommend.py",
          "/cgi-bin/query.py",
          "/cgi-bin/equipquery.py",
          "/cgi-bin/xyq_overall_search.py",
          "/cgi-bin/role_search.py",
        ].includes(value.endpoint)
      ) {
        if (value.phase === "request") {
          if (
            !marketAction?.requestId &&
            marketAction?.activationTime === value.activationTime &&
            Number.isFinite(value.activationTime) &&
            typeof value.requestId === "string" &&
            value.requestId.length <= 150 &&
            Date.parse(value.startedAt) >= Date.parse(marketAction.activatedAt)
          ) {
            marketRequests.set(value.requestId, {
              actionId: marketAction.actionId,
              queryId: marketAction.queryId,
              startedAt: value.startedAt,
              activationTime: value.activationTime,
            });
            marketAction.requestId = value.requestId;
            if (marketRequests.size > 32) marketRequests.delete(marketRequests.keys().next().value);
          }
          capture();
          return;
        }
        const request = marketRequests.get(value.requestId);
        marketRequests.delete(value.requestId);
        const owned =
          !!request &&
          request.actionId === marketAction?.actionId &&
          request.queryId === marketAction?.queryId &&
          request.startedAt === value.startedAt &&
          request.activationTime === value.activationTime;
        const observed = {
          kind: value.kind,
          endpoint: value.endpoint,
          denial: value.denial,
          act: value.act,
          searchType: value.searchType,
          status: Number(value.status),
          success: value.success === true,
          count: value.count,
          page: value.page,
          orderBy: value.orderBy,
          observedAt: value.observedAt,
          eventId: value.eventId,
          conditions: value.conditions,
          requestId: value.requestId,
          startedAt: value.startedAt,
          resultRows: value.resultRows,
          ...(owned ? { actionId: request.actionId, queryId: request.queryId } : {}),
        };
        business.push(observed);
        if (owned && value.phase === "response" && typeof value.eventId === "string") {
          marketAction.responseEventId = value.eventId;
          marketAction.requestId = value.requestId;
          marketAction.startedAt = request.startedAt;
          marketAction.completedAt = value.observedAt;
        }
        if (business.length > 12) business.shift();
        capture();
      }
    } catch {
      /* MAIN evidence is untrusted and cannot authorize control. */
    }
  };
  const mainReady = (event) => {
    if (
      observing &&
      !stopped &&
      event.source === window &&
      event.origin === location.origin &&
      event.data?.channel === "cbg-observer-control-v1" &&
      event.data.command === "ready"
    )
      mainControl("bind");
  };
  window.addEventListener("message", mainReady);
  function suspend() {
    const token = observerToken;
    observing = false;
    stopped = true;
    lifecycle++;
    clearTimeout(timer);
    timer = null;
    clearTimeout(delayed);
    delayed = null;
    pending = false;
    observer.disconnect();
    for (const name of ["input", "change", "scroll"])
      document.removeEventListener(name, changed, true);
    document.removeEventListener("click", trustedClick, true);
    window.removeEventListener("message", passiveMessage);
    nodes.clear();
    marketAction = null;
    marketRequests.clear();
    actionContext = null;
    if (token) mainControl("stop");
  }
  function start() {
    suspend();
    observerToken = crypto.randomUUID();
    observing = true;
    stopped = false;
    lifecycle++;
    globals = {};
    hasMainRender = false;
    business = [];
    lastListCommit = null;
    lastFingerprint = "";
    lastSentAt = 0;
    for (const name of ["input", "change", "scroll"])
      document.addEventListener(name, changed, { capture: true, passive: true });
    document.addEventListener("click", trustedClick, true);
    window.addEventListener("message", passiveMessage);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    mainControl("bind");
  }
  function select(plan) {
    const target = plan.target;
    if (target.kind === "scroll") {
      if (
        !target.toward ||
        target.toward.kind === "scroll" ||
        !Number.isFinite(target.deltaY) ||
        Math.abs(target.deltaY) > Math.min(innerHeight * 0.65, 800) ||
        Math.abs(target.deltaY) < 1
      )
        throw new Error("unsupported:unbounded-scroll");
      return select({ ...plan, target: target.toward });
    }
    if (target.kind === "return-to-list" || target.kind === "refresh-list") {
      const url = new URL(target.url);
      if (
        url.origin !== location.origin ||
        !["/cgi-bin/equipquery.py", "/cgi-bin/xyq_overall_search.py"].includes(url.pathname)
      )
        throw new Error("unsupported:return-url");
      const root =
        rootNode() ||
        document.querySelector(target.kind === "refresh-list" ? "#soldList" : "#info_panel");
      if (!root) throw new Error("unsupported:return-source");
      const node = [...root.querySelectorAll("a,button,li")].find(visible);
      if (!node) throw new Error("unsupported:return-proof");
      return node;
    }
    if (
      target.kind.startsWith("market-") ||
      (target.kind === "sort" && target.value.startsWith("初"))
    )
      return globalThis.__CBGMarketRules.select(target, globals);
    const one = (values) => {
      const matches = values.filter(visible);
      if (matches.length !== 1) throw new Error("unsupported:target-not-unique");
      return matches[0];
    };
    if (target.kind === "listing-detail")
      return one(
        [
          ...document.querySelectorAll("#soldList a.soldImg[href], #search_result a.soldImg[href]"),
        ].filter((a) => {
          const u = new URL(a.href);
          return (
            u.origin === location.origin &&
            u.pathname === "/equip" &&
            u.searchParams.get("s") === target.serverId &&
            u.searchParams.get("eid") === target.eid
          );
        }),
      );
    if (target.kind === "next-page") {
      const current = Number(
        text(document.querySelector("#pager_bar")).match(/第\s*(\d+)\s*页/)?.[1] ||
          globals.QueryArgs?.page,
      );
      if (current !== target.currentPage) throw new Error("stale:page");
      return one(
        [...document.querySelectorAll("#pager_bar a")].filter((a) => /^下一页$/.test(text(a))),
      );
    }
    if (target.kind === "jump-page") {
      const links = [...document.querySelectorAll("#pager_bar a")].filter(
        (node) => visible(node) && text(node) === String(target.page),
      );
      if (links.length === 1) return links[0];
      return one([
        ...document.querySelectorAll(
          '#pager_bar input[type="text"], #pager_bar input[type="number"]',
        ),
      ]);
    }
    if (target.kind === "detail-tab") {
      if (!MAIN_TABS.includes(target.name)) throw new Error("unsupported:tab");
      return one(
        [...document.querySelectorAll("a,li,span,button")].filter(
          (el) =>
            text(el) === target.name &&
            ![...el.children].some((child) => text(child) === target.name) &&
            !/^https?:|^\//.test(el.getAttribute("href") || ""),
        ),
      );
    }
    if (target.kind === "detail-subtab") {
      if (
        !MAIN_TABS.includes(target.parent) ||
        !target.name ||
        target.name.length > 30 ||
        /购买|支付|删除|还价|收藏/.test(target.name)
      )
        throw new Error("unsupported:subtab");
      const root = rootNode();
      if (!root) throw new Error("unsupported:detail-root");
      return one(
        [...root.querySelectorAll('[role="tab"], [data-tab], .tab a, .tabs a')].filter(
          (el) => text(el) === target.name && !/^https?:|^\//.test(el.getAttribute("href") || ""),
        ),
      );
    }
    if (target.kind === "detail-entry") {
      if (
        !["pet", "mount", "child"].includes(target.section) ||
        !Number.isInteger(target.index) ||
        target.index < 0 ||
        target.index >= 100
      )
        throw new Error("unsupported:entry");
      const values = entries(rootNode(), target.section);
      const node = values[target.index];
      if (
        !node ||
        (node.getAttribute("alt") ||
          text(node) ||
          `${target.section === "pet" ? "召唤兽" : target.section === "mount" ? "坐骑" : "孩子"}${target.index + 1}`) !==
          target.name
      )
        throw new Error("stale:entry");
      return node;
    }
    if (target.kind === "inspect-item") {
      const values = itemNodes(rootNode()),
        node = values[target.index];
      if (!node) throw new Error("stale:item");
      const a = attrs(node);
      if (
        (a.data_equip_name || a.alt || "") !== target.name ||
        (a.data_equip_type || "") !== target.modelId ||
        (a.data_equip_location || "") !== target.location
      )
        throw new Error("stale:item-identity");
      return node;
    }
    if (target.kind === "query")
      return one(
        [
          ...document.querySelectorAll(
            '#searchForm button[type="submit"], #searchForm input[type="submit"], #query_form button[type="submit"], #btn_search',
          ),
        ].filter((el) => /搜|查/.test(text(el) || el.value || "")),
      );
    if (target.kind === "query-field") {
      if (
        !["price_min", "price_max", "level_min", "level_max"].includes(target.field) ||
        !(target.field.startsWith("price_") ? /^\d{0,8}(?:\.\d{1,2})?$/ : /^\d{0,8}$/).test(
          target.value,
        )
      )
        throw new Error("unsupported:field");
      return one(
        [
          ...document.querySelectorAll(`form input[name="${target.field}"],input#${target.field}`),
        ].filter(
          (node) =>
            ["text", "number", "search"].includes(node.type) &&
            !node.disabled &&
            !node.readOnly &&
            !node.closest('[inert],[aria-disabled="true"]'),
        ),
      );
    }
    if (target.kind === "sort") {
      if (
        !["selling_time DESC", "expire_time DESC", "price ASC", "price DESC"].includes(target.value)
      )
        throw new Error("unsupported:sort");
      const field = target.value.split(" ")[0];
      const links = [...document.querySelectorAll("#order_menu a[data_attr_name]")].filter(
        (node) => node.getAttribute("data_attr_name") === field,
      );
      return links.length
        ? one(links)
        : one([...document.querySelectorAll('select[name="order_by"]')]);
    }
    throw new Error("unsupported:target");
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (["stop", "unbind"].includes(message.kind)) {
      if (message.observerToken !== undefined && message.observerToken !== observerToken) {
        reply({ ok: false, error: "stale-observer-token" });
        return;
      }
      suspend();
      reply({ ok: true });
      return;
    }
    if (message.kind === "capture") {
      if (message.observerToken !== undefined && message.observerToken !== observerToken) {
        reply({ ok: false, error: "stale-observer-token" });
        return;
      }
      if (observing && !stopped) {
        mainControl("capture", true);
        capture(true);
      }
      reply({ ok: true });
      return;
    }
    if (message.kind === "bind") {
      start();
      if (message.context)
        bindingContext = {
          recoveryEpoch: message.context.recoveryEpoch,
          stopEpoch: message.context.stopEpoch,
          browserSessionEpoch: message.context.browserSessionEpoch,
        };
      if (message.plan)
        actionContext = {
          actionId: message.plan.actionId,
          runId: message.plan.runId,
          queryId: message.plan.queryId,
          stopEpoch: message.plan.stopEpoch,
          browserSessionEpoch: message.plan.browserSessionEpoch,
        };
      capture(true);
      reply({ pageId, pageGeneration: generation, observerToken });
      return;
    }
    if (!["prepare", "revalidate", "locate"].includes(message.kind)) return;
    try {
      const plan = message.plan;
      if (message.kind !== "locate")
        actionContext = {
          actionId: plan.actionId,
          runId: plan.runId,
          queryId: plan.queryId,
          stopEpoch: plan.stopEpoch,
          browserSessionEpoch: plan.browserSessionEpoch,
        };
      if (
        stopped ||
        !allowed() ||
        !document.hasFocus() ||
        document.visibilityState !== "visible" ||
        plan.pageId !== pageId ||
        plan.pageGeneration !== generation
      )
        throw new Error("stale:page-or-focus");
      const node = select(plan),
        protectedSlider = globalThis.__CBGMarketRules?.sliderProof(plan.target, node, globals),
        observedRect = protectedSlider?.rect || node.getBoundingClientRect();
      if (message.kind === "locate") {
        if (
          observedRect.width <= 0 ||
          observedRect.height <= 0 ||
          observedRect.width > innerWidth ||
          observedRect.height > innerHeight ||
          observedRect.x < 0 ||
          observedRect.x + observedRect.width > innerWidth
        )
          throw new Error("unsupported:target-size-or-horizontal-position");
        const needsScroll =
          observedRect.y < 0 || observedRect.y + observedRect.height > innerHeight;
        const deltaY = Math.max(
          -Math.min(innerHeight * 0.6, 750),
          Math.min(
            Math.min(innerHeight * 0.6, 750),
            observedRect.y + observedRect.height / 2 - innerHeight / 2,
          ),
        );
        reply({
          ok: true,
          location: {
            needsScroll,
            deltaY,
            targetRect: {
              x: observedRect.x,
              y: observedRect.y,
              width: observedRect.width,
              height: observedRect.height,
            },
          },
        });
        return;
      }
      let rect = observedRect,
        scrollTarget;
      if (plan.target.kind === "scroll") {
        const center = { x: innerWidth / 2, y: innerHeight / 2 },
          anchor = document.elementFromPoint(center.x, center.y);
        if (!anchor || anchor.closest('.yidun_popup,.geetest_panel,[role="dialog"]'))
          throw new Error("unsupported:scroll-overlay");
        rect = { x: center.x - 8, y: center.y - 8, width: 16, height: 16 };
        scrollTarget = {
          semantic: plan.target.toward,
          rect: {
            x: observedRect.x,
            y: observedRect.y,
            width: observedRect.width,
            height: observedRect.height,
          },
          label: node.getAttribute("aria-label") || node.getAttribute("alt") || text(node),
          controlId: node.id,
          href: node instanceof HTMLAnchorElement ? node.href : undefined,
        };
      }
      if (message.kind === "revalidate" && nodes.get(plan.actionId)?.node !== node)
        throw new Error("stale:node");
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (
        !hit ||
        (plan.target.kind !== "scroll" && !(node === hit || node.contains(hit))) ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.width > innerWidth ||
        rect.y + rect.height > innerHeight
      )
        throw new Error("occluded:target");
      const proof = {
        actionId: plan.actionId,
        pageId,
        pageGeneration: generation,
        targetVersion: `${revision}:${text(node).slice(0, 80)}`,
        sampledAt: Date.now(),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          scrollX,
          scrollY,
          scale: visualViewport?.scale || 1,
        },
        semantic: plan.target,
        hit: true,
        url: location.href,
        title: document.title,
        scrollTarget,
        slider: protectedSlider?.slider,
        href: node instanceof HTMLAnchorElement ? node.href : undefined,
        control: {
          id: node.id,
          tagName: node.tagName,
          type: node.type || "",
          label:
            node.getAttribute("aria-label") ||
            node.getAttribute("placeholder") ||
            node.getAttribute("alt") ||
            text(node.labels?.[0]) ||
            text(node),
          className: typeof node.className === "string" ? node.className : "",
          ...(plan.target.kind === "market-choice" && plan.target.panel === "super_sum_star"
            ? {
                starIndex: [...document.querySelectorAll("input.js_super_sum_star[value]")].indexOf(
                  node,
                ),
                starValues: [...document.querySelectorAll("input.js_super_sum_star[value]")].map(
                  (entry) => entry.value,
                ),
              }
            : {}),
          value: node.value || "",
          optionIndex:
            node instanceof HTMLSelectElement
              ? [...node.options].findIndex((option) => option.value === plan.target.value)
              : undefined,
          optionLabel:
            node instanceof HTMLSelectElement
              ? [...node.options]
                  .find((option) => option.value === plan.target.value)
                  ?.textContent?.trim()
              : undefined,
        },
      };
      nodes.set(plan.actionId, { node, proof });
      if (
        ["market-submit", "market-page", "sort"].includes(plan.target.kind) &&
        marketAction?.actionId !== plan.actionId
      )
        marketAction = {
          actionId: plan.actionId,
          queryId: plan.queryId,
          node,
          activationTime: null,
          activatedAt: null,
          responseEventId: null,
          requestId: null,
        };
      if (nodes.size > 10) nodes.delete(nodes.keys().next().value);
      reply({ ok: true, proof });
    } catch (error) {
      reply({ ok: false, error: String(error.message || error) });
    }
  });
  window.addEventListener("pagehide", suspend);
  globalThis.__cbgIsolatedObserver = true;
})();
