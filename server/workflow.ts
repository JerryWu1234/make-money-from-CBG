import type { Page } from "playwright-core";
import { CBG_HOME_URL } from "./config";
import { buildPageState, readPageSnapshot, type PageSnapshot } from "./page-state";
import type { OpenCbgResult, RoleList, WorkflowStep } from "./types";

type Publish = (state: Partial<OpenCbgResult>) => void;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isNavigationTransition(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context|interrupted by another navigation|net::ERR_ABORTED/i.test(
      error.message,
    )
  );
}

export async function readStableSnapshot(page: Page, timeout = 10000): Promise<PageSnapshot> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await page.evaluate(readPageSnapshot);
    } catch (error) {
      if (page.isClosed() || !isNavigationTransition(error) || Date.now() >= deadline) throw error;
      await pause(200);
    }
  }
}

export async function clickInWorkPage(page: Page, selector: string): Promise<void> {
  const element = page.locator(selector).first();
  await element.waitFor({ state: "visible", timeout: 30000 });
  // DOM 点击触发网站原有逻辑；不等待 click 自带的导航超时，不激活后台窗口。
  try {
    await element.evaluate((node) => {
      if (node instanceof HTMLAnchorElement) node.target = "_self";
      (node as HTMLElement).click();
    });
  } catch (error) {
    // 点击已经触发导航时，不重放点击，交给目标页面的确认步骤。
    if (!isNavigationTransition(error)) throw error;
  }
}

export async function selectServerAge(
  page: Page,
  panel: "#server_type_panel" | "#server_type",
): Promise<void> {
  const option = page.locator(`${panel} li`).filter({ hasText: "3年以上服" }).first();
  if (panel === "#server_type" && !(await option.isVisible())) {
    const expand = page.locator("#btn_advance_search_fold");
    if (await expand.isVisible()) await expand.evaluate((el) => (el as HTMLElement).click());
    const title = page.locator('.js_form_title[data-title="转服搜索"]');
    if (!(await option.isVisible()) && (await title.isVisible()))
      await title.evaluate((el) => (el as HTMLElement).click());
  }
  await option.waitFor({ state: "visible", timeout: 30000 });
  // 删除同组其他年龄条件，避免保存的搜索条件把 1 到 3 年服也包含进来。
  for (const selected of await page.locator(`${panel} li.on`).all()) {
    if (!(await selected.innerText()).includes("3年以上服"))
      await selected.evaluate((el) => (el as HTMLElement).click());
  }
  if (!(await option.evaluate((el) => el.classList.contains("on")))) {
    await option.evaluate((el) => (el as HTMLElement).click());
  }
  await page.waitForFunction(
    (panelSelector) => {
      const choices = Array.from(document.querySelectorAll(`${panelSelector} li.on`));
      return choices.length === 1 && choices[0].textContent?.trim() === "3年以上服";
    },
    panel,
    { timeout: 10000, polling: 250 },
  );
}

export async function readRoleList(page: Page): Promise<RoleList> {
  return page.evaluate(() => {
    const args = (
      window as Window & {
        QueryArgs?: { server_type?: string | number; serverid?: string | number };
      }
    ).QueryArgs;
    if (String(args?.server_type) !== "3")
      throw new Error("角色列表未保留 3 年以上服条件，已停止。");
    const serverId = args?.serverid == null ? "" : String(args.serverid).trim();
    if (serverId && serverId !== "0") throw new Error("角色列表仍限定单个服务器，已停止。");
    const table = document.querySelector<HTMLTableElement>("#soldList");
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const columns = table
      ? Array.from(table.querySelectorAll("th")).map((cell) => clean(cell.innerText))
      : [];
    const rows = table
      ? Array.from(table.querySelectorAll("tr"))
          .filter((row) => row.querySelector("td"))
          .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => clean(cell.innerText)))
      : [];
    const empty = document.querySelector<HTMLElement>("#query_result")?.innerText || "";
    if (!rows.length && !empty.includes("没有符合条件")) throw new Error("角色列表尚未加载完成。");
    return {
      columns,
      rows,
      serverAge: "3年以上服",
      ...(!rows.length ? { emptyMessage: "没有符合条件的角色" } : {}),
    };
  });
}

export async function clearServerFilter(page: Page): Promise<void> {
  const cleared = await page.locator('form[name="query_form"]').evaluate((form) => {
    const queryForm = form as HTMLFormElement;
    const globals = window as Window & {
      QueryArgs?: Record<string, unknown>;
    };
    const args = form.querySelector<HTMLInputElement>('input[name="args"]');
    const removeServerFilter = () => {
      if (globals.QueryArgs) delete globals.QueryArgs.serverid;
      if (!args?.value) return;
      try {
        const value: unknown = JSON.parse(args.value);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          delete (value as Record<string, unknown>).serverid;
          args.value = JSON.stringify(value);
        }
      } catch {
        /* 网站尚未写入查询参数，提交时会再检查。 */
      }
    };
    const submit = queryForm.submit.bind(queryForm);
    queryForm.submit = () => {
      removeServerFilter();
      submit();
    };
    form.addEventListener("submit", removeServerFilter);
    removeServerFilter();
    return !globals.QueryArgs || !Object.hasOwn(globals.QueryArgs, "serverid");
  });
  if (!cleared) throw new Error("无法清除跨服搜索的单服务器限制。");
}

export async function completeLogin(
  page: Page,
  publish: Publish,
  timeout = 10 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let enteredServer = false;
  let submittedAt = 0;
  while (Date.now() < deadline) {
    const snapshot = await readStableSnapshot(page);
    const state = buildPageState(snapshot);
    publish({
      ...state,
      qrCodeUrl: state.qrCodeUrl,
      accountUrs: state.accountUrs,
      nickname: state.nickname,
      selectedRoleId: state.selectedRoleId,
      running: true,
      workflowStep: "logging_in",
    });
    if (state.isLoggedIn) return;
    if (snapshot.hasDialog) {
      const button = page
        .locator(".popupDialog a, .popupDialog button, .dialogWrap a")
        .filter({ hasText: /^我知道了$/ })
        .first();
      if (await button.isVisible()) await button.evaluate((el) => (el as HTMLElement).click());
    } else if (snapshot.hasRoles && !snapshot.hasQr) {
      if (!submittedAt) {
        const role = page.locator('li[id^="role_el_"]:visible').first();
        const image = role.locator("img").first();
        await ((await image.count()) ? image : role).evaluate((el) => (el as HTMLElement).click());
        submittedAt = Date.now();
        await clickInWorkPage(page, "#login_btn");
      } else if (Date.now() - submittedAt > 45000) {
        throw new Error("角色已提交，但网站尚未确认进入服务器。请重试；不会重复点击登录。");
      }
      publish({
        step: "entering_server",
        qrCodeUrl: undefined,
        message: "角色已提交，正在等待网站确认登录…",
      });
    } else if (new URL(snapshot.url).pathname === "/" && !enteredServer) {
      if (await page.locator("#server_pos_1_a").isVisible()) {
        enteredServer = true;
        await clickInWorkPage(page, "#server_pos_1_a");
      }
    }
    await pause(750);
  }
  throw new Error("等待扫码登录超时，请点击重新开始获取当前二维码。");
}

export async function runFixedWorkflow(page: Page, publish: Publish): Promise<OpenCbgResult> {
  const stage = (workflowStep: WorkflowStep, message: string) =>
    publish({ workflowStep, message, running: true, qrCodeUrl: undefined });
  stage("logging_in", "正在后台打开藏宝阁并读取登录状态…");
  try {
    await page.goto(CBG_HOME_URL, { waitUntil: "commit", timeout: 60000 });
  } catch (error) {
    if (!isNavigationTransition(error)) throw error;
  }
  await completeLogin(page, publish);

  stage("cross_server", "已登录，正在进入跨服购买…");
  await clickInWorkPage(page, "#cross_server_buy");
  await page.locator("#server_type_panel li").first().waitFor({ state: "visible", timeout: 30000 });
  stage("server_age", "正在选择开服时间：3年以上服…");
  await selectServerAge(page, "#server_type_panel");

  stage("role_search", "正在进入角色搜索，并确认开服时间条件…");
  await clickInWorkPage(page, "#sub_role");
  await page.locator("#btn_do_query").waitFor({ state: "visible", timeout: 30000 });
  await selectServerAge(page, "#server_type");
  await clearServerFilter(page);
  await page.locator('form[name="query_form"]').evaluate((form) => {
    (form as HTMLFormElement).target = "_self";
  });
  stage("role_list", "正在加载3年以上服的角色列表…");
  await clickInWorkPage(page, "#btn_do_query");
  await page.waitForFunction(
    () => {
      const globals = window as Window & {
        QueryArgs?: { server_type?: string | number };
        CaptchaCheck?: { need_captcha?: boolean };
      };
      if (globals.CaptchaCheck?.need_captcha)
        throw new Error("网站要求安全验证，请完成验证后重试。");
      return (
        String(globals.QueryArgs?.server_type) === "3" &&
        (Boolean(document.querySelector("#soldList td")) ||
          document.querySelector<HTMLElement>("#query_result")?.innerText.includes("没有符合条件"))
      );
    },
    undefined,
    { timeout: 45000, polling: 250 },
  );
  const roleList = await readRoleList(page);
  const auth = buildPageState(await readStableSnapshot(page));
  if (!auth.isLoggedIn) throw new Error("网站登录状态已失效，请重新扫码后继续。");
  return {
    ...auth,
    running: false,
    workflowStep: "completed",
    roleList,
    message: `已进入3年以上服的角色列表，当前页 ${roleList.rows.length} 条。`,
  };
}
