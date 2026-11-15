(() => {
  const key = Symbol.for("cbg.passive-observer.v1");
  if (window[key]) return;
  const own = [];
  const observationEpoch =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : String(Date.now());
  let eventSequence = 0;
  const safe = (fn) => {
    try {
      fn();
    } catch {
      /* Observation cannot change the site's behavior. */
    }
  };
  const emit = (value) =>
    safe(() => {
      if (["fetch", "xhr", "jsonp"].includes(value.kind) && !value.observedAt)
        value = { ...value, observedAt: new Date().toISOString() };
      if (["fetch", "xhr", "jsonp"].includes(value.kind) && !value.eventId)
        value = { ...value, eventId: `${observationEpoch}-${++eventSequence}` };
      const text = JSON.stringify(value, (name, item) =>
        /cookie|token|password|fingerprint|authorization|session|signature|^fp$|^sign$/i.test(name)
          ? undefined
          : item,
      );
      if (text.length <= 200000)
        window.postMessage({ channel: "cbg-passive-v1", value: JSON.parse(text) }, location.origin);
    });
  const endpoint = (value) => {
    try {
      const u = new URL(value, location.href);
      return u.origin === location.origin &&
        [
          "/cgi-bin/recommend.py",
          "/cgi-bin/query.py",
          "/cgi-bin/equipquery.py",
          "/cgi-bin/xyq_overall_search.py",
          "/cgi-bin/role_search.py",
        ].includes(u.pathname)
        ? u.pathname
        : null;
    } catch {
      return null;
    }
  };
  const summary = (value) => ({
    denial:
      Number.isInteger(value?.status) && typeof value.msg === "string"
        ? { status: value.status, msg: value.msg.slice(0, 200) }
        : undefined,
    success: value?.status === 0 && Array.isArray(value.msg),
    count: Array.isArray(value?.msg) ? value.msg.length : undefined,
  });
  function wrap(object, property, make) {
    const original = object[property];
    if (typeof original !== "function") return;
    const replacement = make(original);
    object[property] = replacement;
    own.push(() => {
      if (object[property] === replacement) object[property] = original;
    });
  }
  wrap(
    window,
    "fetch",
    (original) =>
      function (...args) {
        const result = Reflect.apply(original, this, args);
        const path = endpoint(typeof args[0] === "string" ? args[0] : args[0]?.url);
        if (path)
          result.then(
            (response) =>
              safe(() => {
                emit({ kind: "fetch", endpoint: path, status: response.status });
                if (Number(response.headers.get("content-length") || 0) > 200000) return;
                const copy = response.clone();
                const reader = copy.body?.getReader();
                if (!reader) return;
                void (async () => {
                  let size = 0,
                    chunks = [];
                  try {
                    while (true) {
                      const read = await reader.read();
                      if (read.done) break;
                      size += read.value.length;
                      if (size > 200000) {
                        await reader.cancel();
                        return;
                      }
                      chunks.push(read.value);
                    }
                    const bytes = new Uint8Array(size);
                    let at = 0;
                    for (const chunk of chunks) {
                      bytes.set(chunk, at);
                      at += chunk.length;
                    }
                    emit({
                      kind: "fetch",
                      endpoint: path,
                      status: response.status,
                      ...summary(JSON.parse(new TextDecoder().decode(bytes))),
                    });
                  } catch {
                    /* Keep the website response untouched. */
                  }
                })();
              }),
            () => {},
          );
        return result;
      },
  );
  const paths = new WeakMap();
  wrap(
    XMLHttpRequest.prototype,
    "open",
    (original) =>
      function (...args) {
        paths.set(this, endpoint(args[1]));
        return Reflect.apply(original, this, args);
      },
  );
  wrap(
    XMLHttpRequest.prototype,
    "send",
    (original) =>
      function (...args) {
        const path = paths.get(this);
        if (path)
          this.addEventListener(
            "loadend",
            () =>
              safe(() => {
                let data;
                if (this.responseType === "json") data = this.response;
                else if (
                  (!this.responseType || this.responseType === "text") &&
                  this.responseText.length <= 200000
                ) {
                  try {
                    data = JSON.parse(this.responseText);
                  } catch {
                    /* Unknown schema is evidence only. */
                  }
                }
                emit({ kind: "xhr", endpoint: path, status: this.status, ...summary(data) });
              }),
            { once: true },
          );
        return Reflect.apply(original, this, args);
      },
  );
  let ajaxOriginal;
  function installAjax() {
    if (
      typeof window.ajax_with_recommend !== "function" ||
      window.ajax_with_recommend === ajaxOriginal
    )
      return;
    const original = window.ajax_with_recommend;
    const replacement = function (options, ...rest) {
      if (!options || typeof options !== "object")
        return Reflect.apply(original, this, [options, ...rest]);
      const next = { ...options };
      for (const name of ["onSuccess", "onFailure"]) {
        const callback = options[name];
        next[name] = function (...args) {
          safe(() =>
            emit({
              kind: "jsonp",
              endpoint: "/cgi-bin/recommend.py",
              status: 200,
              page: Number(options.data?.page || 1),
              act: typeof options.data?.act === "string" ? options.data.act : "",
              searchType:
                typeof options.data?.search_type === "string" ? options.data.search_type : "",
              orderBy: typeof options.data?.order_by === "string" ? options.data.order_by : "",
              observedAt: new Date().toISOString(),
              conditions: Object.fromEntries(
                Object.entries(options.data || {}).filter(
                  ([key, value]) =>
                    !["act", "search_type", "page", "order_by", "callback", "_"].includes(key) &&
                    !/cookie|token|password|fingerprint|authorization|session|signature|^fp$|^sign$/i.test(
                      key,
                    ) &&
                    ["string", "number"].includes(typeof value),
                ),
              ),
              ...(name === "onSuccess" ? summary(args[0]) : { success: false }),
            }),
          );
          return typeof callback === "function" ? Reflect.apply(callback, this, args) : undefined;
        };
      }
      return Reflect.apply(original, this, [next, ...rest]);
    };
    ajaxOriginal = replacement;
    window.ajax_with_recommend = replacement;
    own.push(() => {
      if (window.ajax_with_recommend === replacement) window.ajax_with_recommend = original;
    });
  }
  function read() {
    safe(installAjax);
    safe(() => {
      const globals = {};
      const loginValues = [window.IsLogin, window.LoginInfo?.login];
      globals.authState = loginValues.some((value) => value === 0 || value === false)
        ? false
        : loginValues.some((value) => value === 1 || value === true)
          ? true
          : null;
      for (const name of ["CurSearchValue"])
        if (window[name] && typeof window[name] === "object") globals[name] = window[name];
      globals.marketSliders = {};
      for (const id of ["level_slider", "equip_level_slider"]) {
        const options = document.getElementById?.(id)?.slider?.options;
        if (
          options &&
          [
            options.grid,
            options.step,
            ...(Array.isArray(options.range) ? options.range : []),
          ].every((value) => typeof value === "number" && Number.isFinite(value))
        )
          globals.marketSliders[id] = {
            grid: options.grid,
            step: options.step,
            range: options.range,
          };
      }
      globals.marketConfig =
        typeof window.__CBGReadMarketConfig === "function"
          ? window.__CBGReadMarketConfig()
          : undefined;
      globals.marketMenus = {};
      for (const id of [
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
        "texing_panel",
        "high_neidan_panel",
        "low_neidan_panel",
      ]) {
        const root = document.getElementById?.(id);
        if (!root) continue;
        globals.marketMenus[id] = [...root.querySelectorAll("li")]
          .filter((node) => !node.querySelector("li"))
          .map((node, index) => {
            const stored =
              node.getAttribute("data_value") ??
              node.getAttribute("data-value") ??
              node.retrieve?.("value");
            return {
              index,
              tag: node.tagName,
              id: node.id,
              label: node.textContent?.trim() || "",
              value: ["string", "number"].includes(typeof stored) ? String(stored) : "",
            };
          });
      }
      // Only product/query data. Never enumerate window, storage, cookies or login objects.
      for (const name of [
        "QueryArgs",
        "QueryResult",
        "EquipInfo",
        "RoleInfo",
        "RoleData",
        "role_info",
        "role_data",
        "equip_info",
      ]) {
        const value = window[name];
        if (value && typeof value === "object") globals[name] = value;
      }
      if (typeof EquipInfo !== "undefined" && EquipInfo && typeof EquipInfo === "object")
        globals.EquipInfo = EquipInfo;
      if (typeof equip !== "undefined" && equip && typeof equip === "object")
        globals.equip_info = equip;
      const info = globals.EquipInfo || globals.equip_info;
      const models = {};
      let resolver;
      safe(() => {
        if (typeof RoleNameConf === "function") resolver = new RoleNameConf();
      });
      const ids = new Set(
        [...(document.querySelectorAll?.("[data_equip_type], [data-equip-type]") || [])].map(
          (node) => node.getAttribute("data_equip_type") || node.getAttribute("data-equip-type"),
        ),
      );
      if (info?.equip_type) ids.add(String(info.equip_type));
      for (const modelId of ids) {
        if (!/^[1-9]\d*$/.test(modelId || "") || models[modelId]) continue;
        const records = [];
        for (const value of [
          (typeof CBG_GAME_CONFIG !== "undefined" ? CBG_GAME_CONFIG : window.CBG_GAME_CONFIG)
            ?.equip_info?.[modelId],
          resolver?.get_equip_info?.(Number(modelId)),
        ]) {
          if (value && typeof value === "object")
            records.push({
              name: typeof value.name === "string" ? value.name : undefined,
              desc: typeof value.desc === "string" ? value.desc : undefined,
              category: typeof value.category === "string" ? value.category : undefined,
            });
        }
        if (records.length) models[modelId] = JSON.stringify({ modelId, records });
      }
      globals.modelMetadata = models;
      const encoded = document.querySelector("#equip_desc_value, #pet_desc")?.value;
      safe(() => {
        if (!encoded) return;
        const decoded =
          typeof window.decode_desc === "function" ? window.decode_desc(encoded) : encoded;
        const pet =
          typeof decoded === "string" &&
          !decoded.trimStart().startsWith("{") &&
          !decoded.trimStart().startsWith("[") &&
          decoded.split(";").length >= 29 &&
          typeof window.get_pet_attrs_info === "function"
            ? window.get_pet_attrs_info(decoded, { only_basic_attr: true })
            : JSON.parse(decoded);
        if (
          pet &&
          Array.isArray(pet.all_skills) &&
          Array.isArray(pet.neidan) &&
          Array.isArray(pet.equip_list)
        )
          globals.parsedPet = pet;
        globals.StorageStype = { pet: window.StorageStype?.pet };
        const config = window.CBG_GAME_CONFIG || {};
        const payloads = [
          pet.evol_skill_list,
          pet.evol_skills,
          pet.other?.EvolSkill,
          pet.other?.evol_skills,
        ];
        const ids = new Set(
          [
            ...(pet.all_skills || []).map(String),
            String(pet.sp_skill_id || pet.sp_skill || "0"),
            ...payloads.flatMap((value) =>
              Array.isArray(value)
                ? value.map((row) => String(row && typeof row === "object" ? row.skill_type : row))
                : typeof value === "string"
                  ? value.split("|")
                  : [],
            ),
          ].filter((id) => /^[1-9]\d*$/.test(id)),
        );
        const mappings = {};
        const initialIds = Array.from(ids);
        for (const id of initialIds) {
          const mapping = config.pet_skill_high_to_other_level_mapping?.[id];
          if (mapping && typeof mapping === "object") {
            mappings[id] = {
              high_skill: mapping.high_skill,
              low_skill: mapping.low_skill,
              super_skill: mapping.super_skill,
              name: mapping.name,
            };
            for (const value of [mapping.high_skill, mapping.low_skill, mapping.super_skill])
              if (/^[1-9]\d*$/.test(String(value))) ids.add(String(value));
          }
        }
        const skills = {};
        for (const id of ids)
          if (typeof config.pet_skill_desc?.[id]?.name === "string")
            skills[id] = { name: config.pet_skill_desc[id].name };
        globals.petConfig = {
          CBG_GAME_CONFIG: {
            pet_skill_desc: skills,
            pet_skill_high_to_other_level_mapping: mappings,
            pet_info: { [String(pet.type_id)]: config.pet_info?.[String(pet.type_id)] },
          },
        };
      });
      if (
        info &&
        typeof window.decode_desc === "function" &&
        typeof window.RoleInfoParser === "function" &&
        encoded
      ) {
        const parser = new window.RoleInfoParser(window.decode_desc(encoded), {
          resUrl: window.ResUrl,
          serverId: String(info.server_id || ""),
        });
        const raw = parser.raw_info,
          school = parser.conf?.skill?.school_skill;
        if (raw?.AllEquip && typeof raw.AllEquip === "object" && !Array.isArray(raw.AllEquip)) {
          const allEquip = {};
          for (const slot of ["1", "2", "3", "4", "5", "6"]) {
            const item = raw.AllEquip[slot];
            if (item && typeof item === "object" && !Array.isArray(item))
              allEquip[slot] = {
                iType: item.iType,
                cDesc: item.cDesc,
                ...(Object.hasOwn(item, "obj_level") ? { obj_level: item.obj_level } : {}),
              };
          }
          globals.wornEquipment = {
            serverId: String(info.server_id || ""),
            eid: String(info.eid || ""),
            allEquip,
          };
        }
        if (raw && typeof raw === "object")
          globals.valuationSource = {
            riders: raw.AllRider ?? {},
            advancedMount: raw.jinjie_rider_info ?? { isJinJie: 0 },
            artifact: raw.shenqi ?? null,
            hasArtifact: parser.result?.shenqi !== false,
            idEffects: raw.idbid_desc ?? null,
            goldIdFlag: parser.result?.basic_info?.is_gold_id,
            assets: {
              iCash: raw.iCash,
              iSaving: raw.iSaving,
              iLearnCash: raw.iLearnCash,
              xianyu: raw.xianyu,
            },
            allSkills: raw.all_skills,
            holyLevel: raw.i3FlyLv,
            serverId: String(info.server_id || ""),
            eid: String(info.eid || ""),
            ...(school && raw.all_skills
              ? {
                  schoolSkills: Object.entries(raw.all_skills)
                    .filter(([id]) => Object.hasOwn(school, id))
                    .map(([id, level]) => ({
                      id,
                      level,
                      name: school[id]?.name,
                      slot: school[id]?.pos,
                    })),
                }
              : {}),
          };
      }
      if (encoded && info && globalThis.crypto?.subtle) {
        const seen = new WeakSet();
        const passive = (value) => {
          if (value === null || ["string", "number", "boolean"].includes(typeof value))
            return value;
          if (["undefined", "bigint", "symbol"].includes(typeof value))
            return { type: typeof value, value: String(value) };
          if (seen.has(value)) return { cycle: true };
          seen.add(value);
          return {
            definition:
              typeof value === "function" ? Function.prototype.toString.call(value) : null,
            properties: Object.entries(Object.getOwnPropertyDescriptors(value))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, descriptor]) => [
                name,
                "value" in descriptor
                  ? { value: passive(descriptor.value) }
                  : {
                      get:
                        typeof descriptor.get === "function"
                          ? Function.prototype.toString.call(descriptor.get)
                          : null,
                      set:
                        typeof descriptor.set === "function"
                          ? Function.prototype.toString.call(descriptor.set)
                          : null,
                    },
              ]),
          };
        };
        const version = JSON.stringify({
          serverId: info.server_id,
          eid: info.eid,
          encoded,
          parser: passive(window.RoleInfoParser),
          decode: passive(window.decode_desc),
          config: passive(
            typeof CBG_GAME_CONFIG === "undefined" ? window.CBG_GAME_CONFIG : CBG_GAME_CONFIG,
          ),
          names: passive(typeof RoleNameConf === "undefined" ? window.RoleNameConf : RoleNameConf),
        });
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(version)).then(
          (digest) => {
            globals.productRevision = [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            emit({ kind: "render", globals });
          },
          () => emit({ kind: "render", globals }),
        );
      } else emit({ kind: "render", globals });
    });
  }
  const timer = setInterval(read, 1000);
  read();
  const stop = () => {
    clearInterval(timer);
    for (const cleanup of own.reverse()) safe(cleanup);
    delete window[key];
  };
  window.addEventListener("pagehide", stop, { once: true });
  window[key] = { stop };
})();
