import type { SavedRoleRecord } from "../crawler/types";
import type { Evidence } from "./types";
import type {
  AnalysisProfile,
  Decision,
  ValuationItem,
  ValuationResult,
  ValuationSettings,
} from "./valuation-types";

const TRAINING = [
  30, 50, 70, 95, 120, 140, 160, 185, 210, 240, 275, 310, 350, 400, 460, 500, 550, 610, 680, 760,
  850,
];
const PET_ATTACK = [
  40, 50, 65, 88, 120, 157, 200, 250, 310, 380, 460, 550, 660, 780, 910, 1050, 1200, 1360, 1530,
  1740, 2000,
];
const PET_DEFENSE = [
  30, 40, 51, 65, 85, 115, 150, 190, 235, 285, 340, 400, 470, 610, 770, 950, 1150, 1320, 1500, 1740,
  2000,
];
export function trainingPrice(
  level: number,
  kind: "attack" | "defense" | "petAttack" | "petDefense",
) {
  if (level === 0) return 0;
  if (!Number.isInteger(level) || level < 5 || level > 25) return null;
  if (kind === "defense") return level === 17 ? 230 : TRAINING[level - 5] / 1.5;
  return (kind === "attack" ? TRAINING : kind === "petAttack" ? PET_ATTACK : PET_DEFENSE)[
    level - 5
  ];
}
export const lifeSkillPrice = (level: number) => (level < 100 ? 0 : (level - 95) ** 1.175);
export const strengthPrice = (level: number, mode: "single" | "cumulative") =>
  mode === "single" ? level ** 3 / 270 : ((level * (level + 1)) / 2) ** 2 / 270;
export function schoolPrice(levels: number[], state: string, capConfirmed: boolean) {
  if (levels.length !== 7) return null;
  if (state === "已化圣")
    return levels.every((level) => level === 180) ? (7 * 30 ** 3.5) / 215 : null;
  if (state === "已渡劫")
    return levels.reduce((sum, level) => sum + (level > 150 ? (level - 150) ** 3.5 / 215 : 0), 0);
  if (state === "未飞升") {
    if (levels.some((level) => level > 130) && !capConfirmed) return null;
    return Math.max(
      250 -
        [...levels]
          .sort((a, b) => b - a)
          .slice(0, 6)
          .reduce((sum, x) => {
            const level = Math.min(x, 130);
            return sum + (-0.0148 * level ** 2 + 0.8566 * level + 138.762);
          }, 0),
      0,
    );
  }
  if (state === "已飞升")
    return Math.max(
      250 -
        [...levels]
          .sort((a, b) => b - a)
          .slice(0, 5)
          .reduce((sum, x) => sum + (150 - x) * (8.53 - 0.09 * (150 - x)), 0),
      0,
    );
  return null;
}
export function opportunityPrice(
  level: number,
  points: number,
  base: number | null,
  mode: ValuationSettings["opportunityMode"],
) {
  if (points < 40)
    return base === null ? null : (-Math.min(base, 10000) / 10000) * 20 * (40 - points);
  const l = Math.min(level, 109),
    d = points - 40;
  const formula = (0.4 + 0.005 * (l - 69)) * d ** 2 + (4 + 0.025 * (l - 69)) * d;
  if (level !== 69 || points === 40) return formula;
  const discrete: Record<number, number> = {
    40: 0,
    45: 30,
    50: 80,
    55: 180,
    60: 300,
    65: 430,
    69: 600,
  };
  if (mode === "discrete") return discrete[points] ?? null;
  if (mode === "formula" || discrete[points] === formula) return formula;
  return null;
}
export function artifactPrice(
  sets: { full: boolean | null; type: string; score: number | null }[],
) {
  if (
    sets.length > 3 ||
    sets.some(
      (set) =>
        set.full === null ||
        (set.full && (set.score === null || !Number.isFinite(set.score) || set.score < 0)),
    )
  )
    return null;
  const values = sets
    .map((set) => (set.full ? (set.type === "十二水" ? 1400 : 1000) * (set.score! / 91) ** 2.5 : 0))
    .sort((a, b) => b - a);
  return (values[0] || 0) + values.slice(1).reduce((sum, value) => sum + value / 2, 0);
}
export function mountPrice(
  growth: number,
  advanced: boolean,
  percentage: number | null,
  boundary: ValuationSettings["mountBoundary"],
) {
  if (!advanced) return growth === 2.343 ? 100 : 0;
  if (growth !== 2.35) return 0;
  if (percentage === null || percentage < 60 || percentage > 100) return null;
  if ((percentage === 70 || percentage === 80) && boundary === null) return null;
  if (percentage >= 90) return 400 + (percentage - 90) * 50 + (percentage - 90) ** 3;
  if (percentage < 70 || (percentage === 70 && boundary === "lower")) return 100;
  if (percentage < 80 || (percentage === 80 && boundary === "lower")) return 200;
  return 400;
}
const round = (value: number | null) =>
  value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100;
export const floorPrice = (value: number) =>
  Math.floor(value * 100 + Number.EPSILON * Math.max(1, Math.abs(value * 100))) / 100;
export function purchase(value: number | null, asking: number | null, settings: ValuationSettings) {
  const cost = asking !== null && settings.extraCost !== null ? asking + settings.extraCost : null;
  const limit =
    value !== null && value > 0 && settings.b !== null
      ? Math.min(value * settings.b, settings.budget ?? Infinity)
      : null;
  const ideal =
    value !== null && value > 0 && settings.a !== null
      ? Math.min(value * settings.a, settings.budget ?? Infinity)
      : null;
  const decision: Decision =
    value === null || value <= 0 || cost === null || limit === null
      ? "NEED_INFO"
      : cost <= limit
        ? "BUY"
        : cost <= value
          ? "WATCH"
          : "PASS";
  return {
    decision,
    total_cost: round(cost),
    max_listing_price:
      limit !== null && settings.extraCost !== null ? floorPrice(limit - settings.extraCost) : null,
    ideal_listing_price:
      ideal !== null && settings.extraCost !== null ? floorPrice(ideal - settings.extraCost) : null,
    margin_of_safety: value !== null && value > 0 && cost !== null ? 1 - cost / value : null,
  };
}

type Fact = { raw: string; evidence: Evidence[] };
function number(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
/** Decode saved, labelled fields, retaining the exact source path and text. */
export function calculateValuation(
  record: SavedRoleRecord,
  profile: AnalysisProfile,
): ValuationResult {
  const items: ValuationItem[] = [],
    missing = new Set<string>(),
    pending = new Set<string>();
  const settings = profile.settings,
    tabs = record.detail?.tabs || [];
  const fact = (label: string, tabName?: string): Fact | null => {
    for (const [ti, tab] of tabs.entries()) {
      if (tabName && tab.name !== tabName) continue;
      const fieldIndex = tab.fields.findIndex((field) => field.name === label);
      if (fieldIndex >= 0) {
        const raw = tab.fields[fieldIndex].value;
        return {
          raw,
          evidence: [
            {
              path: "/detail/tabs/" + ti + "/fields/" + fieldIndex + "/value",
              value: raw,
              reason: "原始采集字段：" + label,
            },
          ],
        };
      }
      for (const [tableIndex, table] of tab.tables.entries())
        for (const [rowIndex, row] of table.entries())
          for (const [cellIndex, cell] of row.entries()) {
            if (
              cell.replace(/[：:]\s*$/, "").trim() === label &&
              row[cellIndex + 1] !== undefined
            ) {
              const raw = row[cellIndex + 1];
              return {
                raw,
                evidence: [
                  {
                    path:
                      "/detail/tabs/" +
                      ti +
                      "/tables/" +
                      tableIndex +
                      "/" +
                      rowIndex +
                      "/" +
                      (cellIndex + 1),
                    value: raw,
                    reason: "原始采集字段：" + label,
                  },
                ],
              };
            }
          }
    }
    return null;
  };
  const add = (
    name: string,
    input: string,
    formula: string,
    amount: number | null,
    evidence: Evidence[] = [],
    problem = name + "所需字段",
  ) => {
    if (amount !== null && (!Number.isFinite(amount) || Math.abs(amount) > 1e12)) {
      amount = null;
      pending.add(name + "计算结果异常，需要核实输入");
    }
    if (amount === null && problem) missing.add(problem);
    items.push({ name, input, formula, amount, confirmed: amount !== null, evidence });
  };
  const asking = number(record.listing.price.replace(/[¥￥,\s]/g, ""));
  const empty: ValuationResult = {
    asking_price: asking,
    extra_cost: settings.extraCost,
    ...purchase(null, asking, settings),
    model_value: null,
    items,
    missing_fields: [],
    pending_rules: [],
    reason: "",
    next_action: "",
    known_subtotal: 0,
    calculation_version: profile.calculationVersion,
  };
  if (
    (record.listing.serverName || "").includes("时光") &&
    (record.listing.serverName || "").includes("花样年华")
  )
    return { ...empty, decision: "OUT_OF_SCOPE", reason: "时光-花样年华不适用本估值模型。" };
  if (!profile.calculationCompatible)
    return {
      ...empty,
      pending_rules: ["Prompt 的计价部分已修改，本地复算规则需要同步更新"],
      reason: "计价规则待同步，暂不能确认模型估值。",
      next_action: "同步服务端复算规则与 Prompt 的计价部分。",
    };
  const stateFact = fact("飞升/渡劫/化圣", "人物/修炼");
  const stateLabel = stateFact?.raw.match(/未飞升|已飞升|已渡劫|已化圣|飞升|渡劫|化圣/)?.[0];
  const state = stateLabel
    ? ["飞升", "渡劫", "化圣"].includes(stateLabel)
      ? "已" + stateLabel
      : stateLabel
    : null;
  add(
    "人物状态",
    stateFact?.raw || "未知",
    "只取当前状态一档：0 / 250 / 500 / 500",
    state === null ? null : state === "未飞升" ? 0 : state === "已飞升" ? 250 : 500,
    stateFact?.evidence,
  );
  const levelFact = fact("级别", "人物/修炼"),
    level = number(levelFact?.raw);
  const holyFact = fact("化圣层数", "人物/修炼"),
    holy = number(holyFact?.raw) ?? number(stateFact?.raw.match(/(\d+)\s*[层重]/)?.[1]);
  add(
    "化圣层级",
    state === "已化圣" ? String(holy ?? "未知") : state || "未知",
    "已化圣时 (层数 - 1) × 100；其他明确状态为 0",
    state === null
      ? null
      : state !== "已化圣"
        ? 0
        : holy !== null && holy >= 1 && holy <= 9
          ? (holy - 1) * 100
          : null,
    holyFact?.evidence || stateFact?.evidence,
  );
  const humanLabels = ["攻击修炼", "法术修炼", "防御修炼", "抗法修炼"];
  const humanFacts = humanLabels.map((label) => fact(label, "人物/修炼"));
  const human = humanFacts.map((value) => number(value?.raw.split("/")[0]));
  const caps = humanFacts.map((value) => number(value?.raw.split("/")[1]));
  const knownMax = human[0] !== null && human[1] !== null ? Math.max(human[0], human[1]) : null;
  add(
    "人物有效攻法修炼",
    humanFacts
      .slice(0, 2)
      .map((value) => value?.raw || "未知")
      .join(" / "),
    "攻击与法术取等级较高一项，按价表查价",
    knownMax === null ? null : trainingPrice(knownMax, "attack"),
    humanFacts.slice(0, 2).flatMap((value) => value?.evidence || []),
    "人物攻法修炼缺失或等级未覆盖",
  );
  for (const index of [2, 3])
    add(
      humanLabels[index],
      humanFacts[index]?.raw || "未知",
      "17级固定230；其余已列等级=攻法价/1.5",
      human[index] === null ? null : trainingPrice(human[index], "defense"),
      humanFacts[index]?.evidence,
      humanLabels[index] + "缺失或等级未覆盖",
    );
  for (const [index, label] of ["攻击控制力", "法术控制力", "防御控制力", "抗法控制力"].entries()) {
    const value = fact(label, "人物/修炼"),
      n = number(value?.raw);
    add(
      "召唤兽" + label,
      value?.raw || "未知",
      "四项分别按召唤兽修炼价表查价",
      n === null ? null : trainingPrice(n, index < 2 ? "petAttack" : "petDefense"),
      value?.evidence,
      label + "缺失或等级未覆盖（1—4级无定价）",
    );
  }
  const skillTabIndex = tabs.findIndex((tab) => tab.name === "技能"),
    skillTab = tabs[skillTabIndex];
  const skillItems = skillTab?.items || [];
  const school = skillItems.filter((item) => item.category === "师门技能");
  const skillProof = (index: number): Evidence[] => [
    {
      path: "/detail/tabs/" + skillTabIndex + "/items/" + index + "/level",
      value: skillItems[index].level || "",
      reason: "已采集技能等级",
    },
  ];
  const schoolLevels = school.map((item) => number(item.level));
  const schoolAmount =
    state && schoolLevels.every((value) => value !== null)
      ? schoolPrice(schoolLevels as number[], state, settings.schoolCapConfirmed)
      : null;
  add(
    "师门技能",
    school.map((item) => item.name + "=" + (item.level ?? "未知")).join("、") || "未知",
    "按当前状态公式，取最高六项/五项或七项逐项计值",
    schoolAmount,
    skillItems.flatMap((item, i) => (item.category === "师门技能" ? skillProof(i) : [])),
  );
  if (
    state === "未飞升" &&
    schoolLevels.some((value) => value !== null && value > 130) &&
    !settings.schoolCapConfirmed
  )
    pending.add("确认未飞升技能超过130级时先封顶再代入多项式");
  if (state === "已化圣" && schoolLevels.some((value) => value !== 180))
    pending.add("化圣状态与七项180级技能存在冲突");
  if (
    state === "已飞升" &&
    schoolLevels.some((value) => value !== null && (value > 150 || value < 56))
  )
    pending.add("飞升师门技能公式出现反常溢价，需核实适用范围");
  if (!skillTab || !Array.isArray(skillTab.items))
    add("生活技能", "未知", "各生活技能分别计价后求和", null);
  else
    skillItems.forEach((item, index) => {
      if (item.category === "师门技能" || ["强壮", "神速"].includes(item.name)) return;
      const n = number(item.level);
      add(
        "生活技能·" + item.name,
        item.level || "未知",
        "X<100 为0；否则 (X-95)^1.175",
        n === null ? null : lifeSkillPrice(n),
        skillProof(index),
      );
    });
  for (const name of ["强壮", "神速"]) {
    const index = skillItems.findIndex((item) => item.name === name),
      n = index >= 0 ? number(skillItems[index].level) : null;
    const amount =
      n === 0
        ? 0
        : n !== null && settings.strengthMode
          ? strengthPrice(n, settings.strengthMode)
          : null;
    add(
      name,
      n === null ? "未知" : String(n),
      settings.strengthMode === "cumulative"
        ? "Σ i³/270，i=1…X"
        : "X³/270（计价次数待确认时不取值）",
      amount,
      index >= 0 ? skillProof(index) : [],
    );
    if (n !== null && n > 0 && !settings.strengthMode)
      pending.add("确认强壮、神速按当前等级一次计价还是逐级累加");
  }
  const artifacts = fact("神器套数");
  add(
    "神器",
    artifacts?.raw || "完整套数、满槽状态和属性分值未知",
    "先核对12槽填满；最高一套全价，其余两套各半价",
    number(artifacts?.raw) === 0 ? 0 : null,
    artifacts?.evidence,
  );
  const mountCount = fact("坐骑总数"),
    mountGrowth = fact("成长", "坐骑"),
    advanced = fact("进阶状态", "坐骑"),
    percentage = fact("主属性百分比", "坐骑");
  const growth = number(mountGrowth?.raw),
    percent = number(percentage?.raw.replace("%", ""));
  const mountAmount =
    number(mountCount?.raw) === 0
      ? 0
      : number(mountCount?.raw) === 1 &&
          growth !== null &&
          ["已进阶", "未进阶"].includes(advanced?.raw || "")
        ? mountPrice(growth, advanced!.raw === "已进阶", percent, settings.mountBoundary)
        : null;
  add(
    "坐骑",
    [mountCount?.raw, mountGrowth?.raw, advanced?.raw, percentage?.raw]
      .map((value) => value || "未知")
      .join(" / "),
    "按成长、进阶和主属性百分比定价，核对完整坐骑数量",
    mountAmount,
    [mountCount, mountGrowth, advanced, percentage].flatMap((value) => value?.evidence || []),
  );
  const levelPrices: Record<number, number> = {
    170: 100,
    171: 180,
    172: 280,
    173: 400,
    174: 600,
    175: 1000,
  };
  let levelPremium: number | null = state === "未飞升" || state === "已飞升" ? 0 : null;
  if (state === "已渡劫" && level !== null) levelPremium = levelPrices[level] ?? null;
  if (state === "已化圣" && settings.holyLevelPremium !== null && level !== null)
    levelPremium = settings.holyLevelPremium ? (levelPrices[level] ?? null) : 0;
  if (state === "已化圣" && settings.holyLevelPremium === null)
    pending.add("确认化圣是否叠加渡劫等级溢价");
  add(
    "人物等级溢价",
    String(level ?? "未知") + " / " + (state || "未知"),
    "仅按已确认状态及170—175级价表计算",
    levelPremium,
    levelFact?.evidence,
  );
  const capAttack: Record<number, number> = { 21: 30, 22: 60, 23: 100, 24: 140, 25: 200 },
    capDefense: Record<number, number> = { 21: 20, 22: 40, 23: 65, 24: 90, 25: 130 };
  const selectedCap =
    human[0] !== null && human[1] !== null
      ? human[0] > human[1]
        ? 0
        : human[1] > human[0]
          ? 1
          : settings.capTie === "attack"
            ? 0
            : settings.capTie === "magic"
              ? 1
              : null
      : null;
  const attackCap =
    settings.capMode === "both" && caps[0] !== null && caps[1] !== null
      ? capAttack[caps[0]] !== undefined && capAttack[caps[1]] !== undefined
        ? capAttack[caps[0]] + capAttack[caps[1]]
        : null
      : settings.capMode === "effective" && selectedCap !== null && caps[selectedCap] !== null
        ? (capAttack[caps[selectedCap]!] ?? null)
        : null;
  add(
    "攻法修炼上限",
    caps
      .slice(0, 2)
      .map((value) => value ?? "未知")
      .join(" / "),
    "分别计价或有效攻法项，按确认口径查21—25上限价表",
    attackCap,
    humanFacts.slice(0, 2).flatMap((value) => value?.evidence || []),
  );
  if (!settings.capMode) pending.add("确认攻法上限分别计价还是只算有效攻法项");
  for (const index of [2, 3])
    add(
      humanLabels[index] + "上限",
      String(caps[index] ?? "未知"),
      "查21—25上限价表",
      caps[index] === null ? null : (capDefense[caps[index]!] ?? null),
      humanFacts[index]?.evidence,
    );
  const golden = fact("靓号特效", "人物/修炼");
  add(
    "土豪金ID",
    golden?.raw || "未知",
    "明确土豪金+1400；明确没有为0",
    golden?.raw.includes("土豪金") ? 1400 : golden?.raw === "否" ? 0 : null,
    golden?.evidence,
  );
  const baseComplete = items.every((item) => item.confirmed) && pending.size === 0;
  const base = baseComplete ? items.reduce((sum, item) => sum + item.amount!, 0) : null;
  const opportunity = fact("月饼粽子机缘", "人物/修炼"),
    points = number(opportunity?.raw.split("/")[0]);
  const op =
    level !== null && points !== null
      ? opportunityPrice(level, points, base, settings.opportunityMode)
      : null;
  add(
    "机缘调整",
    opportunity?.raw || "未知",
    points !== null && points < 40
      ? "-[min(V0,10000)/10000]×20×(40-J)"
      : "按人物等级及机缘公式或已确认69级报价",
    op,
    opportunity?.evidence,
  );
  if (level === 69 && points !== null && points > 40 && op === null)
    pending.add("确认69级机缘使用公式还是离散报价");
  const body = base !== null && op !== null ? base + op : null;
  const server = settings.servers.find((value) => value.serverId === record.listing.serverId);
  const summary = record.listing.summary as Record<string, unknown> | null;
  const coin = (key: string, label: string): Fact | null => {
    if (summary && (typeof summary[key] === "number" || typeof summary[key] === "string"))
      return {
        raw: String(summary[key]),
        evidence: [
          {
            path: "/listing/summary/" + key,
            value: typeof summary[key] === "string" ? summary[key] : JSON.stringify(summary[key]),
            reason: "采集到的" + label,
          },
        ],
      };
    return fact(label) || (label === "储备金" ? fact("储备") : null);
  };
  const assetStart = items.length;
  for (const [key, label, coefficient] of [
    ["iCash", "现金", 0.95],
    ["iSaving", "存银", 0.95],
    ["reserve_money", "储备金", 0.5],
    ["xianyu", "仙玉", 0.05],
  ] as const) {
    const value = coin(key, label),
      quantity = number(value?.raw);
    const amount =
      quantity === null
        ? null
        : quantity === 0
          ? 0
          : label === "仙玉"
            ? quantity / 20
            : server?.goldPrice != null && server.goldUnit != null
              ? (quantity / server.goldUnit) * server.goldPrice * coefficient
              : null;
    add(
      label,
      value?.raw || "未知",
      label === "仙玉" ? "数量/20" : "(原始币数/U)×G×" + coefficient,
      amount,
      value?.evidence,
      label + "数量，或区服金价及报价单位",
    );
  }
  const assets = items.slice(assetStart).every((item) => item.confirmed)
    ? items.slice(assetStart).reduce((sum, item) => sum + item.amount!, 0)
    : null;
  let k: number | null = null;
  if (
    server?.age &&
    server.rank !== null &&
    (server.age !== "older" || (server.goldPrice !== null && server.goldUnit !== null))
  ) {
    const h = server.age === "older" ? (70 - server.rank) * 0.001 : (10 - server.rank) * 0.005;
    const g =
      server.age === "older" && server.baselineUnitConfirmed
        ? (server.goldPrice! - 210) / 420
        : server.age === "older"
          ? null
          : 0;
    if (g === null) pending.add("确认金价与基准210使用相同报价单位（基准单位尚未确认）");
    else {
      const added = 1 + h + g,
        multiplied = (1 + h) * (1 + g);
      k =
        settings.adjustmentMode === "add"
          ? added
          : settings.adjustmentMode === "multiply"
            ? multiplied
            : Math.abs(added - multiplied) < 1e-10
              ? added
              : null;
      if (k === null) pending.add("确认区服调整比例相加还是系数相乘");
      if (k !== null && k <= 0) {
        k = null;
        pending.add("区服调整系数不大于0，需要核实参数");
      }
    }
  } else missing.add("区服年代、热度排名及所需金价和报价单位");
  let value: number | null = null;
  if (body !== null && assets !== null && k !== null) {
    const bodyOnly = body * k + assets,
      all = (body + assets) * k;
    value =
      settings.adjustmentScope === "body"
        ? bodyOnly
        : settings.adjustmentScope === "all"
          ? all
          : Math.abs(bodyOnly - all) < 1e-10
            ? bodyOnly
            : null;
    if (value === null) pending.add("确认区服调整只作用于角色本体还是同时作用于附带资产");
  }
  if (settings.b === null) missing.add("最高买入系数b");
  if (settings.extraCost === null) missing.add("全部额外购买成本F（明确无费用时填写0）");
  if (asking === null) missing.add("挂牌价格");
  if (level === null) missing.add("人物等级");
  if (value !== null && value <= 0) pending.add("完整模型估值不大于0，需要核实数据");
  const purchased = purchase(value, asking, settings);
  const decision = missing.size || pending.size ? "NEED_INFO" : purchased.decision;
  return {
    ...empty,
    ...purchased,
    decision,
    model_value: round(value),
    missing_fields: [...missing],
    pending_rules: [...pending],
    known_subtotal: round(
      items.reduce((sum, item) => sum + (item.confirmed ? item.amount! : 0), 0),
    )!,
    reason:
      decision === "NEED_INFO"
        ? "已完成独立分项计算，完整估值或购买条件仍有待确认项。"
        : "已按确认的估值规则与购买条件核算。",
    next_action: [...pending, ...missing][0] ? "请补充或确认：" + [...pending, ...missing][0] : "",
  };
}
