import { assertGlobalMarketRequest, type GlobalMarketRequest } from "./market-scope";
import type { Page, Request } from "playwright-core";
import { createHiddenPage, getBrowser, getCbgPage } from "../session";
import { assertAvailable, pace, readListings, waitList } from "../crawler/page";
import { collectDetail, isOnShelf } from "../crawler/detail";
import type { Listing, SavedRoleRecord } from "../crawler/types";
import {
  buildRoleMarketReference,
  compareRoleConfiguration,
  roleCore,
  roleSourceHash,
  type RoleMarketCandidate,
} from "./role-market";
import { clearServerFilter } from "../workflow";
import { buildRoleSearchQuery } from "./role-search-query";

export type RoleFormControl = {
  id: string;
  name: string;
  type: string;
  label: string;
  value: string;
  options?: { value: string; label: string }[];
};
export type RoleFormMenu = {
  id: string;
  label: string;
  choices: { value: string; label: string; selected: boolean }[];
};
export type RoleSearchForm = {
  topology?: {
    tag: string;
    id: string;
    name: string;
    type: string;
    label: string;
    ancestors: { tag: string; id: string; className: string }[];
  }[];
  url: string;
  action: string;
  method: string;
  act: string;
  controls: RoleFormControl[];
  menus: RoleFormMenu[];
};

/** Only public search controls are returned; no account state, tokens or cookies. */
export async function readRoleSearchForm(page: Page): Promise<RoleSearchForm> {
  await assertRoleFormReadable(page);
  return page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('form[name="query_form"]');
    if (!form) throw new Error("官网角色搜索表单尚未加载");
    const text = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const label = (el: Element) => {
      const forLabel = el.id
        ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`)
        : null;
      return text(
        forLabel?.innerText ||
          el.closest("tr")?.querySelector("th")?.textContent ||
          el.parentElement?.textContent,
      ).slice(0, 160);
    };
    // These official table roots were observed through this app's public form topology.
    const officialRoots = Array.from(document.querySelectorAll("#test table.searcTb"));
    const roots = officialRoots.length ? officialRoots : [form.parentElement || form];
    const selectAll = <T extends Element>(selector: string): T[] => [
      ...new Set(roots.flatMap((root) => Array.from(root.querySelectorAll<T>(selector)))),
    ];
    const controls = selectAll<HTMLInputElement | HTMLSelectElement>("input[id],select[id]")
      .filter((el) => el instanceof HTMLSelectElement || ["text", "number"].includes(el.type))
      .map((el) => ({
        id: el.id,
        name: el.name,
        type: el instanceof HTMLSelectElement ? "select" : el.type,
        label: label(el),
        value: el.value,
        ...(el instanceof HTMLSelectElement
          ? {
              options: Array.from(el.options).map((option) => ({
                value: option.value,
                label: text(option.text),
              })),
            }
          : {}),
      }));
    const menus = selectAll<HTMLElement>("ul[id],ol[id],div[id]")
      .filter((el) => el.querySelector(":scope > li[data_value],:scope > li[data-value]"))
      .map((el) => ({
        id: el.id,
        label: label(el),
        choices: Array.from(
          el.querySelectorAll<HTMLElement>(":scope > li[data_value],:scope > li[data-value]"),
        ).map((choice) => ({
          value: choice.getAttribute("data_value") || choice.getAttribute("data-value") || "",
          label: text(choice.innerText || choice.textContent),
          selected: choice.classList.contains("on"),
        })),
      }));
    const topology =
      controls.length || menus.length
        ? undefined
        : Array.from(
            document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
              "input:not([type=hidden]):not([type=password]),select,ul[id],ol[id]",
            ),
          )
            .filter(
              (el) =>
                el.tagName === "INPUT" ||
                el.tagName === "SELECT" ||
                el.querySelector("li[data_value],li[data-value]"),
            )
            .map((el) => {
              const ancestors: { tag: string; id: string; className: string }[] = [];
              let parent = el.parentElement;
              for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement)
                ancestors.push({ tag: parent.tagName, id: parent.id, className: parent.className });
              const forLabel = el.id
                ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`)
                : null;
              const directText = Array.from(el.parentElement?.childNodes || [])
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent)
                .join(" ");
              return {
                tag: el.tagName,
                id: el.id,
                name: el.getAttribute("name") || "",
                type: el.getAttribute("type") || "",
                label: text(
                  forLabel?.innerText ||
                    el.closest("tr")?.querySelector("th")?.textContent ||
                    el.closest("dl")?.querySelector("dt")?.textContent ||
                    directText,
                ).slice(0, 160),
                ancestors,
              };
            });
    return {
      ...(topology ? { topology } : {}),
      url: location.href,
      action: form.action,
      method: form.method,
      act:
        form.querySelector<HTMLInputElement>('input[name="act"]')?.value ||
        new URL(form.action).searchParams.get("act") ||
        "overall_search_role",
      controls,
      menus,
    };
  });
}

export async function readRoleAuthentication(page: Page) {
  return page.evaluate(() => {
    const globals = window as Window & { IsLogin?: unknown; LoginInfo?: { login?: unknown } };
    const boolean = (value: unknown): boolean | null =>
      value === 0 || value === false ? false : value === 1 || value === true ? true : null;
    const visible = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some((el) =>
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      );
    return {
      pathname: location.pathname,
      act: new URL(location.href).searchParams.get("act") || "",
      IsLogin: boolean(globals.IsLogin),
      login: boolean(globals.LoginInfo?.login),
      hasLogin: visible('a[href*="show_login.py"],input[type="password"],#loginContainer'),
      hasQR: visible("#qrcode"),
      readyState: document.readyState,
    };
  });
}
export async function currentRoleAuthentication() {
  const page = getCbgPage();
  if (!page) throw new Error("当前项目角色工作页尚未打开");
  return readRoleAuthentication(page);
}
async function assertRoleAvailable(page: Page) {
  const diagnostic = await readRoleAuthentication(page);
  try {
    await assertAvailable(page);
  } catch (error) {
    throw new Error(
      (error instanceof Error ? error.message : "角色工作页不可用") +
        "；公开认证诊断：" +
        JSON.stringify(diagnostic),
    );
  }
}

/** The public filter form may inject IsLogin=0; it supplies fields, never price evidence. */
export async function assertRoleFormReadable(page: Page) {
  if (page.isClosed()) throw new Error("角色查询工作页已关闭");
  const error = await page.evaluate(() => {
    const globals = window as Window & { CaptchaCheck?: { need_captcha?: boolean } };
    const visible = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some((el) =>
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      );
    if (
      globals.CaptchaCheck?.need_captcha ||
      visible(".yidun_popup,.geetest_panel,#captcha_container")
    )
      return "网站要求安全验证，已暂停读取角色字段";
    if (/系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText))
      return "网站繁忙或要求降低频率，已暂停读取角色字段";
    if (
      /\/(?:show_login|login)\.py$/.test(location.pathname) ||
      visible("#qrcode,#loginContainer,input[type=password]")
    )
      return "角色入口显示登录面板，尚未读取字段";
    return "";
  });
  if (error)
    throw new Error(
      error + "；公开认证诊断：" + JSON.stringify(await readRoleAuthentication(page)),
    );
}

export function publicRoleArguments(args: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args))
    if (
      !/token|cookie|auth|password|nickname|urs|account|fingerprint|safe_code|session/i.test(key) &&
      /server|area|level|grade|school|page|kind|order_by|equip|pet|xiu|expt|beast|training|strong|speed|skill|ability|act/i.test(
        key,
      )
    )
      if (
        value === null ||
        ["string", "number", "boolean"].includes(typeof value) ||
        (Array.isArray(value) &&
          value.every(
            (entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry),
          ))
      )
        result[key] = value;
  return result;
}
async function roleResponseDiagnostic(page: Page) {
  const authentication = await readRoleAuthentication(page);
  const response = await page.evaluate(() => {
    const args = (window as Window & { QueryArgs?: Record<string, unknown> }).QueryArgs || {};
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const result = document.querySelector<HTMLElement>("#query_result")?.innerText || "";
    return {
      queryArgs: args,
      soldList: document.querySelectorAll("#soldList").length,
      rows: document.querySelectorAll("#soldList a.soldImg").length,
      queryResult: document.querySelectorAll("#query_result").length,
      pagerBar: document.querySelectorAll("#pager_bar").length,
      pagerText: clean(document.querySelector<HTMLElement>("#pager_bar")?.innerText || "").slice(
        0,
        160,
      ),
      resultText: clean(result).slice(0, 300),
    };
  });
  return { ...authentication, ...response, queryArgs: publicRoleArguments(response.queryArgs) };
}

export type PublicRoleNavigation = { id: string; label: string; url: string };
export async function readPublicRoleNavigation(): Promise<PublicRoleNavigation[]> {
  const page = getCbgPage();
  if (!page) throw new Error("当前项目角色工作页尚未打开");
  await assertRoleAvailable(page);
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter(
        (anchor) =>
          ["sub_role", "cross_server_buy"].includes(anchor.id) ||
          /重新(?:查|搜)|角色(?:搜索|查询)|跨服购买/.test(anchor.innerText.trim()),
      )
      .flatMap((anchor) => {
        let url: URL;
        try {
          url = new URL(anchor.getAttribute("href") || "", location.href);
        } catch {
          return [];
        }
        if (url.origin !== "https://xyq.cbg.163.com" || !url.searchParams.get("act")) return [];
        const safe = new URL(url.origin + url.pathname);
        safe.searchParams.set("act", url.searchParams.get("act")!);
        const server = url.searchParams.get("serverid");
        if (server && /^\d+$/.test(server)) safe.searchParams.set("serverid", server);
        return [
          {
            id: anchor.id,
            label: anchor.innerText.replace(/\s+/g, " ").trim().slice(0, 120),
            url: safe.href,
          },
        ];
      }),
  );
}

export type RoleSearchSelections = {
  controls: { id: string; value: string }[];
  menus: { id: string; value: string }[];
};
export function validateRoleSelections(form: RoleSearchForm, selections: RoleSearchSelections) {
  for (const [kind, values] of [
    ["controls", selections.controls],
    ["menus", selections.menus],
  ] as const) {
    if (!Array.isArray(values) || values.length > 40) throw new Error("角色筛选参数格式错误");
    const seen = new Set<string>();
    for (const entry of values) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        typeof entry.value !== "string" ||
        entry.value.length > 100 ||
        seen.has(entry.id)
      )
        throw new Error("角色筛选存在无效或重复控件");
      seen.add(entry.id);
      if (entry.id === "server_type") throw new Error("开服条件固定为全服3年以上服");
      if (kind === "controls") {
        const control = form.controls.find((value) => value.id === entry.id);
        if (
          !control ||
          (control.options && !control.options.some((option) => option.value === entry.value))
        )
          throw new Error("官网角色控件未确认：" + entry.id);
      } else {
        const menu = form.menus.find((value) => value.id === entry.id);
        if (!menu?.choices.some((choice) => choice.value === entry.value))
          throw new Error("官网角色菜单值未确认：" + entry.id);
      }
    }
  }
}

/** Use observed official widgets; mutations are limited to locator-driven UI operations. */
export async function applyRoleSearchSelections(
  page: Page,
  form: RoleSearchForm,
  selections: RoleSearchSelections,
) {
  validateRoleSelections(form, selections);
  const inactiveOperators = new Set([
    "jiyuan_and_addpoint_panel",
    "school_skill_num",
    "xuan_ling_zhu_level",
  ]);
  const neutralLabel = (label: string) =>
    /^(?:不限|全部|所有|空|--|请选择)?$/.test(label.replace(/\s/g, ""));
  const element = async (id: string) => {
    const locator = page.locator(`[id=${JSON.stringify(id)}]`);
    if ((await locator.count()) !== 1) throw new Error("角色筛选控件已变化：" + id);
    return locator;
  };
  for (const control of form.controls) {
    const locator = await element(control.id);
    const selection = selections.controls.find((value) => value.id === control.id);
    let value = selection?.value;
    if (value === undefined) {
      if (["text", "number"].includes(control.type)) value = "";
      else if (control.type === "select") {
        const neutral = control.options?.find(
          (option) =>
            neutralLabel(option.label) ||
            (/(?:server|area)/i.test(control.id) && ["", "0"].includes(option.value)),
        );
        if (neutral) value = neutral.value;
        else if (inactiveOperators.has(control.id)) continue;
        else throw new Error("官网下拉框缺少可确认中性选项：" + control.id);
      } else throw new Error("官网角色控件类型未确认：" + control.id);
    }
    if (!selection && (await locator.inputValue()) === value) continue;
    if (!(await locator.isVisible()) || !(await locator.isEnabled()))
      throw new Error("官网角色控件当前不能通过界面填写：" + control.id);
    if (control.type === "select") await locator.selectOption(value, { timeout: 5000 });
    else await locator.fill(value, { timeout: 5000 });
    if ((await locator.inputValue()) !== value)
      throw new Error("官网角色控件填写未生效：" + control.id);
  }
  for (const menu of form.menus) {
    if (menu.id === "server_type") continue;
    const panel = await element(menu.id);
    const selection = selections.menus.find((value) => value.id === menu.id);
    const neutral = menu.choices.find(
      (choice) =>
        neutralLabel(choice.label) ||
        (/(?:server|area)/i.test(menu.id) && ["", "0"].includes(choice.value)),
    );
    if (!selection && !neutral && inactiveOperators.has(menu.id)) continue;
    if (!selection && !neutral && menu.choices.some((choice) => choice.selected))
      throw new Error("官网菜单缺少可确认中性项：" + menu.id);
    const desired = selection?.value ?? neutral?.value;
    const choices = panel.locator(":scope > li[data_value],:scope > li[data-value]");
    const read = () =>
      choices.evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("data_value") || node.getAttribute("data-value") || "",
          selected: node.classList.contains("on"),
        })),
      );
    const observed = await read();
    const index =
      desired === undefined ? -1 : observed.findIndex((choice) => choice.value === desired);
    if (desired !== undefined && index < 0) throw new Error("角色菜单值已变化：" + menu.id);
    for (const [position, choice] of observed.entries())
      if (position !== index && choice.selected)
        await choices.nth(position).click({ timeout: 5000 });
    if (index >= 0 && !(await read())[index]?.selected)
      await choices.nth(index).click({ timeout: 5000 });
    const actual = await read();
    if (actual.some((choice, position) => choice.selected !== (position === index)))
      throw new Error("官网角色菜单点击未生效：" + menu.id);
  }
}

export async function clickRoleSearchPage(page: Page, pageNumber: number) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error("角色查询页码无效");
  const link = page.locator(`#pager_bar a[href="javascript:goto(${pageNumber})"]`).first();
  if (!(await link.count()))
    throw new Error("官网角色查询没有可观察的分页链接，未继续请求第" + pageNumber + "页");
  await link.click({ timeout: 5000 });
}

export async function selectRoleSearchAge(page: Page) {
  const option = page
    .locator("#server_type li")
    .filter({ hasText: /^\s*3年以上服\s*$/ })
    .first();
  if (!(await option.isVisible())) {
    const expand = page.locator("#btn_advance_search_fold");
    if (await expand.isVisible()) await expand.click({ timeout: 5000 });
    const title = page.locator('.js_form_title[data-title="转服搜索"]');
    if (!(await option.isVisible()) && (await title.isVisible()))
      await title.click({ timeout: 5000 });
  }
  await option.waitFor({ state: "visible", timeout: 30000 });
  for (const selected of await page.locator("#server_type li.on").all())
    if (!(await selected.innerText()).includes("3年以上服"))
      await selected.click({ timeout: 5000 });
  if (!(await option.evaluate((node) => node.classList.contains("on"))))
    await option.click({ timeout: 5000 });
  await page.waitForFunction(
    () => {
      const selected = document.querySelectorAll("#server_type li.on");
      return selected.length === 1 && selected[0].textContent?.trim() === "3年以上服";
    },
    undefined,
    { timeout: 10000, polling: 250 },
  );
}

export type RoleQueryObservation = { endpoint: string; act: string; args: Record<string, unknown> };
const scalar = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value) || "";
const parameter = (value: unknown) =>
  [...new Set((Array.isArray(value) ? value : [value]).map(scalar))].join(",");
/** Retain every duplicate, including collisions between URL fields and nested form args. */
export function roleRequestObservation(
  rawUrl: string,
  body: string | null,
): RoleQueryObservation | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== "https://xyq.cbg.163.com") return null;
  const params = new URLSearchParams(url.search);
  if (body?.trim().startsWith("{")) {
    try {
      const json: unknown = JSON.parse(body);
      if (!json || typeof json !== "object" || Array.isArray(json)) return null;
      for (const [key, value] of Object.entries(json))
        params.append(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      return null;
    }
  } else for (const [key, value] of new URLSearchParams(body || "")) params.append(key, value);
  const collected = new Map<string, unknown[]>();
  const add = (key: string, value: unknown) =>
    collected.set(key, [...(collected.get(key) || []), value]);
  for (const [key, value] of params) {
    if (key === "args") {
      try {
        const nested: unknown = JSON.parse(value);
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
        for (const [name, field] of Object.entries(nested)) add(name, field);
      } catch {
        return null;
      }
    } else if (key !== "act") add(key, value);
  }
  const args: Record<string, unknown> = {};
  for (const [key, values] of collected) args[key] = values.length === 1 ? values[0] : values;
  const outerAct = params.getAll("act");
  const nestedAct = (collected.get("act") || []).map(String);
  const acts = [...outerAct, ...nestedAct].filter(Boolean);
  return { endpoint: url.origin + url.pathname, act: parameter(acts), args };
}
export function roleScopeEvidence(
  observation: RoleQueryObservation,
  initial = false,
): GlobalMarketRequest {
  const restrictions: Record<string, string> = {};
  for (const [key, value] of Object.entries(observation.args))
    if (
      key !== "server_type" &&
      (/server|area/i.test(key) || ["cross_buy", "cross_server_buy"].includes(key))
    )
      restrictions[key] = parameter(value);
  return {
    endpoint: observation.endpoint,
    act: observation.act,
    searchType:
      observation.act === "recommd_by_role"
        ? parameter(observation.args.search_type)
        : observation.act,
    serverType: parameter(observation.args.server_type),
    page:
      observation.args.page === undefined && initial ? 1 : Number(parameter(observation.args.page)),
    restrictions,
  };
}
export function assertRoleGlobalScope(args: Record<string, unknown>) {
  const evidence = roleScopeEvidence({
    endpoint: "",
    act: "observed-role-scope",
    args: { ...args, page: 1 },
  });
  assertGlobalMarketRequest(evidence, evidence.act, 1);
}

/** Every page, including an empty one, needs its own actual form-bound request evidence. */
// Observed in the live official role-result QueryArgs; not inferred from a school/type ID.
const ROLE_MARKET_ACTION = "overall_search_role";
export function createRoleScopeAudit(
  page: Pick<Page, "on" | "off">,
  form: Pick<RoleSearchForm, "action" | "act">,
) {
  const url = new URL(form.action),
    endpoint = url.origin + url.pathname;
  if (url.origin !== "https://xyq.cbg.163.com" || !form.act)
    throw new Error("官网角色查询 action/act 未确认");
  let expected: number | null = null,
    requests: RoleQueryObservation[] = [],
    market: RoleQueryObservation[] = [],
    errors: string[] = [];
  const observe = (request: Request) => {
    if (
      expected === null ||
      (!request.isNavigationRequest() && !["xhr", "fetch"].includes(request.resourceType()))
    )
      return;
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url());
    } catch {
      return;
    }
    const observation = roleRequestObservation(request.url(), request.postData());
    console.log("[role-audit observe]", {
      url: request.url().slice(0, 80),
      isNavigation: request.isNavigationRequest(),
      resourceType: request.resourceType(),
      act: observation?.act,
      argsAct: observation?.args?.act,
      argsKeys: observation ? Object.keys(observation.args) : [],
    });
    if (
      !observation &&
      requestUrl.origin === "https://xyq.cbg.163.com" &&
      /overall_search_role/.test(requestUrl.search + (request.postData() || ""))
    )
      errors.push("实际角色市场查询参数无法解析");
    if (request.isNavigationRequest() && requestUrl.origin + requestUrl.pathname === endpoint) {
      if (!observation) errors.push("实际角色表单提交参数无法解析");
      else requests.push(observation);
    }
    if (
      observation &&
      (observation.act.split(",").includes(ROLE_MARKET_ACTION) ||
        parameter(observation.args.act).split(",").includes(ROLE_MARKET_ACTION) ||
        parameter(observation.args.search_type).split(",").includes(ROLE_MARKET_ACTION))
    )
      market.push(observation);
  };
  const publicRequest = (value: RoleQueryObservation) => ({
    endpoint: value.endpoint,
    act: value.act,
    args: publicRoleArguments(value.args),
  });
  page.on("request", observe);
  return {
    begin(pageNumber: number) {
      expected = pageNumber;
      requests = [];
      market = [];
      errors = [];
    },
    snapshot() {
      return {
        page: expected,
        errors: [...errors],
        requests: requests.map(publicRequest),
        marketRequests: market.map(publicRequest),
      };
    },
    confirm(queryArgs?: Record<string, unknown>) {
      if (!market.length && expected === 1 && queryArgs && queryArgs.act === ROLE_MARKET_ACTION) {
        market.push({
          endpoint: form.action,
          act: ROLE_MARKET_ACTION,
          args: queryArgs,
        });
      }
      if (expected === null || errors.length || (expected === 1 && !requests.length))
        throw new Error(errors[0] || "整号当前页没有可核实的新表单提交");
      for (const request of requests)
        assertGlobalMarketRequest(roleScopeEvidence(request, expected === 1), form.act, expected);
      if (!market.length) throw new Error("整号当前页没有可核实的实际角色市场查询请求");
      for (const request of market)
        assertGlobalMarketRequest(roleScopeEvidence(request), ROLE_MARKET_ACTION, expected);
      const result = {
        page: expected,
        requests: requests.map(publicRequest),
        marketRequests: market.map(publicRequest),
      };
      expected = null;
      return result;
    },
    close() {
      page.off("request", observe);
      expected = null;
    },
  };
}
function listingLooksRelated(target: SavedRoleRecord, listing: Listing) {
  const core = roleCore(target);
  const summary =
    listing.summary && typeof listing.summary === "object"
      ? (listing.summary as Record<string, unknown>)
      : null;
  const ownSummary =
    target.listing.summary && typeof target.listing.summary === "object"
      ? (target.listing.summary as Record<string, unknown>)
      : null;
  if (
    !summary ||
    !ownSummary ||
    Number(summary.iGrade) !== core.level ||
    summary.iSchool === undefined ||
    Number(summary.iSchool) !== Number(ownSummary.iSchool)
  )
    return false;
  return [
    "iExptSki1",
    "iExptSki2",
    "iExptSki3",
    "iExptSki4",
    "iBeastSki1",
    "iBeastSki2",
    "iBeastSki3",
    "iBeastSki4",
  ].every((key) => {
    const a = Number(ownSummary[key]),
      b = Number(summary[key]);
    return (
      ownSummary[key] !== undefined &&
      summary[key] !== undefined &&
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) <= 3
    );
  });
}

export async function createRoleSource(signal: AbortSignal) {
  signal.throwIfAborted();
  const browser = await getBrowser(true);
  const searchPage = await createHiddenPage(browser);
  let detailPage: Page | null = null,
    closed = false;
  const discover = async () => {
    signal.throwIfAborted();
    const navigation = await readPublicRoleNavigation();
    const entry = navigation.find(
      (value) => value.id === "sub_role" || /角色(?:搜索|查询)|重新(?:查|搜)/.test(value.label),
    );
    if (!entry)
      throw new Error(
        "当前项目工作页没有可确认的角色查询入口，请先用 mode=navigation 检查公开导航",
      );
    await searchPage.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await assertRoleFormReadable(searchPage);
    await searchPage
      .locator('form[name="query_form"]')
      .waitFor({ state: "attached", timeout: 30_000 });
    await selectRoleSearchAge(searchPage);
    signal.throwIfAborted();
    return readRoleSearchForm(searchPage);
  };
  return {
    discover,
    navigation: readPublicRoleNavigation,
    async search(target: SavedRoleRecord, selections?: RoleSearchSelections) {
      const form = await discover();
      const generated = selections === undefined ? buildRoleSearchQuery(target, form) : null;
      selections ||= generated!;
      await applyRoleSearchSelections(searchPage, form, selections);
      await selectRoleSearchAge(searchPage);
      await clearServerFilter(searchPage);
      await searchPage.locator('form[name="query_form"]').evaluate((node) => {
        (node as HTMLFormElement).target = "_self";
      });
      const audit = createRoleScopeAudit(searchPage, form);
      const pageAudits: ReturnType<typeof audit.confirm>[] = [];
      try {
        const responseError = async (error: unknown) => {
          let response: unknown;
          try {
            response = await roleResponseDiagnostic(searchPage);
          } catch {
            response = { closed: searchPage.isClosed(), diagnosticUnavailable: true };
          }
          return new Error(
            (error instanceof Error ? error.message : "角色查询响应失败") +
              "；公开查询诊断：" +
              JSON.stringify({ response, audit: audit.snapshot() }),
          );
        };
        let listingPage, queryArgs;
        try {
          audit.begin(1);
          await searchPage.locator("#btn_do_query").click({ timeout: 30000, noWaitAfter: true });
          await waitList(searchPage, 1);
          listingPage = await readListings(searchPage);
          queryArgs = await searchPage.evaluate(
            () => (window as Window & { QueryArgs?: Record<string, unknown> }).QueryArgs || {},
          );
          assertRoleGlobalScope(queryArgs);
          pageAudits.push(audit.confirm(queryArgs));
        } catch (error) {
          throw await responseError(error);
        }
        detailPage = await createHiddenPage(browser);
        const freshRecord = async (listing: Listing): Promise<SavedRoleRecord | null> => {
          signal.throwIfAborted();
          if (!(await isOnShelf(detailPage!, listing, signal))) return null;
          const detail = await collectDetail(detailPage!, listing, signal);
          if (
            String(detail.valuation?.source.eid) !== listing.eid ||
            String(detail.valuation?.source.serverId) !== listing.serverId
          )
            throw new Error("整号详情身份与候选链接不一致");
          const asking = detail.valuation?.source.askingPrice;
          const price =
            typeof asking === "string" || typeof asking === "number" ? String(asking) : "";
          if (!/^\d+(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0)
            throw new Error("整号详情没有有效挂牌价格");
          if (!(await isOnShelf(detailPage!, listing, signal))) return null;
          return { listing: { ...listing, price }, detail, status: "complete", error: null };
        };
        const freshTarget = await freshRecord(target.listing);
        if (!freshTarget) throw new Error("目标角色已不在售，暂不能校验当前整号参考");
        const candidates: RoleMarketCandidate[] = [],
          skipped: { key: string; url: string; reason: string }[] = [];
        const seen = new Set<string>([target.listing.key]);
        let pages = 0,
          rows = 0,
          details = 0,
          exhausted = false;
        for (let pageNumber = 1; pageNumber <= Math.min(3, listingPage.totalPages); pageNumber++) {
          if (pageNumber > 1) {
            try {
              audit.begin(pageNumber);
              await pace(signal);
              await clickRoleSearchPage(searchPage, pageNumber);
              await waitList(searchPage, pageNumber);
              listingPage = await readListings(searchPage);
              assertRoleGlobalScope(
                await searchPage.evaluate(
                  () =>
                    (window as Window & { QueryArgs?: Record<string, unknown> }).QueryArgs || {},
                ),
              );
              pageAudits.push(audit.confirm());
            } catch (error) {
              throw await responseError(error);
            }
          }
          pages++;
          for (const listing of listingPage.items) {
            signal.throwIfAborted();
            rows++;
            if (seen.has(listing.key)) continue;
            seen.add(listing.key);
            if (!listingLooksRelated(freshTarget, listing)) {
              skipped.push({
                key: listing.key,
                url: listing.url,
                reason: "列表等级/门派/修炼不符或证据不足",
              });
              continue;
            }
            if (details >= 8) break;
            details++;
            await pace(signal);
            const record = await freshRecord(listing);
            if (!record) {
              skipped.push({ key: listing.key, url: listing.url, reason: "详情前后未确认在售" });
              continue;
            }
            const match = compareRoleConfiguration(freshTarget, record);
            candidates.push({
              key: listing.key,
              url: listing.url,
              title: listing.name,
              price: Number(record.listing.price),
              active: true,
              serverAge: "older",
              fetchedAt: new Date().toISOString(),
              sourceHash: roleSourceHash(record),
              ...match,
              record,
            });
            if (buildRoleMarketReference(candidates, target.listing.key).status === "range") break;
          }
          if (
            buildRoleMarketReference(candidates, target.listing.key).status === "range" ||
            details >= 8
          )
            break;
          exhausted = pageNumber === listingPage.totalPages;
        }
        signal.throwIfAborted();
        return {
          target: freshTarget,
          form,
          selections,
          queryGeneration: generated
            ? { policy: generated.policy, omitted: generated.omitted }
            : null,
          queryArgs,
          actualRequests: pageAudits.flatMap((value) => [
            ...value.requests,
            ...value.marketRequests,
          ]),
          pageAudits,
          pages,
          rows,
          details,
          exhausted,
          candidates,
          skipped,
          marketReference: buildRoleMarketReference(candidates, target.listing.key),
        };
      } finally {
        audit.close();
      }
    },
    async close() {
      if (!closed) {
        closed = true;
        await Promise.allSettled([searchPage.close(), ...(detailPage ? [detailPage.close()] : [])]);
      }
    },
  };
}
