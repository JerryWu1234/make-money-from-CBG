// Independent test oracle: read original source arrays, not application fact readers.
// Missing or conflicting evidence stays null; reports containing source data stay local.
export const DIRECT_AUDIT_CONDITIONS = [
  { id: "C1", text: "总宝石数量大于等于20" },
  { id: "C2", text: "角色修为大于等于27" },
  { id: "C3", text: "角色修为大于等于21" },
  { id: "C4", text: "人物修炼等级总和大于等于26" },
  { id: "C5", text: "人物装备宝石总段数大于等于30" },
  { id: "C6", text: "攻击修炼当前等级大于等于12" },
];

const trainingNames = ["攻击修炼", "防御修炼", "法术修炼", "抗法修炼"];
const normalized = (name) => String(name).replace(/[：:\s]/g, "");
const uniqueNumber = (values) => {
  const unique = [...new Set(values)];
  return unique.length === 1 && Number.isSafeInteger(unique[0]) && unique[0] >= 0
    ? unique[0]
    : null;
};

export function directConditionOracle(record) {
  const detail = record.detail;
  const training = Object.fromEntries(trainingNames.map((name) => [name, []]));
  for (const [ti, tab] of (detail?.tabs || []).entries()) {
    if (!/^(人物|角色)(?:\/|$)/.test(tab.name)) continue;
    const observe = (name, value, path) => {
      const key = normalized(name);
      if (!trainingNames.includes(key)) return;
      const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value).trim());
      training[key].push({
        raw: value,
        current: match ? Number(match[1]) : null,
        cap: match ? Number(match[2]) : null,
        path,
      });
    };
    for (const [fi, field] of (tab.fields || []).entries())
      observe(field.name, field.value, `/detail/tabs/${ti}/fields/${fi}/value`);
    for (const [tableIndex, table] of (tab.tables || []).entries())
      for (const [ri, row] of table.entries())
        for (let ci = 0; ci < row.length - 1; ci++)
          observe(row[ci], row[ci + 1], `/detail/tabs/${ti}/tables/${tableIndex}/${ri}/${ci + 1}`);
  }
  const levels = Object.fromEntries(
    trainingNames.map((name) => {
      const entries = training[name];
      return [
        name,
        {
          current: uniqueNumber(entries.map((x) => x.current)),
          cap: uniqueNumber(entries.map((x) => x.cap)),
          evidence: entries,
        },
      ];
    }),
  );
  const sum = (values) =>
    values.every((value) => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
  const equipment = [];
  let classificationKnown = true;
  for (const [ti, tab] of (detail?.tabs || []).entries()) {
    if (!/^道具\/法宝(?:\s*\/|$)/.test(tab.name)) continue;
    for (const [ii, item] of (tab.items || []).entries()) {
      const category = item.category || "",
        location = item.location || "";
      // Archived CBG calls the four jewelry positions 人物装备 too. Position evidence
      // and explicit subtype distinguish them from the six ordinary character slots.
      if (
        /^role_using_equip_(?:187|188|189|190)$/.test(location) ||
        /[·/]\s*(?:戒指|耳饰|佩饰|手镯)$/.test(category)
      )
        continue;
      const character =
        /^role_using_equip_[1-6]$/.test(location) ||
        /^人物装备\s*[·/]\s*(?:武器|头盔|发钗|项链|饰品|腰带|衣服|铠甲|女衣|鞋子|鞋)$/.test(
          category,
        );
      if (!character) {
        if (category.startsWith("人物装备")) classificationKnown = false;
        continue;
      }
      const raw = item.description || item.tooltip || "";
      const stages = [...raw.matchAll(/锻炼等级\s*[:：]?\s*(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      equipment.push({
        name: item.name,
        index: item.index,
        gemLevel: uniqueNumber(stages),
        path: `/detail/tabs/${ti}/items/${ii}`,
        raw,
      });
    }
  }
  const complete =
    detail?.captureMode !== "body" &&
    detail?.equipmentCapture?.complete === true &&
    !detail.equipmentCapture.issues?.length;
  return {
    training: levels,
    trainingTotal: sum(trainingNames.map((name) => levels[name].current)),
    trainingCapTotal: sum(trainingNames.map((name) => levels[name].cap)),
    equipment,
    gemTotal: complete && classificationKnown ? sum(equipment.map((item) => item.gemLevel)) : null,
  };
}

export function expectedDirectAuditResults(oracle) {
  const compare = (value, threshold) => (value === null ? null : value >= threshold);
  return {
    C1: compare(oracle.gemTotal, 20),
    C2: compare(oracle.trainingTotal, 27),
    C3: compare(oracle.trainingTotal, 21),
    C4: compare(oracle.trainingTotal, 26),
    C5: compare(oracle.gemTotal, 30),
    C6: compare(oracle.training["攻击修炼"].current, 12),
  };
}

export function selectDirectAuditSamples(records) {
  const reviewed = records.map((record) => ({ ...record, oracle: directConditionOracle(record) }));
  const complete = reviewed.filter(
    (record) => record.oracle.gemTotal !== null && record.oracle.trainingTotal !== null,
  );
  const selected = new Map();
  const add = (record) => {
    if (record) selected.set(record.listing.key, record);
  };
  add(reviewed.find((record) => String(record.listing.name) === "46957901"));
  for (const total of [27, 28, 0])
    add(complete.find((record) => record.oracle.trainingTotal === total));
  for (const total of [18, 21]) add(complete.find((record) => record.oracle.gemTotal === total));
  add([...complete].sort((a, b) => b.oracle.gemTotal - a.oracle.gemTotal)[0]);
  add([...complete].sort((a, b) => b.oracle.trainingTotal - a.oracle.trainingTotal)[0]);
  return {
    available: records.length,
    independentlyKnown: complete.length,
    samples: [...selected.values()],
  };
}
