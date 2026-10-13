import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { createMarketScopeAudit, type GlobalMarketRequest } from "./market-scope";
import { hoverForInspection } from "../viewport";
import { createHiddenPage, getBrowser } from "../session";
import { assertAvailable, pace } from "../crawler/page";
import { buildPageState } from "../page-state";
import { readStableSnapshot } from "../workflow";
import { cleanDescription } from "../crawler/compact";
import {
  currentPetSkills,
  petSkillState,
  protectedPetSkills,
  prioritizePetSkills,
  PET_SEARCH_MAX_SKILLS,
  petLevelBounds,
  PET_APTITUDE_TOLERANCE,
  PET_GROWTH_TOLERANCE,
  petBlessingState,
  PET_COMPARISON_POLICY_VERSION,
} from "./pet-match";
import {
  equipmentIdentity,
  safeEquipmentUrl,
  pageText,
  type EquipmentCandidate,
  type EquipmentSearchCursor,
} from "./equipment-pricing";
import { buildSimilarEstimate } from "./pricing-estimate";
import {
  resetPricingCursor,
  rememberPricingPage,
  validPricingPageHistory,
} from "./pricing-progress";
import {
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  PRICING_RESUME_POLICY,
} from "./pricing-integrity";
import {
  petEquipmentDescription,
  verifyPetCandidate,
  type PetEquipment,
  type PetMatchType,
  type PetPricingItem,
  type PetSource,
} from "./pet-pricing";

export const PET_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet";

export type PetSearchForm = {
  url: string;
  controls: {
    id: string;
    name: string;
    tag: string;
    type: string;
    label: string;
    visible: boolean;
    options?: { value: string; label: string }[];
  }[];
  menus: {
    id: string;
    tag: string;
    label: string;
    visible: boolean;
    choices: { value: string; label: string; selected: boolean; visible: boolean }[];
  }[];
  buttons: {
    id: string;
    name: string;
    tag: string;
    type: string;
    label: string;
    visible: boolean;
  }[];
  scripts: string[];
};

/** Public form metadata only; this boundary never supplies authenticated price evidence. */
export async function readPetSearchForm(
  page: Page,
  expectedURL = PET_SEARCH_URL,
): Promise<PetSearchForm> {
  const expected = new URL(expectedURL);
  if (
    expected.origin !== "https://xyq.cbg.163.com" ||
    ![
      "/cgi-bin/equipquery.py?act=show_overall_search_pet",
      "/cgi-bin/xyq_overall_search.py?act=show_pet_equip_search_form",
    ].includes(expected.pathname + expected.search)
  )
    throw new Error("未确认的宝宝公开查询入口");
  if (expectedURL === PET_SEARCH_URL)
    await page.waitForFunction(
      () => {
        const g = window as Window & { CaptchaCheck?: { need_captcha?: boolean } };
        const visible = (selector: string) =>
          Array.from(document.querySelectorAll(selector)).some((el) => el.checkVisibility());
        return (
          !!document.querySelector("#server_type_panel li") ||
          g.CaptchaCheck?.need_captcha ||
          visible(
            "#qrcode,#loginContainer,input[type=password],.yidun_popup,.geetest_panel,#captcha_container",
          ) ||
          /\/(?:show_login|login)\.py$/.test(location.pathname) ||
          /系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText)
        );
      },
      undefined,
      { timeout: 15000 },
    );
  if (page.isClosed()) throw new Error("宝宝查询工作页已关闭");
  return page.evaluate((expectedURL) => {
    const globals = window as Window & { CaptchaCheck?: { need_captcha?: boolean } };
    const visible = (el: Element) =>
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const hasVisible = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some(visible);
    if (
      globals.CaptchaCheck?.need_captcha ||
      hasVisible(".yidun_popup,.geetest_panel,#captcha_container")
    )
      throw new Error("网站要求安全验证，已暂停读取宝宝字段");
    if (/系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText))
      throw new Error("网站繁忙或要求降低频率，已暂停读取宝宝字段");
    if (
      /\/(?:show_login|login)\.py$/.test(location.pathname) ||
      hasVisible("#qrcode,#loginContainer,input[type=password]")
    )
      throw new Error("宝宝入口显示登录面板，尚未读取字段");
    const current = new URL(location.href);
    if (current.origin + current.pathname + current.search !== expectedURL)
      throw new Error("宝宝公开查询入口与预期不符");
    const text = (value: string | null | undefined) =>
      (value || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const publicElement = (el: Element) => {
      if (
        el.closest(
          "header,nav,footer,aside,#right_float_pannel,#qrcode,#loginContainer,.yidun_popup,.geetest_panel,#captcha_container",
        )
      )
        return false;
      for (let node: Element | null = el; node && node !== document.body; node = node.parentElement)
        if (
          /login|account|qrcode|captcha|geetest|yidun|password|cookie|csrf|token|fingerprint|session|urs|mobile|phone|email|nickname|userinfo|user_info|user_name|passport|safe_code/i.test(
            [node.id, node.getAttribute("name"), node.className].join(" "),
          )
        )
          return false;
      return true;
    };
    const label = (el: Element) => {
      const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const directText = Array.from(el.parentElement?.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ");
      return text(
        (forLabel && publicElement(forLabel) ? forLabel.textContent : "") ||
          el.closest("tr")?.querySelector("th")?.textContent ||
          el.closest("dl")?.querySelector("dt")?.textContent ||
          directText ||
          el.getAttribute("placeholder"),
      );
    };
    const controls = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"),
    )
      .filter(
        (el) =>
          publicElement(el) &&
          (el instanceof HTMLSelectElement ||
            ["text", "number", "search", "checkbox", "radio"].includes(el.type)),
      )
      .map((el) => ({
        id: el.id,
        name: el.name,
        tag: el.tagName,
        type: el instanceof HTMLSelectElement ? "select" : el.type,
        label: label(el),
        visible: visible(el),
        ...(el instanceof HTMLSelectElement
          ? {
              options: Array.from(el.options).map((option) => ({
                value: option.value,
                label: text(option.text),
              })),
            }
          : {}),
      }));
    // Official ButtonChecker stores its public choice ID in MooTools Element storage.
    const choiceValue = (choice: HTMLElement) => {
      const stored = (choice as HTMLElement & { retrieve?: (key: string) => unknown }).retrieve?.(
        "value",
      );
      const value =
        choice.getAttribute("data_value") ||
        choice.getAttribute("data-value") ||
        choice.getAttribute("data-skill_id") ||
        stored;
      return typeof value === "string" || typeof value === "number" ? String(value) : null;
    };
    const menus = Array.from(document.querySelectorAll<HTMLElement>("ul[id],ol[id],div[id]"))
      .filter(
        (el) =>
          publicElement(el) &&
          Array.from(el.querySelectorAll<HTMLElement>(":scope > li")).some(
            (choice) => publicElement(choice) && choiceValue(choice) !== null,
          ),
      )
      .map((el) => ({
        id: el.id,
        tag: el.tagName,
        label: label(el),
        visible: visible(el),
        choices: Array.from(el.querySelectorAll<HTMLElement>(":scope > li"))
          .filter((choice) => publicElement(choice) && choiceValue(choice) !== null)
          .map((choice) => ({
            value: choiceValue(choice)!,
            label: text(
              choice.innerText ||
                choice.textContent ||
                choice.title ||
                choice.querySelector("img")?.alt,
            ),
            selected: choice.classList.contains("on"),
            visible: visible(choice),
          })),
      }));
    const buttons = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLAnchorElement>(
        "button,input[type=button],input[type=submit],a[id]",
      ),
    )
      .filter(publicElement)
      .map((el) => ({
        id: el.id,
        name: el.getAttribute("name") || "",
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        label:
          el instanceof HTMLInputElement ? text(el.value) : text(el.innerText || el.textContent),
        visible: visible(el),
      }));
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).flatMap(
      (script) => {
        const url = new URL(script.src, location.href);
        if (
          url.protocol !== "https:" ||
          !/(?:^|\.)(?:163\.com|netease\.com)$/.test(url.hostname) ||
          /login|account|auth|captcha|qrcode|token|session/i.test(url.pathname)
        )
          return [];
        return [url.origin + url.pathname];
      },
    );
    return {
      url: expectedURL,
      controls,
      menus,
      buttons,
      scripts: [...new Set(scripts)],
    };
  }, expectedURL);
}

type Choices = [string | number, string][];
export type PetSearchConfig = {
  names: Record<string, string>;
  skills: Choices;
  highNeidans: Choices;
  lowNeidans: Choices;
  traits?: Choices;
  officialTypeIds?: string[];
};
class UnsupportedPetDescriptionError extends Error {
  override name = "UnsupportedPetDescriptionError";
}
const MAX_PAGES = 3,
  MAX_ROWS = 60,
  MAX_DETAILS = 40;

/** These are the public OverallPetSearcher parameters, without server or price constraints. */
export type PetQueryMode = PetMatchType | "diagnostic";
export function petQuery(
  item: PetPricingItem,
  config: PetSearchConfig,
  matchType: PetQueryMode = "exact",
) {
  const ids = Object.entries(config.names)
    .filter(([, name]) => name === item.name)
    .map(([id]) => id);
  if (!ids.length) {
    if (config.officialTypeIds?.length)
      throw new Error(
        `官网类型目录确认“${item.name}”（${config.officialTypeIds.join(",")}），但没有独立可交易筛选定义；特殊类型保留未定价，不替换为其他宝宝`,
      );
    throw new Error("官网召唤兽类型目录未识别“" + item.name + "”，未发起宽泛查询");
  }
  const args: Record<string, string | number> = { type: ids.join(","), server_type: "3" };
  if (item.level !== null && item.level >= 0 && item.level <= 180)
    args.level_min = args.level_max = item.level;
  const fields = new Map(item.fields.map((field) => [field.name, field.value]));
  // Official .js_super_sum_star controls distinguish initial (0) from an uncaptured star.
  const starLabels: Record<string, string> = { 初始: "0", 一星: "1", 二星: "2", 三星: "3" };
  const stars = item.fields
    .filter((field) => field.name === "神兽星级")
    .map(({ value }) => starLabels[value.trim()] ?? value.trim().match(/^([0-3])(?:星)?$/)?.[1]);
  if (stars.length) {
    if (stars.some((star) => star === undefined) || new Set(stars).size !== 1)
      throw new Error("神兽星级未明确或不在官网已确认的0至3星范围，未发起宽泛查询");
    args.super_sum_star = stars[0]!;
  }
  const traits = item.fields.filter((field) => ["特性", "特性类型"].includes(field.name));
  const traitIds = traits.map(({ value }) => {
    // Explicit absence has no official menu option; percentages are never quality tiers.
    if (value.trim() === "无") return "";
    const matches = (config.traits || []).filter(([, label]) => label === value.trim());
    if (matches.length !== 1 || !/^[1-9]\d*$/.test(String(matches[0][0])))
      throw new Error("宝宝特性名称没有唯一官网筛选定义，未发起宽泛查询");
    return String(matches[0][0]);
  });
  if (new Set(traitIds).size > 1) throw new Error("宝宝特性字段不一致，未发起宽泛查询");
  if (traitIds[0]) args.texing = traitIds[0];
  if (matchType === "diagnostic") {
    if (["是否宝宝", "宝宝"].some((name) => /^(?:是|1)$/.test(fields.get(name) || "")))
      args.is_baobao = 1;
    return args;
  }
  for (const [name, parameter] of [
    ["攻击资质", "attack_aptitude"],
    ["防御资质", "defence_aptitude"],
    ["体力资质", "physical_aptitude"],
    ["法力资质", "magic_aptitude"],
    ["速度资质", "speed_aptitude_min"],
  ]) {
    const value = fields.get(name);
    const base = value?.match(/^([0-9]+)(?:\s*\+\s*[0-9]+)?$/)?.[1];
    if (base !== undefined && Number(base) <= 10000) {
      const tolerance =
        matchType === "similar" && name.endsWith("资质") ? PET_APTITUDE_TOLERANCE : 0;
      args[parameter] = Math.ceil(Number(base) * (1 - tolerance));
    }
  }
  if (args.speed_aptitude_min !== undefined) {
    const speed = Number(fields.get("速度资质")?.match(/^([0-9]+)/)?.[1]);
    args.speed_aptitude_max =
      matchType === "similar"
        ? Math.min(10000, Math.floor(speed * (1 + PET_APTITUDE_TOLERANCE)))
        : args.speed_aptitude_min;
  }
  const growth = fields.get("成长");
  if (growth && /^\d\.\d{1,3}$/.test(growth))
    args.growth = Math.round(
      (Number(growth) - (matchType === "similar" ? PET_GROWTH_TOLERANCE : 0)) * 1000,
    );
  if (["是否宝宝", "宝宝"].some((name) => /^(?:是|1)$/.test(fields.get(name) || "")))
    args.is_baobao = 1;
  const targetSkills = currentPetSkills(item);
  const selectedSkills =
    targetSkills.length > PET_SEARCH_MAX_SKILLS
      ? (() => {
          const prioritized = new Set(
            prioritizePetSkills(targetSkills).slice(0, PET_SEARCH_MAX_SKILLS),
          );
          return targetSkills.filter((name) => prioritized.has(name));
        })()
      : targetSkills;
  const mappedSkills = selectedSkills.map((name) => {
    const observed = item.skillObservations?.find((skill) => skill.rawName === name);
    if (observed && observed.state !== "current") return [];
    const matches = config.skills.filter(([, label]) => label === name);
    if (observed?.id)
      return matches.filter(([id]) => String(id) === observed.id).map(([id]) => String(id));
    return matches.length === 1 ? [String(matches[0][0])] : [];
  });
  const skills = mappedSkills.flat();
  if (skills.length) args.skill = [...new Set(skills)].join(",");
  // Partial names, future/conditional skills and ambiguous IDs cannot establish a current count.
  const allCurrentRecognized =
    targetSkills.length > 0 &&
    !item.skills.some((name) => ["conditional", "unknown"].includes(petSkillState(name, item))) &&
    targetSkills.every((name) => {
      const observed = item.skillObservations?.find((skill) => skill.rawName === name);
      if (observed && observed.state !== "current") return false;
      const matches = config.skills.filter(([, label]) => label === name);
      return observed?.id
        ? matches.some(([id]) => String(id) === observed.id)
        : matches.length === 1;
    });
  if (matchType === "exact" && allCurrentRecognized) args.skill_num = targetSkills.length;
  for (const [key, choices] of [
    ["high_neidan", config.highNeidans],
    ["low_neidan", config.lowNeidans],
  ] as const) {
    const matched = item.innerSkills.flatMap((skill) =>
      choices.filter(([, name]) => name === skill.name).map(([id]) => String(id)),
    );
    if (matchType === "exact" && matched.length) args[key] = matched.join(",");
  }
  return args;
}

/** Same-level comparables first, then bounded nearby levels; query IDs always come from the official directory. */
export function petQueries(item: PetPricingItem, config: PetSearchConfig) {
  const exact = { matchType: "exact" as const, args: petQuery(item, config, "exact") };
  const current = currentPetSkills(item);
  const protectedSkills = protectedPetSkills(current);
  const ordinary = current
    .filter((name) => !protectedSkills.includes(name))
    .sort((left, right) => Number(right.startsWith("高级")) - Number(left.startsWith("高级")));
  const needed = Math.max(2, Math.ceil(current.length * 0.6), protectedSkills.length);
  const subsets = [current];
  if (current.length > needed && ordinary.length) {
    for (let size = current.length - 1; size >= needed; size--)
      for (let start = 0; start < Math.min(ordinary.length, 3); start++) {
        const rotated = [...ordinary.slice(start), ...ordinary.slice(0, start)];
        subsets.push([...protectedSkills, ...rotated.slice(0, size - protectedSkills.length)]);
      }
  }
  const similar = subsets.map((skills) => ({
    matchType: "similar" as const,
    args: petQuery({ ...item, skills }, config, "similar"),
  }));
  if (item.level !== null && item.level > 0) {
    const [level_min, level_max] = petLevelBounds(item.level);
    similar.push(
      ...similar.map(({ args }) => ({
        matchType: "similar" as const,
        args: { ...args, level_min, level_max },
      })),
    );
  }
  const seen = new Set<string>();
  return [
    exact,
    ...similar.filter(({ args }) => {
      const key = JSON.stringify(args);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    { matchType: "diagnostic" as const, args: petQuery(item, config, "diagnostic") },
  ];
}

const petDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function petCursorMatches(
  cursor: EquipmentSearchCursor | undefined,
  planHash: string,
  modes: number,
) {
  return (
    !!cursor &&
    cursor.version === 1 &&
    cursor.planHash === planHash &&
    Number.isInteger(cursor.modeIndex) &&
    cursor.modeIndex >= 0 &&
    cursor.modeIndex <= modes &&
    Number.isInteger(cursor.pageNumber) &&
    cursor.pageNumber > 0 &&
    Number.isInteger(cursor.rowIndex) &&
    cursor.rowIndex >= 0 &&
    typeof cursor.pageRowsHash === "string" &&
    validPricingPageHistory(cursor) &&
    (cursor.restartCount === undefined ||
      (Number.isInteger(cursor.restartCount) && cursor.restartCount >= 0)) &&
    Array.isArray(cursor.seen) &&
    cursor.seen.every((value) => typeof value === "string") &&
    Array.isArray(cursor.failed) &&
    cursor.failed.every(
      (value) =>
        typeof value.url === "string" &&
        Number.isInteger(value.modeIndex) &&
        value.modeIndex >= 0 &&
        value.modeIndex < modes,
    )
  );
}

const PET_UI_NUMBER_FIELDS = [
  "level_min",
  "level_max",
  "skill_num",
  "attack_aptitude",
  "defence_aptitude",
  "physical_aptitude",
  "magic_aptitude",
  "speed_aptitude_min",
  "speed_aptitude_max",
  "lingxing",
] as const;
export type PetUIEvidence = {
  method: "official-ui";
  inputs: Record<string, string | boolean>;
  selections: Record<string, string[]>;
  searchButton: "btn_pet_search";
  submittedArgs?: Record<string, string | number>;
};

/** The legacy form truncates growth * 1000, so 1.009 would otherwise submit 1008. */
export function petGrowthInput(growth: string | number): string {
  const target = Number(growth);
  if (!Number.isSafeInteger(target) || target < 0)
    throw new Error("宝宝成长筛选值必须是非负整数千分值");
  const decimal = target / 1000;
  let value = decimal.toFixed(3);
  if (Math.trunc(Number(value) * 1000) !== target)
    value = (decimal + Number.EPSILON * Math.max(1, Math.abs(decimal))).toString();
  if (Math.trunc(Number(value) * 1000) !== target) throw new Error("宝宝成长筛选值无法精确提交");
  return value;
}

/** Check what the official click actually submitted, including unexpected restored filters. */
export function assertPetUIArguments(
  expected: Record<string, string | number>,
  actual: Record<string, string | number>,
) {
  const normalized = (value: string | number) =>
    String(value)
      .split(",")
      .map((part) => part.trim())
      .sort()
      .join(",");
  for (const [key, value] of Object.entries(expected))
    if (actual[key] === undefined || normalized(actual[key]) !== normalized(value))
      throw Object.assign(
        new Error(
          "宝宝官网表单实际条件与计划不一致：" +
            key +
            " (expected: " +
            value +
            ", actual: " +
            actual[key] +
            ")",
        ),
        key === "growth" ? { code: "PET_GROWTH_ARGUMENT_MISMATCH" } : {},
      );
  for (const [key, value] of Object.entries(actual))
    if (
      expected[key] === undefined &&
      !(key === "evol_skill_mode" && String(value) === "0") &&
      String(value) !== ""
    )
      throw new Error("宝宝官网表单保留了未计划的筛选条件：" + key);
}

/** IDs below were observed in the public official HTML/JS and live discovery; values are per-item. */
export async function fillPetSearchForm(
  page: Page,
  item: PetPricingItem,
  args: Record<string, string | number>,
  signal: AbortSignal,
): Promise<PetUIEvidence> {
  signal.throwIfAborted();
  await page.locator("#reset_all").click({ timeout: 10000 });
  await page.locator("#btn_reset_user_server").click({ timeout: 10000 });
  await page.locator("#overall_sel_area").selectOption("");
  await page.locator("#ovarall_sel_server").selectOption("");
  const inputs: PetUIEvidence["inputs"] = { pet_select_box: item.name };
  await page.locator("#pet_select_box").fill(item.name);
  for (const key of PET_UI_NUMBER_FIELDS) {
    if (args[key] === undefined) continue;
    const id = "txt_" + key,
      value = String(args[key]);
    await page.locator("#" + id).fill(value);
    inputs[id] = value;
  }
  if (args.growth !== undefined) {
    const value = petGrowthInput(args.growth);
    await page.locator("#txt_growth").fill(value);
    inputs.txt_growth = value;
  }
  await page.locator("#chk_is_baobao").setChecked(args.is_baobao === 1);
  inputs.chk_is_baobao = args.is_baobao === 1;
  // Ordinary skill icons can be clipped by the official collapsed panel.
  const expand = page.locator("#btn_all_skill");
  if (await expand.isVisible()) await expand.click({ timeout: 10000 });
  const skills = args.skill === undefined ? [] : String(args.skill).split(",");
  for (const id of skills) {
    if (!/^\d+$/.test(id)) throw new Error("宝宝技能没有已确认的官网ID");
    const specificChoice = page
      .locator(`#pet_skill_wrap .js_include_pet_skill li[data-skill_id="${id}"]`)
      .first();
    const fallbackChoice = page.locator(`#pet_skill_wrap li[data-skill_id="${id}"]`).first();
    const choice = (await specificChoice.count()) ? specificChoice : fallbackChoice;
    if (!(await choice.count())) throw new Error("官网包含技能控件缺失：" + id);
    await choice.click({ timeout: 10000 });
  }
  const selections: PetUIEvidence["selections"] = { pet_skill_wrap: skills };
  if (args.super_sum_star !== undefined) {
    const stars = String(args.super_sum_star).split(",");
    for (const star of stars) {
      if (!/^[0-3]$/.test(star)) throw new Error("宝宝神兽星级没有已确认的官网选项");
      const choice = page.locator(`.js_super_sum_star[value="${star}"]`);
      if ((await choice.count()) !== 1) throw new Error("官网神兽星级控件缺失或不唯一：" + star);
      await choice.setChecked(true);
    }
    selections.super_sum_star = stars;
  }
  const selectChoices = async (panel: string, wanted: string[]) => {
    const seen = new Set<string>();
    for (const choice of await page.locator("#" + panel + " > li").all()) {
      const state = await choice.evaluate((el) => {
        const stored = (el as HTMLElement & { retrieve?: (key: string) => unknown }).retrieve?.(
          "value",
        );
        const value = el.getAttribute("data_value") || el.getAttribute("data-value") || stored;
        return {
          value: typeof value === "string" || typeof value === "number" ? String(value) : "",
          selected: el.classList.contains("on"),
        };
      });
      seen.add(state.value);
      if (state.selected !== wanted.includes(state.value)) await choice.click({ timeout: 10000 });
    }
    if (wanted.some((value) => !seen.has(value)))
      throw new Error("官网宝宝菜单缺少筛选选项：" + panel);
    selections[panel] = wanted;
  };
  for (const key of ["high_neidan", "low_neidan", "texing"] as const)
    if (args[key] !== undefined) await selectChoices(key + "_panel", String(args[key]).split(","));
  await selectChoices("server_type_panel", ["3"]);
  signal.throwIfAborted();
  return { method: "official-ui", inputs, selections, searchButton: "btn_pet_search" };
}

async function clickPetSearchPage(page: Page, pageNumber: number) {
  const link = page.locator(`#pager a[href="javascript:goto(${pageNumber})"]`).first();
  if (await link.count()) {
    await link.click({ timeout: 10000 });
    return "official-page-link";
  }
  const input = page.locator("#pager #pager_input");
  if (!(await input.count())) throw new Error("官网宝宝查询没有可用的翻页控件");
  await input.fill(String(pageNumber));
  await input.press("Enter");
  return "official-page-input";
}

type PetObservation = {
  productId: unknown;
  serverId: unknown;
  productName: unknown;
  visibleName: string;
  storageType: unknown;
  petStorageType: unknown;
  rawPrice: unknown;
  prices: string[];
  selling: unknown;
  body: string;
  fields: { name: string; value: string }[];
  parsedFields: { name: string; value: string }[];
  skills: string[];
  expectedSkills: string[];
  unsupportedDescription?: boolean;
  unsupportedReason?: string;
  futureSkills?: string[];
  expectedFutureSkills?: string[];
  evolution?: PetEvolutionData;
  innerSkills: { name: string; level: string }[];
  expectedInner: { name: string; level: string }[];
  equipment: PetEquipment[];
  expectedEquipment: PetEquipment[];
};
type PetEvolutionData = {
  payloads: { name: string; value: unknown }[];
  currentSkills: unknown;
  names: Record<string, string>;
  mappings: Record<
    string,
    { high_skill?: unknown; low_skill?: unknown; super_skill?: unknown; name?: unknown }
  >;
};
export function petEvolutionPreview(data: PetEvolutionData): {
  supported: boolean;
  names: string[];
  reason?: string;
} {
  const unsupported = { supported: false, names: [] as string[] };
  const validId = (value: unknown) =>
    (typeof value === "number" || typeof value === "string") && /^[1-9]\d*$/.test(String(value));
  const payloads = data.payloads.filter(({ value }) => value !== undefined);
  const parsed: { ids: string[]; rows?: Record<string, unknown>[] }[] = [];
  let legacy = false;
  let rawAbsent = false;
  for (const { name, value } of payloads) {
    if (!["evol_skill_list", "evol_skills", "other.EvolSkill", "other.evol_skills"].includes(name))
      return unsupported;
    if (
      name === "other.EvolSkill" &&
      (value === null || value === "" || value === 0 || value === false)
    ) {
      rawAbsent = true;
      parsed.push({ ids: [] });
    } else if (value === null) parsed.push({ ids: [] });
    else if (name === "other.EvolSkill" && typeof value === "string") {
      const ids = value.split("|");
      if (!ids.every(validId)) return unsupported;
      parsed.push({ ids });
      legacy = true;
    } else if (Array.isArray(value) && value.every(validId)) {
      const ids = value.map(String);
      parsed.push({ ids });
      legacy ||= ids.some((id) => !!data.mappings[id]);
    } else if (
      name === "evol_skill_list" &&
      Array.isArray(value) &&
      value.every(
        (row) => row && typeof row === "object" && !Array.isArray(row) && validId(row.skill_type),
      )
    ) {
      parsed.push({ ids: value.map((row) => String(row.skill_type)), rows: value });
      legacy = true;
    } else return unsupported;
  }
  if (rawAbsent && parsed.some(({ ids }) => ids.length)) return unsupported;
  const idSet = (ids: string[]) => [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
  if (parsed.some(({ ids }) => ids.includes("56230")) && data.names["56230"] === "未明之赐")
    return {
      ...unsupported,
      reason: "主宝宝未明之赐占位尚未揭示技能，不能与无赐福配置混用，报价未采用",
    };
  const ids = idSet(parsed[0]?.ids || []);
  if (parsed.some((value) => JSON.stringify(idSet(value.ids)) !== JSON.stringify(ids)))
    return unsupported;
  if (!legacy) {
    if (ids.some((id) => !data.names[id])) return unsupported;
    return { supported: true, names: ids.map((id) => data.names[id] + "（进化后获得）") };
  }
  if (!Array.isArray(data.currentSkills) || !data.currentSkills.every(validId)) return unsupported;
  const current = new Set(data.currentSkills.map(String));
  const names: string[] = [];
  for (const id of ids) {
    const mapping = data.mappings[id];
    if (!mapping || !validId(mapping.high_skill) || !validId(mapping.super_skill))
      return unsupported;
    const high = String(mapping.high_skill),
      superSkill = String(mapping.super_skill);
    const low = validId(mapping.low_skill) ? String(mapping.low_skill) : null;
    if (
      high !== id ||
      !data.names[high] ||
      !data.names[superSkill] ||
      mapping.name !== data.names[superSkill] ||
      (mapping.low_skill !== null && mapping.low_skill !== undefined && !low) ||
      (low && !data.names[low])
    )
      return unsupported;
    const hasHigh = current.has(high),
      hasLow = !!low && current.has(low);
    const name =
      (hasLow && !hasHigh ? data.names[high] : data.names[superSkill]) + "（进化后获得）";
    for (const { rows } of parsed) {
      const row = rows?.filter((value) => String(value.skill_type) === id);
      if (
        row &&
        (row.length !== 1 ||
          row[0].name !== name ||
          Number(row[0].level) !== 1 ||
          String(row[0].evol_type) !== (hasLow && !hasHigh ? low : high) ||
          row[0].hlightLight !== (hasHigh || hasLow))
      )
        return unsupported;
    }
    names.push(name);
  }
  return { supported: true, names };
}
const normalized = (value: string) => value.replace(/[\s：:，,（）()【】]/g, "").toLowerCase();
const canonical = (value: string) =>
  /^\d+(?:\.\d+)?$/.test(value.trim()) ? String(Number(value)) : normalized(value);
const same = (a: string[], b: string[]) =>
  JSON.stringify(a.map(normalized).sort()) === JSON.stringify(b.map(normalized).sort());

/** Validate the visible principal product against its own official JSON, never the target pet. */
export function petObservationSource(observed: PetObservation, url: string) {
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (
    !scalar(observed.productId) ||
    !scalar(observed.serverId) ||
    !observed.visibleName ||
    observed.visibleName !== observed.productName ||
    equipmentIdentity(url) !== scalar(observed.serverId) + ":" + scalar(observed.productId) ||
    !scalar(observed.petStorageType) ||
    scalar(observed.storageType) !== scalar(observed.petStorageType)
  )
    throw new Error("无法把独立宝宝属性绑定到当前商品ID，报价未采用");
  const fields = new Map<string, string>();
  for (const field of observed.fields) {
    const old = fields.get(field.name);
    if (old !== undefined && canonical(old) !== canonical(field.value))
      throw new Error("主宝宝属性重复且不一致：" + field.name);
    fields.set(field.name, field.value);
  }
  for (const field of observed.parsedFields) {
    const visible = fields.get(field.name);
    if (visible !== undefined && canonical(visible) !== canonical(field.value))
      throw new Error("主宝宝数据与可见属性不一致：" + field.name);
    // Only the official type directory supplies the otherwise absent type label.
    if (field.name === "类型" && visible === undefined) fields.set(field.name, field.value);
    else if (visible === undefined) throw new Error("主宝宝关键属性未显示：" + field.name);
  }
  if (!same(observed.skills, observed.expectedSkills))
    throw Object.assign(new Error("主宝宝完整技能未显示或与商品数据不一致"), {
      petDiagnostics: {
        skillComparison: {
          visibleSkills: observed.skills,
          expectedSkills: observed.expectedSkills,
        },
      },
    });
  if (
    !observed.unsupportedDescription &&
    (observed.futureSkills?.length || observed.expectedFutureSkills?.length) &&
    !same(observed.futureSkills || [], observed.expectedFutureSkills || [])
  )
    throw new Error("主宝宝未来技能预览与官方配置不一致，不能当作当前技能");
  const innerKey = (skill: { name: string; level: string }) => skill.name + skill.level + "层";
  if (
    observed.innerSkills.some((skill) => !skill.name || !/^[1-5]$/.test(skill.level)) ||
    !same(observed.innerSkills.map(innerKey), observed.expectedInner.map(innerKey))
  )
    throw new Error("主宝宝内丹名称、层数或完整列表未核对");
  const gearKey = (gear: PetEquipment) =>
    (gear.accessory ? "饰品" : "装备") + gear.name + petEquipmentDescription(gear);
  if (
    observed.equipment.some((gear) => !gear.name || !petEquipmentDescription(gear)) ||
    !same(observed.equipment.map(gearKey), observed.expectedEquipment.map(gearKey))
  )
    throw Object.assign(new Error("主宝宝随身装备未完整显示或与商品数据不一致"), {
      petDiagnostics: {
        equipmentComparison: {
          visible: observed.equipment.map((gear) => ({
            name: gear.name,
            description: petEquipmentDescription(gear),
            accessory: gear.accessory,
          })),
          expected: observed.expectedEquipment.map((gear) => ({
            name: gear.name,
            description: petEquipmentDescription(gear),
            accessory: gear.accessory,
          })),
        },
      },
    });
  const prices = [
    ...new Set(
      observed.prices.flatMap((value) => {
        const match = value.replace(/,/g, "").match(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)/);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
  const price = prices.length === 1 ? prices[0] : null;
  if (
    price === null ||
    price <= 0 ||
    !Number.isFinite(price) ||
    !/^(?:\d+(?:\.\d+)?)$/.test(scalar(observed.rawPrice).trim()) ||
    Number(observed.rawPrice) !== price
  )
    throw new Error("主宝宝数据价格与可见人民币挂牌价不明确或不一致");
  const off =
    /商品已下架|商品已售出|商品不存在|(?:状态|是否上架)\s*[：:]?\s*(?:已下架|未上架|已售出)/.test(
      observed.body,
    ) ||
    observed.selling === 0 ||
    observed.selling === false;
  const on =
    !off &&
    (observed.selling === 1 ||
      observed.selling === true ||
      /(?:状态|是否上架)\s*[：:]?\s*(?:已上架|上架中)/.test(observed.body));
  if (!on && !off) throw new Error("无法确认独立宝宝当前在售状态");
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const text = [
    "召唤兽",
    ...[...fields].map(([name, value]) => name + "：" + value),
    "技能：" + (observed.skills.join("、") || "无"),
    ...(observed.futureSkills?.length ? ["未来技能：" + observed.futureSkills.join("、")] : []),
    "内丹：" +
      (observed.innerSkills.map((skill) => skill.name + "(" + skill.level + "层)").join("、") ||
        "无"),
    "宝宝装备：" + (observed.equipment.length ? "" : "无"),
    on ? "在售" : "商品已下架",
    "挂牌价：¥" + price,
  ].join("\n");
  const html =
    "<main><pre>" +
    escape(text) +
    "</pre>" +
    [...observed.skills, ...(observed.futureSkills || [])]
      .map((name) => '<img data_skill_type="cifu" data_equip_name="' + escape(name) + '">')
      .join("") +
    observed.equipment
      .map(
        (gear) =>
          '<img data_equip_name="' +
          escape(gear.name) +
          (gear.accessory ? '" data_equip_location="RolePetShipin' : "") +
          '" data_equip_desc="' +
          escape(cleanDescription(gear.description)) +
          '">',
      )
      .join("") +
    "</main>";
  return { text, price, html };
}

export async function petPageSource(page: Page, signal: AbortSignal) {
  try {
    return await readMainPet(page, signal);
  } catch (error) {
    signal.throwIfAborted();
    const diagnostics = await page
      .evaluate(() => {
        const excluded =
          '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .equip_tips';
        const describe = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter((node) => !node.closest(excluded))
            .slice(0, 3)
            .map((node) => {
              const ancestors = [];
              for (
                let parent = node.parentElement, count = 0;
                parent && count < 3;
                parent = parent.parentElement, count++
              )
                ancestors.push({
                  tag: parent.tagName,
                  id: parent.id.slice(0, 80),
                  className: String(parent.className).slice(0, 120),
                });
              return { visible: node.checkVisibility(), ancestors };
            });
        return {
          panels: describe("#equip_desc_panel"),
          info: describe("#info_panel"),
          jsonInputs: Array.from(document.querySelectorAll("#equip_desc_value")).filter(
            (node) => !node.closest(excluded),
          ).length,
          descriptionFormat: Array.from(
            document.querySelectorAll<HTMLInputElement>("#equip_desc_value"),
          )
            .filter((node) => !node.closest(excluded))
            .map((node) => ({
              length: node.value.length,
              semicolonFields: node.value.split(";").length,
              attributeParserAvailable:
                typeof (window as unknown as Record<string, unknown>).get_pet_attrs_info ===
                "function",
              encoded: node.value.startsWith("@"),
              decoderAvailable:
                typeof (window as unknown as Record<string, unknown>).decode_desc === "function",
            })),
          mainPrices: Array.from(document.querySelectorAll<HTMLElement>("#info_panel .price"))
            .filter(
              (node) =>
                node.checkVisibility() &&
                !node.closest(excluded) &&
                !node.closest("#equip_price_addon_info"),
            )
            .slice(0, 3)
            .map((node) => node.innerText.slice(0, 80)),
        };
      })
      .catch(() => null);
    const failure =
      error instanceof Error && error.name !== "TimeoutError"
        ? error
        : new Error("主宝宝属性、商品信息或价格区域未加载完成");
    throw Object.assign(failure, {
      petDiagnostics: {
        ...diagnostics,
        ...(failure as Error & { petDiagnostics?: Record<string, unknown> }).petDiagnostics,
      },
    });
  }
}

/** Resolve a unique public attribute region, without depending on one template's panel ID. */
export function petRegionReady(excluded: string) {
  const visible = (node: Element) =>
    node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    !node.closest(excluded);
  document
    .querySelectorAll("[data-cbg-pet-main-panel]")
    .forEach((node) => node.removeAttribute("data-cbg-pet-main-panel"));
  const infos = Array.from(document.querySelectorAll<HTMLElement>("#info_panel")).filter(visible);
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("#equip_desc_value"),
  ).filter((node) => !node.closest(excluded));
  const g = window as unknown as Record<string, any>;
  if (
    !(g.equip || g.EquipInfo) ||
    infos.length !== 1 ||
    inputs.length !== 1 ||
    !inputs[0].value.trim()
  )
    return false;
  const panels = Array.from(document.querySelectorAll<HTMLElement>("#equip_desc_panel")).filter(
    visible,
  );
  if (panels.length > 1) return false;
  let panel = panels[0];
  if (!panel) {
    const hasStats = (node: HTMLElement) => {
      const text = node.innerText.replace(/\s/g, "");
      return (
        ["成长", "攻击资质", "防御资质", "体力资质", "法力资质", "速度资质"].every((name) =>
          text.includes(name),
        ) && /躲[闪避]资质/.test(text)
      );
    };
    let region = infos[0].parentElement;
    while (region && region !== document.body && region !== document.documentElement) {
      const tables = Array.from(region.querySelectorAll<HTMLElement>("table, dl")).filter(
        (node) => visible(node) && hasStats(node),
      );
      const leaves = tables.filter(
        (node) => !tables.some((other) => other !== node && node.contains(other)),
      );
      if (leaves.length > 1) return false;
      if (leaves.length === 1) {
        let candidate: HTMLElement | null = leaves[0];
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
    infos[0].querySelectorAll<HTMLElement>(".price, [data_price], [data-price]"),
  ).some(
    (node) =>
      visible(node) &&
      !node.closest("#equip_price_addon_info") &&
      (node.innerText.trim() || node.getAttribute("data_price") || node.getAttribute("data-price")),
  );
  if (priceReady) panel.setAttribute("data-cbg-pet-main-panel", "true");
  return priceReady;
}

async function inspectMainPetEquipment(page: Page, signal: AbortSignal, excluded: string) {
  signal.throwIfAborted();
  const count = await page
    .locator("[data-cbg-pet-main-panel] img")
    .evaluateAll((nodes, excluded) => {
      document
        .querySelectorAll("[data-cbg-pet-gear-index]")
        .forEach((node) => node.removeAttribute("data-cbg-pet-gear-index"));
      const equipment = nodes.filter((icon) => {
        if (
          !icon.checkVisibility() ||
          icon.closest(excluded) ||
          !/\/(?:equip|pet_shipin)\//.test(icon.getAttribute("src") || "")
        )
          return false;
        const attrs: Record<string, string> = {};
        let node: Element | null = icon;
        for (
          let depth = 0;
          depth < 3 && node && !node.hasAttribute("data-cbg-pet-main-panel");
          depth++, node = node.parentElement
        )
          for (const attr of node.attributes)
            if (attr.name.startsWith("data"))
              attrs[attr.name.replace(/^data-/, "data_")] ||= attr.value;
        return !attrs.data_skill_type;
      });
      equipment.forEach((node, index) =>
        node.setAttribute("data-cbg-pet-gear-index", String(index)),
      );
      return equipment.length;
    }, excluded);
  for (let index = 0; index < count; index++) {
    signal.throwIfAborted();
    await assertAvailable(page);
    const icon = page.locator(`[data-cbg-pet-gear-index="${index}"]`);
    await hoverForInspection(page, icon);
    await pace(signal, 300, 200);
    const handle = await page.waitForFunction(
      ({ index, excluded }) => {
        const icon = document.querySelector(`[data-cbg-pet-gear-index="${index}"]`);
        if (!icon || !icon.checkVisibility() || icon.closest(excluded)) return false;
        const attrs: Record<string, string> = {};
        let node: Element | null = icon;
        for (
          let depth = 0;
          depth < 3 && node && !node.hasAttribute("data-cbg-pet-main-panel");
          depth++, node = node.parentElement
        )
          for (const attr of node.attributes)
            if (attr.name.startsWith("data"))
              attrs[attr.name.replace(/^data-/, "data_")] ||= attr.value;
        const name = attrs.data_equip_name || "";
        const id = attrs.data_tip_box;
        const tips = id
          ? [document.getElementById(id)]
          : Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .equip_tips',
              ),
            );
        const texts = [
          ...new Set(
            tips
              .filter(
                (tip) =>
                  tip?.checkVisibility() &&
                  !tip.closest(
                    "#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds",
                  ),
              )
              .map((tip) => tip!.innerText.trim())
              .filter(Boolean),
          ),
        ];
        // Inline descriptions can contain only the level; prefer the actual visible tip.
        if (texts.length === 0 && !id && name && attrs.data_equip_desc)
          return { name, description: attrs.data_equip_desc };
        if (texts.length !== 1) return false;
        const lines = texts[0]
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const visibleName = name || lines[0];
        if (!visibleName || !texts[0].includes(visibleName)) return false;
        const description = (lines[0] === visibleName ? lines.slice(1) : lines).join("\n");
        return description ? { name: visibleName, description } : false;
      },
      { index, excluded },
      { timeout: 4000 },
    );
    try {
      const value = await handle.jsonValue();
      if (!value) throw new Error("宝宝装备提示框未完整显示");
      signal.throwIfAborted();
      await icon.evaluate((node, value) => {
        node.setAttribute("data_cbg_pet_gear_name", value.name);
        node.setAttribute("data_cbg_pet_gear_description", value.description);
      }, value);
    } finally {
      await handle.dispose();
    }
  }
}

async function readMainPet(page: Page, signal: AbortSignal) {
  signal.throwIfAborted();
  await assertAvailable(page);
  const excluded =
    '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [data-cbg-hover-tip], [id$="TipsBox"], [role="tooltip"], .equip_tips';
  await page.waitForFunction(petRegionReady, excluded, { timeout: 5000 });
  await inspectMainPetEquipment(page, signal, excluded);
  signal.throwIfAborted();
  await assertAvailable(page);
  const observed = await page.evaluate((excluded) => {
    const g = window as unknown as Record<string, any>;
    const raw = g.equip || g.EquipInfo;
    const visible = (node: Element) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !node.closest(excluded);
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>("[data-cbg-pet-main-panel]"),
    ).filter(visible);
    const infos = Array.from(document.querySelectorAll<HTMLElement>("#info_panel")).filter(visible);
    const panel = panels.length === 1 ? panels[0] : null;
    const info = infos.length === 1 ? infos[0] : null;
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
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("#equip_desc_value"),
    ).filter((node) => !node.closest(excluded));
    const input = inputs.length === 1 ? inputs[0] : null;
    let pet: Record<string, any>;
    try {
      const description = input?.value || "";
      const decoded =
        typeof g.decode_desc === "function" ? g.decode_desc(description) : description;
      // Only legacy delimited descriptions use the site's pet.js parser.
      pet =
        typeof decoded === "string" &&
        !decoded.trimStart().startsWith("{") &&
        !decoded.trimStart().startsWith("[") &&
        decoded.split(";").length >= 29 &&
        typeof g.get_pet_attrs_info === "function"
          ? g.get_pet_attrs_info(decoded, { only_basic_attr: true })
          : JSON.parse(decoded);
    } catch {
      throw new Error("官网主宝宝描述详情未识别");
    }
    if (
      !pet ||
      !Array.isArray(pet.all_skills) ||
      !Array.isArray(pet.neidan) ||
      !Array.isArray(pet.equip_list)
    )
      throw new Error("官网主宝宝完整技能、内丹或装备列表未确认");
    const fieldName = (name: string) =>
      name
        .trim()
        .replace(/\s/g, "")
        .replace(/[：:]$/, "")
        .replace(/^成长率$/, "成长")
        .replace(/^躲避资质$/, "躲闪资质");
    const fields: { name: string; value: string }[] = [];
    const add = (name: string, value: string) => {
      name = fieldName(name);
      value = value.replace(/\s+/g, " ").trim();
      if (name && (value || /赐福/.test(name))) fields.push({ name, value });
    };
    const structuredRegions = new Set<HTMLElement>();
    for (const label of panel.querySelectorAll<HTMLElement>("th, td, dt")) {
      const value = label.nextElementSibling;
      if (
        value instanceof HTMLElement &&
        visible(label) &&
        visible(value) &&
        /^(?:TD|DD)$/.test(value.tagName) &&
        (label.tagName === "TH" || label.tagName === "DT" || /[：:]\s*$/.test(label.innerText))
      ) {
        add(label.innerText, value.innerText);
        const region = label.closest<HTMLElement>("table, dl");
        if (region) structuredRegions.add(region);
      }
    }
    // Parsed tables already include bonus spans; the text fallback would split them into conflicting values.
    const principalText = (region: HTMLElement) => {
      let text = region.innerText;
      for (const tip of region.querySelectorAll<HTMLElement>(excluded))
        text = text.replace(tip.innerText, "");
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
    const icons = Array.from(panel.querySelectorAll<HTMLImageElement>("img"))
      .filter(visible)
      .map((icon) => {
        const attrs: Record<string, string> = {};
        let node: Element | null = icon;
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
    const futureSkill = (name: string) => /[（(]进化后获得[）)]/.test(name.replace(/\s/g, ""));
    const futureSkills = skillNames.filter(futureSkill);
    const skills = skillNames.filter((name) => !futureSkill(name));
    const expectedSkills = pet.all_skills.map(
      (id: unknown) => g.CBG_GAME_CONFIG?.pet_skill_desc?.[String(id)]?.name || "",
    );
    if (skills.some((name) => !name) || expectedSkills.some((name: string) => !name))
      throw new Error("官网主宝宝技能名称未完整识别");
    const innerSkills = icons
      .filter(({ attrs }) => attrs.data_skill_type === "neidan")
      .map(({ attrs }) => ({
        name: attrs.data_equip_name || attrs.data_store_name || "",
        level: attrs.data_equip_level || "",
      }));
    const expectedInner = pet.neidan.map((skill: Record<string, unknown>) => ({
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
    const expectedEquipment = pet.equip_list
      .filter(Boolean)
      .map((gear: Record<string, unknown>) => ({
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
    const mappings: PetEvolutionData["mappings"] = {};
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
    const names: Record<string, string> = {};
    for (const id of directoryIds) {
      const name = g.CBG_GAME_CONFIG?.pet_skill_desc?.[id]?.name;
      if (typeof name === "string" && name) names[id] = name;
    }
    // Status text comes only from the two bound principal regions, not their broader wrapper.
    const body = [info, panel]
      .map((region) => {
        const copy = region.cloneNode(true) as HTMLElement;
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
      expectedFutureSkills: [] as string[],
      productId: raw.eid,
      serverId: raw.serverid ?? raw.server_id,
      productName: raw.equip_name,
      visibleName:
        info.innerText
          .match(/(?:^|\s)ID\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/i)?.[1]
          ?.trim() || "",
      storageType: raw.storage_type,
      petStorageType: g.StorageStype?.pet,
      rawPrice: raw.price,
      prices: Array.from(info.querySelectorAll<HTMLElement>("[data_price], [data-price], .price"))
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
  }, excluded);
  signal.throwIfAborted();
  const evolution = observed.evolution ? petEvolutionPreview(observed.evolution) : null;
  const complete: PetObservation = evolution
    ? {
        ...observed,
        expectedFutureSkills: evolution.names,
        unsupportedDescription:
          !evolution.supported ||
          (observed.futureSkills.length > 0 && evolution.names.length === 0),
        unsupportedReason: evolution.reason,
      }
    : observed;
  const source = petObservationSource(complete, page.url());
  const blessing = petBlessingState(observed.fields);
  if (blessing.fields.length && blessing.state !== "absent")
    throw new UnsupportedPetDescriptionError(
      blessing.state === "present"
        ? "主宝宝存在赐福配置，需要完整赐福技能及有效状态的可见核验，报价未采用"
        : "主宝宝赐福字段值未知或冲突，需要完整可见字段确认，报价未采用",
    );
  // A supported base payload must be complete and bound before a configuration is terminal.
  if (complete.unsupportedDescription)
    throw new UnsupportedPetDescriptionError(
      complete.unsupportedReason ||
        "主宝宝未来/赐福技能描述结构尚未识别，需要原始描述与对应可见配置，报价未采用",
    );
  return source;
}

/** Separate work pages share the existing login; they never navigate the role list. */
export function petSourceFromPages(
  searchPage: Page,
  detailPage: Page,
  signal: AbortSignal,
): PetSource & { close(): Promise<void>; discover(): Promise<PetSearchForm> } {
  const cache = new Map<string, string>();
  const marketScope = createMarketScopeAudit(searchPage);
  const deadline = Date.now() + 240_000;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      signal.removeEventListener("abort", abort);
      marketScope.close();
      closing = Promise.allSettled([searchPage.close(), detailPage.close()]).then(() => {});
    }
    return closing;
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) void close();
  const readSource = async (url: string, requestSignal: AbortSignal) => {
    requestSignal = AbortSignal.any([signal, requestSignal]);
    requestSignal.throwIfAborted();
    if (closing) throw new Error("宝宝查询页面已关闭");
    const safe = safeEquipmentUrl(url);
    if (cache.has(safe)) return cache.get(safe)!;
    await pace(requestSignal, 600, 400);
    await detailPage.goto(safe, { waitUntil: "domcontentloaded", timeout: 15000 });
    requestSignal.throwIfAborted();
    if (equipmentIdentity(detailPage.url()) !== equipmentIdentity(safe))
      throw new Error("宝宝详情跳转到另一商品，报价未采用");
    const value = await petPageSource(detailPage, requestSignal);
    cache.set(safe, value.html);
    return value.html;
  };
  return {
    close,
    readSource,
    async discover() {
      signal.throwIfAborted();
      if (closing) throw new Error("宝宝查询页面已关闭");
      await searchPage.goto(PET_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      signal.throwIfAborted();
      const form = await readPetSearchForm(searchPage);
      signal.throwIfAborted();
      return form;
    },
    async findCandidates(items, requestSignal) {
      requestSignal = AbortSignal.any([signal, requestSignal]);
      requestSignal.throwIfAborted();
      if (closing) throw new Error("宝宝查询页面已关闭");
      const queries: string[] = [],
        records: unknown[] = [];
      const results: Awaited<ReturnType<PetSource["findCandidates"]>>["items"] = [];
      for (const item of items) {
        requestSignal.throwIfAborted();
        const blessing = petBlessingState(item.fields);
        if (blessing.fields.length && blessing.state !== "absent") {
          results.push({
            key: item.key,
            candidates: [],
            searchState: "unsupported",
            note:
              blessing.state === "present"
                ? "目标宝宝存在赐福配置，需要完整赐福技能及有效状态的可见核验，保留未定价"
                : "目标宝宝赐福字段值未知或冲突，需要完整字段确认，保留未定价",
          });
          continue;
        }
        if (Date.now() >= deadline) {
          results.push({
            key: item.key,
            candidates: [],
            searchState: "pending",
            skipped: true,
            ...(item.searchCursor ? { searchCursor: item.searchCursor } : {}),
            note: "达到本件商品查价时间上限，未完成所有宝宝查询",
          });
          continue;
        }
        await searchPage.goto(PET_SEARCH_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        requestSignal.throwIfAborted();
        await assertAvailable(searchPage);
        if (!buildPageState(await readStableSnapshot(searchPage)).isLoggedIn)
          throw new Error("藏宝阁登录已失效，请在采集页扫码登录后继续宝宝查价");
        await searchPage.waitForFunction(
          () => {
            const g = window as unknown as Record<string, any>;
            return (
              typeof g.overall_search === "function" &&
              typeof g.ajax_with_recommend === "function" &&
              g.SaleablePetNameInfo &&
              g.PetSkills?.length
            );
          },
          undefined,
          { timeout: 15000 },
        );
        const config = await searchPage.evaluate((name) => {
          const g = window as unknown as Record<string, any>;
          return {
            names: g.SaleablePetNameInfo || {},
            skills: g.PetSkills || [],
            highNeidans: g.HighNeidans || [],
            lowNeidans: g.LowNeidans || [],
            traits: g.TexingTypes || [],
            officialTypeIds: Object.entries(g.CBG_GAME_CONFIG?.pet_info || {})
              .filter(([, value]) => value === name)
              .map(([id]) => id),
          };
        }, item.name);
        let args: ReturnType<typeof petQuery>;
        try {
          args = petQuery(item, config);
        } catch (error) {
          results.push({
            key: item.key,
            candidates: [],
            searchState: "unsupported",
            note: error instanceof Error ? error.message : "官网宝宝类型未识别",
          });
          continue;
        }
        const act = "overall_search_pet";
        let query = "";
        const notes: string[] = [];
        const candidates: EquipmentCandidate[] = [],
          rejected: EquipmentCandidate[] = [],
          diagnosticSources: EquipmentCandidate[] = [];
        const plans = petQueries(item, config);
        const planHash = petDigest({
          resumePolicy: PRICING_RESUME_POLICY,
          policy: PET_COMPARISON_POLICY_VERSION,
          method: "official-ui-v1",
          priceMethod: EQUIPMENT_QUOTE_POLICY,
          description: item.description,
          fields: item.fields,
          skills: item.skills,
          skillObservations: item.skillObservations,
          innerSkills: item.innerSkills,
          equipment: item.equipment,
          plans,
        });
        const savedCursor = petCursorMatches(item.searchCursor, planHash, plans.length)
          ? item.searchCursor
          : undefined;
        const next: EquipmentSearchCursor = savedCursor
          ? structuredClone(savedCursor)
          : {
              version: 1,
              planHash,
              modeIndex: 0,
              pageNumber: 1,
              rowIndex: 0,
              pageRowsHash: "",
              seen: [],
              failed: [],
            };
        const seenRows = new Set(next.seen);
        const failed = new Map(next.failed.map(({ url, modeIndex }) => [url, modeIndex]));
        const closestSimilar = () =>
          candidates
            .filter((candidate) => candidate.matchType === "similar")
            .slice(0, EQUIPMENT_QUOTE_LIMIT);
        const enoughSamples = () =>
          candidates.filter((candidate) => candidate.matchType === "exact").length >=
            EQUIPMENT_QUOTE_LIMIT ||
          (!candidates.some((candidate) => candidate.matchType === "exact") &&
            closestSimilar().length >= EQUIPMENT_QUOTE_LIMIT &&
            buildSimilarEstimate(closestSimilar()).status === "range");
        let similarAttempted = false;
        let unsupportedDetails = 0;
        const allSeen = new Set<string>();
        let count = 0,
          details = 0;
        const readCandidate = async (
          url: string,
          title: string,
          matchType: PetQueryMode,
          modeIndex: number,
        ) => {
          const safe = safeEquipmentUrl(url);
          const identity = equipmentIdentity(safe);
          if (!cache.has(safe)) details++;
          let candidate: EquipmentCandidate = {
            url,
            title,
            price: null,
            priceType: "unknown",
            quote: "",
            verified: false,
            reason: "",
            fetchedAt: null,
            sourceHash: null,
            matchType: matchType === "exact" ? "exact" : "similar",
          };
          try {
            const html = await readSource(url, requestSignal);
            const text = pageText(html);
            const price = text.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1];
            candidate = verifyPetCandidate(
              item,
              {
                ...candidate,
                price: price ? Number(price) : null,
                priceType: "listing",
                quote: text,
              },
              html,
              new Date().toISOString(),
              matchType === "exact" ? "exact" : "similar",
            );
            failed.delete(url);
            console.log(
              `[browser-pet] candidate ${url} (${candidate.price}元, ${matchType}) verified=${candidate.verified}${candidate.verified ? "" : ` reason=${candidate.reason}`}`,
            );
            if (matchType === "diagnostic")
              diagnosticSources.push({
                ...candidate,
                verified: false,
                reason: "仅用于真实独立详情诊断，不计价：" + candidate.reason,
              });
            else if (candidate.verified) {
              if (!candidates.some((saved) => equipmentIdentity(saved.url) === identity))
                candidates.push(candidate);
            } else rejected.push(candidate);
            return { candidate };
          } catch (error) {
            requestSignal.throwIfAborted();
            if (error instanceof Error && /登录|安全验证|频繁|网站繁忙/.test(error.message))
              throw error;
            candidate = {
              ...candidate,
              reason: error instanceof Error ? error.message : "无法读取宝宝详情",
            };
            (matchType === "diagnostic" ? diagnosticSources : rejected).push(candidate);
            const failure = {
              url,
              reason: error instanceof Error ? error.message.split("\n")[0] : "无法读取宝宝详情",
              diagnostics:
                error && typeof error === "object" && "petDiagnostics" in error
                  ? error.petDiagnostics
                  : null,
            };
            if (error instanceof UnsupportedPetDescriptionError) {
              unsupportedDetails++;
            }
            failed.set(url, modeIndex);
            return {
              candidate,
              failure,
              unsupported: error instanceof UnsupportedPetDescriptionError,
            };
          }
        };
        // Only a cursor bound to this exact inventory and query plan permits resuming saved quotes.
        if (savedCursor) {
          const refreshedDetails: Array<{
            url: string;
            modeIndex: number;
            reason: "saved_quote" | "retry_failed";
          }> = [];
          for (const candidate of item.candidates.filter((value) => value.verified)) {
            if (details >= MAX_DETAILS || Date.now() >= deadline) break;
            const modeIndex =
              candidate.matchType === "similar"
                ? plans.findIndex((plan) => plan.matchType === "similar")
                : 0;
            await readCandidate(
              candidate.url,
              candidate.title,
              plans[modeIndex].matchType,
              modeIndex,
            );
            refreshedDetails.push({
              url: safeEquipmentUrl(candidate.url),
              modeIndex,
              reason: "saved_quote",
            });
          }
          for (const [url, modeIndex] of Array.from(failed)) {
            if (details >= MAX_DETAILS || Date.now() >= deadline) break;
            if (cache.has(safeEquipmentUrl(url))) continue;
            await readCandidate(url, item.name, plans[modeIndex].matchType, modeIndex);
            refreshedDetails.push({
              url: safeEquipmentUrl(url),
              modeIndex,
              reason: "retry_failed",
            });
          }
          if (refreshedDetails.length) {
            const refreshQuery =
              "仅重读已保存的独立宝宝详情 / 沿用历史全服、3年以上服查询证据 / " + item.name;
            queries.push(refreshQuery);
            item.query = [item.query, refreshQuery].filter(Boolean).join("\n");
            records.push({
              key: item.key,
              kind: "saved_detail_refresh",
              planHash,
              newMarketSearch: false,
              details: refreshedDetails,
              candidates: [...candidates, ...rejected],
            });
          }
        }
        await searchPage.evaluate(() => {
          const g = window as unknown as Record<string, any>;
          const original = g.ajax_with_recommend;
          if (typeof original !== "function") throw new Error("官网宝宝查询组件发生变化");
          g.ajax_with_recommend = function (options: Record<string, any>, ...rest: unknown[]) {
            const success = options.onSuccess,
              failure = options.onFailure;
            return original.call(
              this,
              {
                ...options,
                onSuccess(result: Record<string, any>) {
                  g.__cbgPetResult = {
                    page: Number(options.data?.page),
                    ok: result.status === 0 && Array.isArray(result.msg),
                    count: Array.isArray(result.msg) ? result.msg.length : -1,
                    error: typeof result.msg === "string" ? result.msg.slice(0, 200) : "",
                  };
                  success?.(result);
                },
                onFailure(...values: unknown[]) {
                  g.__cbgPetResult = {
                    page: Number(options.data?.page),
                    ok: false,
                    error: "官网查询请求失败",
                  };
                  failure?.(...values);
                },
              },
              ...rest,
            );
          };
        });
        let orderChanged = false;
        let historyValidated = !savedCursor?.pageHistory?.length;
        queryStages: for (let modeIndex = 0; modeIndex < plans.length; modeIndex++) {
          const { matchType, args: queryArgs } = plans[modeIndex];

          if (modeIndex === next.modeIndex && matchType === "diagnostic" && candidates.length) {
            next.modeIndex = modeIndex + 1;
            next.pageNumber = 1;
            next.rowIndex = 0;
            next.pageRowsHash = "";
            continue;
          }
          args = queryArgs;
          query =
            "全服 / 3年以上服 / 综合排序 / " +
            item.name +
            " / " +
            matchType +
            " / " +
            JSON.stringify(args);
          queries.push(query);
          item.query = query;
          if (matchType === "similar") similarAttempted = true;
          const seen = new Set<string>();
          const scopeEvidence: {
            mode: PetQueryMode;
            request: GlobalMarketRequest;
            rowCount: number;
            candidateServers: Record<string, number>;
          }[] = [];
          const uiEvidence: Array<{
            page: number;
            method: "official-ui";
            pagination?: boolean;
            inputs?: PetUIEvidence["inputs"];
            selections?: PetUIEvidence["selections"];
            searchButton?: "btn_pet_search";
            submittedArgs: Record<string, string | number>;
          }> = [];
          const detailFailures: { url: string; reason: string; diagnostics: unknown }[] = [];
          const unsupportedDescriptions: typeof detailFailures = [];
          let rows = 0,
            readDetails = 0,
            lastPage = 0,
            stagePages = 0,
            exhausted = false;
          const acceptedCount = () =>
            matchType === "diagnostic"
              ? diagnosticSources.length
              : candidates.filter((candidate) =>
                  matchType === "exact"
                    ? candidate.matchType !== "similar"
                    : candidate.matchType === "similar",
                ).length;
          const sampleLimit = matchType === "diagnostic" ? 3 : Infinity;
          const stageEnough = () => enoughSamples();
          const loadPage = async (pageNumber: number, replay = false) => {
            await pace(requestSignal);
            marketScope.begin(act, pageNumber);
            let ui: PetUIEvidence | undefined;
            if (pageNumber === 1) {
              ui = await fillPetSearchForm(searchPage, item, args, requestSignal);
              await searchPage.evaluate(() => {
                const g = window as Window & { __cbgPetResult?: unknown };
                g.__cbgPetResult = null;
              });
              await searchPage.locator("#btn_pet_search").click({ timeout: 10000 });
            } else {
              await searchPage.evaluate(() => {
                const g = window as Window & { __cbgPetResult?: unknown };
                g.__cbgPetResult = null;
              });
              await clickPetSearchPage(searchPage, pageNumber);
            }
            try {
              await searchPage.waitForFunction(
                (wanted) => {
                  const globals = window as unknown as Record<string, any>;
                  if (
                    globals.CaptchaCheck?.need_captcha ||
                    globals.IsLogin === 0 ||
                    globals.LoginInfo?.login === 0 ||
                    /show_login\.py/.test(location.pathname) ||
                    Array.from(
                      document.querySelectorAll(".yidun_popup, .geetest_panel, #captcha_container"),
                    ).some((el) => el.checkVisibility()) ||
                    /系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText)
                  )
                    return true;
                  const result = globals.__cbgPetResult;
                  const loading = document.querySelector("#loading_img");
                  return (
                    result?.page === wanted &&
                    (result.ok === false || !loading || !loading.checkVisibility())
                  );
                },
                pageNumber,
                { timeout: 20000, polling: 200 },
              );
            } catch (error) {
              requestSignal.throwIfAborted();
              if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
              await assertAvailable(searchPage);
              const state = await searchPage
                .evaluate(function readPetSearchWaitState() {
                  const g = window as unknown as Record<string, any>;
                  const result = g.__cbgPetResult;
                  return {
                    callbackReceived: !!result,
                    callbackPage: Number.isFinite(result?.page) ? result.page : null,
                    loadingVisible: !!document.querySelector("#loading_img")?.checkVisibility(),
                  };
                })
                .catch(() => null);
              const message =
                `宝宝搜索结果等待超时：${item.name} · ${matchType} · 第${pageNumber}页；` +
                (state
                  ? `回调${state.callbackReceived ? "已收到" : "未收到"}，回调页${state.callbackPage ?? "未知"}，加载图标${state.loadingVisible ? "仍显示" : "已消失"}`
                  : "等待状态读取失败");
              throw Object.assign(new Error(message, { cause: error }), {
                name: "TimeoutError",
                code: "PET_SEARCH_RESULT_TIMEOUT",
              });
            }
            requestSignal.throwIfAborted();
            await assertAvailable(searchPage);
            const request = marketScope.confirm();
            stagePages++;
            const submittedArgs = await searchPage.evaluate(() => {
              const g = window as Window & { CurSearchValue?: { arg?: Record<string, unknown> } };
              const value = g.CurSearchValue?.arg;
              if (!value || typeof value !== "object")
                throw new Error("官网宝宝表单未保存实际查询条件");
              const result: Record<string, string | number> = {};
              for (const [key, entry] of Object.entries(value)) {
                if (
                  /token|cookie|auth|password|nickname|urs|account|fingerprint|safe_code|session/i.test(
                    key,
                  )
                )
                  throw new Error("宝宝查询条件含非公开字段，已停止");
                if (typeof entry !== "string" && typeof entry !== "number")
                  throw new Error("宝宝查询条件不是公开筛选值，已停止");
                result[key] = entry;
              }
              return result;
            });
            assertPetUIArguments(args, submittedArgs);
            if (ui) uiEvidence.push({ page: pageNumber, ...ui, submittedArgs });
            else
              uiEvidence.push({
                page: pageNumber,
                method: "official-ui",
                pagination: true,
                submittedArgs,
              });
            const listing = await searchPage.evaluate((currentPage) => {
              const canonicalEquipmentUrl = (href: string) => {
                const url = new URL(href, location.href);
                const identityFields = new Set([
                  "s",
                  "serverid",
                  "server_id",
                  "eid",
                  "equip_id",
                  "ordersn",
                ]);
                const canonical = new URL(url.origin + url.pathname);
                for (const key of identityFields) {
                  const value = url.searchParams.get(key);
                  if (value !== null) canonical.searchParams.set(key, value);
                }
                return canonical.href;
              };
              const result = (window as unknown as Record<string, any>).__cbgPetResult;
              if (!result?.ok) throw new Error(result?.error || "官网宝宝查询未成功");
              const root = document.querySelector<HTMLElement>("#search_result");
              if (!root?.checkVisibility()) throw new Error("宝宝列表尚未加载");
              const rows = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.soldImg[href]"))
                .filter((a) => a.checkVisibility())
                .map((a) => ({
                  url: canonicalEquipmentUrl(a.href),
                  name: a.querySelector("img")?.getAttribute("data_equip_name") || "",
                  type: a.querySelector("img")?.getAttribute("data_equip_type") || "",
                }));
              const empty = result.count === 0 && /没有符合|没有找到|暂无/.test(root.innerText);
              if (!rows.length && !empty) throw new Error("宝宝列表为空但未确认没有匹配商品");
              const hasNext = Array.from(
                document.querySelectorAll<HTMLAnchorElement>("#pager a[href]"),
              ).some(
                (a) =>
                  a.checkVisibility() &&
                  Number(a.getAttribute("href")?.match(/^javascript:goto\((\d+)\)/)?.[1]) ===
                    currentPage + 1,
              );
              return { rows, empty, hasNext };
            }, pageNumber);
            const candidateServers: Record<string, number> = {};
            for (const row of listing.rows) {
              const server = equipmentIdentity(safeEquipmentUrl(row.url)).split(":")[0];
              if (/^\d+$/.test(server))
                candidateServers[server] = (candidateServers[server] || 0) + 1;
            }
            scopeEvidence.push({
              mode: matchType,
              request,
              rowCount: listing.rows.length,
              candidateServers,
              ...(replay ? { replay: true } : {}),
            });
            return { listing, request };
          };
          const history = savedCursor?.pageHistory || [];
          let uiReady = false;
          while (
            (next.historyIndex || 0) < history.length &&
            history[next.historyIndex || 0].modeIndex === modeIndex
          ) {
            if (stagePages >= MAX_PAGES || Date.now() >= deadline) break queryStages;
            const old = history[next.historyIndex || 0];
            if (!uiReady && old.pageNumber > 1) {
              const first = await loadPage(1, true);
              uiReady = true;
              const firstSaved = history.find(
                (page) => page.modeIndex === modeIndex && page.pageNumber === 1,
              );
              if (firstSaved && petDigest(first.listing.rows) !== firstSaved.rowsHash) {
                orderChanged = true;
                break;
              }
              if (stagePages >= MAX_PAGES) break queryStages;
            }
            const replay = await loadPage(old.pageNumber, true);
            uiReady = true;
            if (petDigest(replay.listing.rows) !== old.rowsHash) {
              orderChanged = true;
              break;
            }
            next.historyIndex = (next.historyIndex || 0) + 1;
          }
          if (orderChanged) {
            records.push({
              key: item.key,
              reason: "result_order_changed",
              previousCursor: structuredClone(next),
              discardedCandidates: [...candidates],
            });
            resetPricingCursor(next);
            candidates.length = rejected.length = diagnosticSources.length = 0;
            seenRows.clear();
            failed.clear();
            break queryStages;
          }
          if ((next.historyIndex || 0) >= history.length) historyValidated = true;
          if (modeIndex < next.modeIndex) continue;
          if (enoughSamples() || stagePages >= MAX_PAGES) break;
          if (!uiReady && next.pageNumber > 1) {
            const first = await loadPage(1, true);
            const firstSaved = history.find(
              (page) => page.modeIndex === modeIndex && page.pageNumber === 1,
            );
            if (firstSaved && petDigest(first.listing.rows) !== firstSaved.rowsHash) {
              resetPricingCursor(next);
              candidates.length = rejected.length = diagnosticSources.length = 0;
              seenRows.clear();
              failed.clear();
              orderChanged = true;
              break queryStages;
            }
          }
          next.historyIndex = 0;
          for (
            let pageNumber = next.pageNumber;
            stagePages < MAX_PAGES &&
            count < MAX_ROWS &&
            details < MAX_DETAILS &&
            !stageEnough() &&
            acceptedCount() < sampleLimit &&
            Date.now() < deadline;
            pageNumber++
          ) {
            const { listing } = await loadPage(pageNumber);
            lastPage = pageNumber;
            const pageRowsHash = petDigest(listing.rows);
            if (
              !rememberPricingPage(next, modeIndex, pageNumber, pageRowsHash) ||
              (next.pageRowsHash && next.pageRowsHash !== pageRowsHash)
            ) {
              records.push({
                key: item.key,
                reason: "result_order_changed",
                previousCursor: structuredClone(next),
                currentPageRowsHash: pageRowsHash,
                discardedCandidates: [...candidates],
              });
              resetPricingCursor(next);
              candidates.length = rejected.length = diagnosticSources.length = 0;
              seenRows.clear();
              failed.clear();
              orderChanged = true;
              break queryStages;
            }
            if (listing.empty) {
              exhausted = true;
              next.modeIndex = candidates.length ? plans.length : modeIndex + 1;
              next.pageNumber = 1;
              next.rowIndex = 0;
              next.pageRowsHash = "";
              break;
            }
            let added = 0,
              pageFullyRead = true;
            const startRow = next.pageRowsHash === pageRowsHash ? next.rowIndex : 0;
            next.pageNumber = pageNumber;
            next.pageRowsHash = pageRowsHash;
            next.rowIndex = startRow;
            for (let rowIndex = startRow; rowIndex < listing.rows.length; rowIndex++) {
              const row = listing.rows[rowIndex];
              requestSignal.throwIfAborted();
              const identity = equipmentIdentity(safeEquipmentUrl(row.url));
              const seenKey = modeIndex + ":" + identity;
              if (seenRows.has(seenKey)) {
                next.rowIndex = rowIndex + 1;
                continue;
              }
              if (count >= MAX_ROWS || Date.now() >= deadline) {
                pageFullyRead = false;
                break;
              }
              if (seen.has(identity)) {
                next.rowIndex = rowIndex + 1;
                continue;
              }
              seen.add(identity);
              added++;
              rows++;
              if (!allSeen.has(identity)) {
                allSeen.add(identity);
                count++;
              }
              if (row.type && !String(args.type).split(",").includes(row.type)) {
                seenRows.add(seenKey);
                next.rowIndex = rowIndex + 1;
                if (count >= MAX_ROWS) {
                  pageFullyRead = rowIndex === listing.rows.length - 1;
                  break;
                }
                continue;
              }
              const sourceCached = cache.has(safeEquipmentUrl(row.url));
              if (
                (!sourceCached &&
                  (details >= MAX_DETAILS ||
                    readDetails >=
                      (matchType === "exact" ? 6 : matchType === "similar" ? 5 : 3))) ||
                Date.now() >= deadline
              ) {
                pageFullyRead = false;
                break;
              }
              if (!sourceCached) readDetails++;
              const result = await readCandidate(row.url, row.name, matchType, modeIndex);
              if (result.failure)
                (result.unsupported ? unsupportedDescriptions : detailFailures).push(
                  result.failure,
                );
              seenRows.add(seenKey);
              next.rowIndex = rowIndex + 1;
              if (result.failure) {
                pageFullyRead = false;
                break;
              }
              if (count >= MAX_ROWS || stageEnough() || acceptedCount() >= sampleLimit) {
                pageFullyRead = rowIndex === listing.rows.length - 1;
                break;
              }
            }
            if (matchType === "diagnostic" && acceptedCount() >= sampleLimit) {
              next.modeIndex = modeIndex + 1;
              next.pageNumber = 1;
              next.rowIndex = 0;
              next.pageRowsHash = "";
              break;
            }
            if (!pageFullyRead) break;
            if (!listing.hasNext) {
              exhausted = pageFullyRead;
              next.modeIndex = candidates.length ? plans.length : modeIndex + 1;
              next.pageNumber = 1;
              next.rowIndex = 0;
              next.pageRowsHash = "";
              break;
            }
            next.pageNumber = pageNumber + 1;
            next.rowIndex = 0;
            next.pageRowsHash = "";
            if (!added && stagePages >= MAX_PAGES) break;
          }
          const note =
            `${matchType === "exact" ? "严格" : matchType === "similar" ? "相似" : "诊断"}筛选已查询${lastPage}页、${rows}个列表候选、${readDetails}个新详情；` +
            (exhausted ? "本次筛选结果已读完" : "有限样本查询，未遍历全部在售商品") +
            "。";
          notes.push(note);
          records.push({
            key: item.key,
            searchUrl: PET_SEARCH_URL,
            act,
            matchType,
            args,
            pages: lastPage,
            scopeEvidence,
            uiEvidence,
            rows,
            details: readDetails,
            exhausted,
            detailFailures,
            unsupportedDetails: unsupportedDescriptions,
            candidates: [...candidates, ...rejected],
            ...(!enoughSamples() && next.modeIndex === modeIndex ? { cursor: next } : {}),
          });
          if (next.modeIndex >= plans.length || next.modeIndex === modeIndex || failed.size) break;
        }
        const distinct = new Map<string, EquipmentCandidate>();
        const selected = [
          ...candidates.filter((candidate) => candidate.matchType === "exact"),
          ...closestSimilar(),
        ];
        for (const candidate of [...selected, ...rejected]) {
          const identity = equipmentIdentity(candidate.url);
          if (!distinct.has(identity)) distinct.set(identity, candidate);
        }
        const completed =
          !orderChanged && historyValidated && (enoughSamples() || next.modeIndex >= plans.length);
        next.seen = [...seenRows];
        next.failed = [...failed].map(([url, modeIndex]) => ({ url, modeIndex }));
        results.push({
          key: item.key,
          query: item.query,
          searchState: failed.size ? "read_failed" : completed ? "completed" : "pending",
          ...(!completed || failed.size ? { searchCursor: next } : {}),
          candidates: [...distinct.values()].slice(0, EQUIPMENT_QUOTE_LIMIT),
          similarAttempted,
          diagnosticSources,
          note:
            (orderChanged
              ? "官网结果身份或顺序已变化，旧候选和已读位置已清除，将从第一阶段第一页重新取样。 "
              : "") +
            notes.join(" ") +
            (!completed
              ? " 已保存筛选阶段、页码和行位置，下轮继续剩余候选；当前样本不足或配置最近的报价分散，尚未结束查价。"
              : "") +
            (unsupportedDetails
              ? " 查询结果含尚未支持核验的赐福状态或未来技能描述，未采用这些报价；需补齐原始描述与可见配置后再次查询。"
              : ""),
        });
      }
      return { queries, items: results, searchItems: records };
    },
  };
}

export async function createPetSource(signal: AbortSignal) {
  signal.throwIfAborted();
  let searchPage: Page | undefined, detailPage: Page | undefined;
  try {
    const browser = await getBrowser(true);
    signal.throwIfAborted();
    searchPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    detailPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    return petSourceFromPages(searchPage, detailPage, signal);
  } catch (error) {
    await Promise.allSettled([searchPage?.close(), detailPage?.close()]);
    throw error;
  }
}
