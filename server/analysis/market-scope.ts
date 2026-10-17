import type { Page, Request } from "playwright-core";

export const GLOBAL_MARKET_SCOPE_VERSION = "role-server-v1";
// Old snapshots did not reject all restored filters; their quotes need a fresh query.
export const MARKET_SEARCH_UI_VERSION = "official-form-ui-v2";

export type GlobalMarketRequest = {
  endpoint: string;
  act: string;
  searchType: string;
  serverType: string;
  page: number;
  orderBy?: string;
  restrictions: Record<string, string>;
};

const MARKET_ACTIONS = new Set([
  "overall_search_equip",
  "overall_search_lingshi",
  "yupo_search",
  "overall_search_pet",
  "overall_search_pet_equip",
  "overall_search_role",
]);
const RESTRICTION_KEYS = new Set([
  "serverid",
  "server_id",
  "serverids",
  "server_ids",
  "server",
  "servers",
  "server_list",
  "servers_list",
  "server_sn",
  "serversn",
  "server_name",
  "areaid",
  "area_id",
  "areaids",
  "area_ids",
  "area",
  "areas",
  "area_list",
  "area_name",
  "cross_buy_serverid",
  "cross_buy_areaid",
]);

function parameter(params: URLSearchParams, name: string) {
  return [...new Set(params.getAll(name))].join(",");
}

/** Retain public search scope only; never retain raw URLs, headers or credentials. */
export function marketRequestEvidence(
  rawUrl: string,
  body?: string | null,
  observedSearchTypes: readonly string[] = [],
): GlobalMarketRequest | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== "https://xyq.cbg.163.com") return undefined;
  const params = new URLSearchParams(url.search);
  if (body) {
    let form: URLSearchParams;
    try {
      if (body.trim().startsWith("{")) {
        const json: unknown = JSON.parse(body);
        if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
        form = new URLSearchParams();
        for (const [key, value] of Object.entries(json))
          if (typeof value === "string" || typeof value === "number")
            form.append(key, String(value));
      } else form = new URLSearchParams(body);
    } catch {
      return undefined;
    }
    for (const [key, value] of form) params.append(key, value);
  }
  const act = parameter(params, "act");
  const searchType = act === "recommd_by_role" ? parameter(params, "search_type") : act;
  if (!MARKET_ACTIONS.has(searchType) && !observedSearchTypes.includes(searchType))
    return undefined;
  const restrictions: Record<string, string> = {};
  for (const key of RESTRICTION_KEYS)
    if (params.has(key)) restrictions[key] = parameter(params, key);
  return {
    endpoint: url.origin + url.pathname,
    act,
    searchType,
    serverType: parameter(params, "server_type"),
    page: Number(parameter(params, "page")),
    ...(params.has("order_by") ? { orderBy: parameter(params, "order_by") } : {}),
    restrictions,
  };
}

export function assertMarketServerId(serverId: string) {
  if (typeof serverId !== "string" || !/^[1-9]\d*$/.test(serverId))
    throw new Error("目标服务器 ID 缺失或无效，未发起单服查价");
}

/** Select public official controls; never change a hidden argument or use the login server. */
export async function selectMarketServer(page: Page, serverId: string, signal: AbortSignal) {
  assertMarketServerId(serverId);
  signal.throwIfAborted();
  const areaId = await page.evaluate(function marketServerArea(target) {
    const directory = (window as unknown as { server_data?: Record<string, unknown> }).server_data;
    const area = document.getElementById("overall_sel_area") as HTMLSelectElement | null;
    if (!directory || typeof directory !== "object" || !area)
      throw new Error("官网单服区服目录或选择控件缺失");
    const available = new Set(Array.from(area.options, (option) => option.value));
    for (const [id, group] of Object.entries(directory)) {
      if (!available.has(id) || !Array.isArray(group) || !Array.isArray(group[1])) continue;
      if (group[1].some((server: unknown) => Array.isArray(server) && String(server[0]) === target))
        return id;
    }
    throw new Error("官网单服目录没有目标服务器，未采用报价");
  }, serverId);
  signal.throwIfAborted();
  await page.locator("#overall_sel_area").selectOption(areaId);
  await page.waitForFunction(
    (target) => {
      const server = document.getElementById("ovarall_sel_server") as HTMLSelectElement | null;
      return !!server && Array.from(server.options).some((option) => option.value === target);
    },
    serverId,
    { timeout: 10_000 },
  );
  signal.throwIfAborted();
  await page.locator("#ovarall_sel_server").selectOption(serverId);
  const selected = await page.evaluate(function selectedMarketServer() {
    return {
      areaId: (document.getElementById("overall_sel_area") as HTMLSelectElement | null)?.value,
      serverid: (document.getElementById("ovarall_sel_server") as HTMLSelectElement | null)?.value,
    };
  });
  signal.throwIfAborted();
  if (selected.areaId !== areaId || selected.serverid !== serverId)
    throw new Error("官网单服选择未生效，未采用报价");
  return {
    areaId,
    serverid: serverId,
    actions: [
      { control: "overall_sel_area", value: areaId, method: "selectOption" },
      { control: "ovarall_sel_server", value: serverId, method: "selectOption" },
    ],
  };
}

export function assertMarketRequest(
  request: GlobalMarketRequest,
  act: string,
  page: number,
  serverId: string,
) {
  assertMarketServerId(serverId);
  if (
    request.searchType !== act ||
    request.page !== page ||
    !Number.isSafeInteger(page) ||
    page < 1
  )
    throw new Error("实际市场查询的类别或页码不符，未采用报价");
  if (request.restrictions.serverid !== serverId)
    throw new Error("实际市场查询未限定目标单服，未采用报价");
  if (request.serverType !== "" && request.serverType !== "0")
    throw new Error("实际单服查询仍有额外开服时间限制，未采用报价");
  if (
    Object.entries(request.restrictions).some(
      ([key, value]) => key !== "serverid" && value.trim() !== "" && value !== "0",
    )
  )
    throw new Error("实际单服查询仍有额外服务器或地区限制，未采用报价");
}

/** Observe the program's own final browser requests rather than a pre-helper argument object. */
export function createMarketScopeAudit(
  page: Pick<Page, "on" | "off">,
  serverId: string,
  observedSearchTypes: readonly string[] = [],
) {
  assertMarketServerId(serverId);
  if (observedSearchTypes.some((act) => !/^(?!show_)[a-z_]*yuanshen[a-z_]*$/.test(act)))
    throw new Error("未确认元身页面的公开查询动作");
  let expected: { act: string; page: number } | undefined;
  let requests: GlobalMarketRequest[] = [];
  const observe = (request: Request) => {
    if (!expected) return;
    const evidence = marketRequestEvidence(request.url(), request.postData(), observedSearchTypes);
    if (evidence?.searchType === expected.act && evidence.page === expected.page)
      requests.push(evidence);
  };
  page.on("request", observe);
  return {
    begin(act: string, pageNumber: number) {
      if (!MARKET_ACTIONS.has(act) && !observedSearchTypes.includes(act))
        throw new Error("不支持核验此市场查询类别");
      expected = { act, page: pageNumber };
      requests = [];
    },
    confirm(): GlobalMarketRequest {
      if (!expected || !requests.length)
        throw new Error("尚未核验单服搜索的实际网络请求，未采用报价");
      for (const request of requests)
        assertMarketRequest(request, expected.act, expected.page, serverId);
      return structuredClone(requests[requests.length - 1]);
    },
    close() {
      page.off("request", observe);
      expected = undefined;
      requests = [];
    },
  };
}
