(() => {
  const key = Symbol.for("cbg.passive-observer.v1");
  if (window[key]) return;
  const observationEpoch =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : String(Date.now());
  const own = new Set(),
    readers = new Set(),
    cache = new Map(),
    usedOptions = new WeakMap();
  let active = false,
    generation = 0,
    readSequence = 0,
    eventSequence = 0,
    requestSequence = 0;
  let activation = null,
    usedActivations = new WeakSet(),
    timer = null,
    scheduled = null,
    scheduledForce = false;
  let ajaxInstalled = false,
    lastRender = "",
    lastRenderAt = 0,
    bindingToken = null;
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      /* Observation cannot change website behavior. */
    }
  };
  const live = (epoch) => active && epoch === generation;
  const plain = (value) =>
    JSON.parse(
      JSON.stringify(value, (name, item) =>
        /cookie|token|password|fingerprint|authorization|session|signature|^fp$|^sign$/i.test(name)
          ? undefined
          : item,
      ),
    );
  const emit = (value, epoch = generation) =>
    safe(() => {
      if (!live(epoch)) return;
      if (["fetch", "xhr", "jsonp"].includes(value.kind) && !value.observedAt)
        value = { ...value, observedAt: new Date().toISOString() };
      if (["fetch", "xhr", "jsonp"].includes(value.kind) && !value.eventId)
        value = { ...value, eventId: `${observationEpoch}-${++eventSequence}` };
      const snapshot = plain(value),
        text = JSON.stringify(snapshot);
      if (text.length <= 200000 && live(epoch))
        window.postMessage(
          {
            channel: "cbg-passive-v1",
            lifecycle: epoch,
            observerToken: bindingToken,
            value: snapshot,
          },
          location.origin,
        );
    });
  const memo = (name, inputs, build, force = false, ttl = 1000) => {
    const previous = cache.get(name),
      now = Date.now();
    if (
      !force &&
      previous &&
      now >= previous.at &&
      now - previous.at < ttl &&
      inputs.length === previous.inputs.length &&
      inputs.every((value, index) => value === previous.inputs[index])
    )
      return previous.value;
    const value = build();
    cache.set(name, { inputs, value, at: now });
    return value;
  };
  // List consumers need row identity and listing timestamps, not detail descriptions.
  // Preserve every supported row; an unsupported result is absent, never a partial/empty proof.
  const listingRows = (value) =>
    safe(() => {
      if (!Array.isArray(value) || value.length > 1000) return undefined;
      const result = [];
      let size = 2;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const row = descriptor && "value" in descriptor ? descriptor.value : undefined;
        if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
        const projected = {};
        for (const name of [
          "game_ordersn",
          "eid",
          "server_id",
          "serverid",
          "serverId",
          "server_name",
          "selling_time",
          "create_time",
          "expire_time",
        ]) {
          const field = Object.getOwnPropertyDescriptor(row, name);
          if (!field || !("value" in field)) continue;
          const item = field.value;
          if (typeof item === "string") {
            if (item.length > 100000) return undefined;
            projected[name] = item;
          } else if (typeof item === "number" && Number.isFinite(item)) projected[name] = item;
        }
        size += JSON.stringify(projected).length + 1;
        if (size > 100000) return undefined;
        result.push(projected);
      }
      return result;
    });
  const render = (globals, epoch, sequence, force, url) => {
    if (!live(epoch) || sequence !== readSequence || url !== location.href) return;
    const snapshot = plain(globals),
      fingerprint = JSON.stringify(snapshot),
      now = Date.now();
    if (!force && fingerprint === lastRender && now - lastRenderAt < 4000) return;
    lastRender = fingerprint;
    lastRenderAt = now;
    emit({ kind: "render", globals: snapshot }, epoch);
  };
  const endpoint = (value) => {
    if (typeof value !== "string") return null;
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
  const summary = (value) => {
    const ownValue = (object, name) => {
      if (!object || typeof object !== "object") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const status = ownValue(value, "status"),
      message = ownValue(value, "msg");
    const count = Array.isArray(message) ? message.length : undefined;
    const field = (value) =>
      ["string", "number"].includes(typeof value) && /^[\w-]{1,200}$/.test(String(value))
        ? String(value)
        : undefined;
    return {
      denial:
        Number.isInteger(status) && typeof message === "string"
          ? { status, msg: message.slice(0, 200) }
          : undefined,
      success: status === 0 && Array.isArray(message),
      count,
      resultRows:
        Array.isArray(message) && count <= 1000
          ? Array.from({ length: count }, (_, index) => {
              const row = ownValue(message, String(index));
              return {
                eid: field(ownValue(row, "eid")),
                serverId: field(
                  ownValue(row, "server_id") ??
                    ownValue(row, "serverid") ??
                    ownValue(row, "serverId"),
                ),
                ordersn: field(ownValue(row, "game_ordersn")),
              };
            })
          : undefined,
    };
  };
  const clicked = (event) => {
    if (event.isTrusted) activation = event;
  };
  function wrap(object, property, make) {
    const descriptor = Object.getOwnPropertyDescriptor(object, property);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function" ||
      (!descriptor.configurable && !descriptor.writable)
    )
      return;
    const replacement = make(descriptor.value);
    Object.defineProperty(object, property, { ...descriptor, value: replacement });
    own.add(() => {
      const current = Object.getOwnPropertyDescriptor(object, property);
      if (current?.value === replacement) Object.defineProperty(object, property, descriptor);
    });
  }
  function installNetwork(epoch) {
    wrap(
      window,
      "fetch",
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (!live(epoch)) return result;
          safe(() => {
            const path = endpoint(typeof args[0] === "string" ? args[0] : undefined);
            if (!path || typeof result?.then !== "function") return;
            result.then(
              (response) =>
                safe(() => {
                  if (!live(epoch)) return;
                  emit({ kind: "fetch", endpoint: path, status: response.status }, epoch);
                  if (
                    Number(response.headers.get("content-length") || 0) > 200000 ||
                    readers.size >= 16
                  )
                    return;
                  const reader = response.clone().body?.getReader();
                  if (!reader) return;
                  readers.add(reader);
                  void (async () => {
                    let size = 0;
                    const chunks = [];
                    try {
                      while (live(epoch)) {
                        const next = await reader.read();
                        if (!live(epoch)) return;
                        if (next.done) break;
                        size += next.value.length;
                        if (size > 200000) {
                          await reader.cancel();
                          return;
                        }
                        chunks.push(next.value);
                      }
                      if (!live(epoch)) return;
                      const bytes = new Uint8Array(size);
                      let at = 0;
                      for (const chunk of chunks) {
                        bytes.set(chunk, at);
                        at += chunk.length;
                      }
                      emit(
                        {
                          kind: "fetch",
                          endpoint: path,
                          status: response.status,
                          ...summary(JSON.parse(new TextDecoder().decode(bytes))),
                        },
                        epoch,
                      );
                      scheduleRead();
                    } catch {
                      /* Keep the original response untouched. */
                    } finally {
                      readers.delete(reader);
                    }
                  })();
                }),
              () => {},
            );
          });
          return result;
        },
    );
    const paths = new WeakMap();
    wrap(
      XMLHttpRequest.prototype,
      "open",
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (live(epoch)) safe(() => paths.set(this, endpoint(args[1])));
          return result;
        },
    );
    wrap(
      XMLHttpRequest.prototype,
      "send",
      (original) =>
        function (...args) {
          let cleanup;
          if (live(epoch))
            safe(() => {
              const path = paths.get(this);
              if (!path) return;
              const done = () => {
                safe(() => {
                  if (!live(epoch)) return;
                  let data;
                  if (this.responseType === "json") data = this.response;
                  else if (
                    (!this.responseType || this.responseType === "text") &&
                    this.responseText.length <= 200000
                  )
                    safe(() => {
                      data = JSON.parse(this.responseText);
                    });
                  emit(
                    { kind: "xhr", endpoint: path, status: this.status, ...summary(data) },
                    epoch,
                  );
                  scheduleRead();
                });
                cleanup();
              };
              cleanup = () => {
                this.removeEventListener("loadend", done);
                own.delete(cleanup);
              };
              this.addEventListener("loadend", done, { once: true });
              own.add(cleanup);
            });
          try {
            return Reflect.apply(original, this, args);
          } catch (error) {
            safe(() => cleanup?.());
            throw error;
          }
        },
    );
  }
  function installAjax() {
    if (ajaxInstalled) return;
    const descriptor = Object.getOwnPropertyDescriptor(window, "ajax_with_recommend");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return;
    const epoch = generation;
    wrap(
      window,
      "ajax_with_recommend",
      (original) =>
        function (...args) {
          const options = args[0];
          if (!live(epoch) || !options || typeof options !== "object")
            return Reflect.apply(original, this, args);
          let record,
            instrumented = false;
          safe(() => {
            const previous = usedOptions.get(options);
            if (previous) {
              previous.abandoned = true;
              previous.restore();
              return;
            }
            const descriptors = Object.getOwnPropertyDescriptors(options),
              dataDescriptor = descriptors.data;
            if (
              !dataDescriptor ||
              !("value" in dataDescriptor) ||
              !dataDescriptor.value ||
              typeof dataDescriptor.value !== "object"
            )
              return;
            const callbacks = ["onSuccess", "onFailure"].filter(
              (name) =>
                descriptors[name] &&
                "value" in descriptors[name] &&
                typeof descriptors[name].value === "function",
            );
            if (
              !callbacks.length ||
              callbacks.some(
                (name) => !descriptors[name].writable || !descriptors[name].configurable,
              )
            )
              return;
            if (
              ["onSuccess", "onFailure"].some(
                (name) => descriptors[name] && !("value" in descriptors[name]),
              )
            )
              return;
            const fields = Object.getOwnPropertyDescriptors(dataDescriptor.value);
            if (Object.values(fields).some((field) => !("value" in field))) return;
            const data = Object.fromEntries(
              Object.entries(fields).map(([name, field]) => [name, field.value]),
            );
            const request = {
              requestId: `${observationEpoch}-request-${++requestSequence}`,
              startedAt: new Date().toISOString(),
              activationTime:
                activation?.eventPhase > 0 && !usedActivations.has(activation)
                  ? activation.timeStamp
                  : null,
              page: Number(data.page || 1),
              act: typeof data.act === "string" ? data.act : "",
              searchType: typeof data.search_type === "string" ? data.search_type : "",
              orderBy: typeof data.order_by === "string" ? data.order_by : "",
              conditions: Object.fromEntries(
                Object.entries(data).filter(
                  ([name, value]) =>
                    !["act", "search_type", "page", "order_by", "callback", "_"].includes(name) &&
                    !/cookie|token|password|fingerprint|authorization|session|signature|^fp$|^sign$/i.test(
                      name,
                    ) &&
                    ["string", "number"].includes(typeof value),
                ),
              ),
            };
            record = {
              abandoned: false,
              completed: false,
              replacements: {},
              restore: () => {
                for (const name of callbacks)
                  if (
                    Object.getOwnPropertyDescriptor(options, name)?.value ===
                    record.replacements[name]
                  )
                    Object.defineProperty(options, name, descriptors[name]);
                own.delete(record.restore);
              },
            };
            usedOptions.set(options, record);
            own.add(record.restore);
            for (const name of callbacks) {
              const callback = descriptors[name].value;
              const replacement = function (...values) {
                let completed = false,
                  evidence = { success: false };
                if (live(epoch) && !record.abandoned && !record.completed && name === "onSuccess")
                  safe(() => {
                    evidence = summary(values[0]);
                  });
                try {
                  const result = Reflect.apply(callback, this, values);
                  completed = true;
                  return result;
                } finally {
                  safe(() => {
                    if (live(epoch) && !record.abandoned && !record.completed) {
                      record.completed = true;
                      emit(
                        {
                          kind: "jsonp",
                          endpoint: "/cgi-bin/recommend.py",
                          phase: "response",
                          ...request,
                          status: 200,
                          observedAt: new Date().toISOString(),
                          ...evidence,
                          success: completed && evidence.success,
                        },
                        epoch,
                      );
                      scheduleRead();
                    }
                  });
                  safe(record.restore);
                }
              };
              record.replacements[name] = replacement;
              Object.defineProperty(options, name, { ...descriptors[name], value: replacement });
            }
            if (request.activationTime !== null) usedActivations.add(activation);
            emit(
              { kind: "jsonp", endpoint: "/cgi-bin/recommend.py", phase: "request", ...request },
              epoch,
            );
            instrumented = true;
          });
          if (record && !instrumented) {
            record.abandoned = true;
            safe(record.restore);
          }
          try {
            return Reflect.apply(original, this, args);
          } catch (error) {
            if (record) {
              record.abandoned = true;
              safe(record.restore);
            }
            throw error;
          }
        },
    );
    ajaxInstalled =
      Object.getOwnPropertyDescriptor(window, "ajax_with_recommend")?.value !== descriptor.value;
  }
  function scheduleRead(force = false) {
    if (!active) return;
    scheduledForce ||= force;
    if (scheduled !== null) return;
    const epoch = generation;
    scheduled = setTimeout(() => {
      scheduled = null;
      const wanted = scheduledForce;
      scheduledForce = false;
      if (live(epoch)) read(wanted);
    }, 0);
  }
  function read(force = false) {
    if (!active) return;
    const epoch = generation,
      sequence = ++readSequence,
      url = location.href;
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
          ? memo(
              "marketConfig",
              [window.__CBGReadMarketConfig, location.href],
              () => window.__CBGReadMarketConfig(),
              force,
              5000,
            )
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
      const resultRows = safe(() => listingRows(window.QueryResult));
      if (resultRows !== undefined) globals.QueryResult = resultRows;
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
        const parser = memo(
          "roleParser",
          [
            encoded,
            window.RoleInfoParser,
            window.decode_desc,
            window.ResUrl,
            String(info.server_id || ""),
            String(info.eid || ""),
          ],
          () =>
            new window.RoleInfoParser(window.decode_desc(encoded), {
              resUrl: window.ResUrl,
              serverId: String(info.server_id || ""),
            }),
          force,
        );
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
            riders: raw.AllRider,
            advancedMount: raw.jinjie_rider_info,
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
        const snapshot = plain(globals);
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(version)).then(
          (digest) => {
            snapshot.productRevision = [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            render(snapshot, epoch, sequence, force, url);
          },
          () => render(snapshot, epoch, sequence, force, url),
        );
      } else render(globals, epoch, sequence, force, url);
    });
  }
  function stop() {
    active = false;
    generation++;
    readSequence++;
    clearInterval(timer);
    timer = null;
    clearTimeout(scheduled);
    scheduled = null;
    scheduledForce = false;
    for (const reader of readers)
      safe(() => {
        void reader.cancel().catch(() => {});
      });
    readers.clear();
    for (const cleanup of [...own].reverse()) safe(cleanup);
    own.clear();
    cache.clear();
    activation = null;
    ajaxInstalled = false;
    lastRender = "";
    lastRenderAt = 0;
  }
  function start(token) {
    stop();
    bindingToken = token;
    active = true;
    generation++;
    usedActivations = new WeakSet();
    safe(() => {
      document.addEventListener("click", clicked, true);
      own.add(() => document.removeEventListener("click", clicked, true));
    });
    safe(() => installNetwork(generation));
    timer = setInterval(() => read(), 1000);
    read(true);
  }
  const control = (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== "cbg-observer-control-v1"
    )
      return;
    if (event.data.command === "bind" && typeof event.data.token === "string")
      start(event.data.token);
    else if (["stop", "unbind"].includes(event.data.command) && event.data.token === bindingToken)
      stop();
    else if (event.data.command === "capture" && event.data.token === bindingToken && active)
      scheduleRead(event.data.force === true);
  };
  window.addEventListener("message", control);
  window.addEventListener("pagehide", stop);
  window[key] = { stop };
  safe(() =>
    window.postMessage({ channel: "cbg-observer-control-v1", command: "ready" }, location.origin),
  );
})();
