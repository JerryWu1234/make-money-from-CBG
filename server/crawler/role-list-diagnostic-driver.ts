import type { Locator, Page } from "playwright-core";
import { createHash } from "node:crypto";
import { officialPageContext, officialPageSignal } from "../official-access";
import { clickForInspection } from "../viewport";
import {
  createRoleListDiagnostic,
  ROLE_DIAGNOSTIC_FIELDS,
  type RoleDiagnosticSnapshot,
} from "../query-health/role-list-diagnostics";
import type { QueryIdentity } from "../query-health/store";

/** Only public form controls and existing page links are operated. No QueryArgs assignment. */
export function createPlaywrightRoleDiagnostic(
  page: Page,
  original: QueryIdentity,
  lifecycle: {
    available(page: Page): Promise<void>;
    observe(page: Page): Promise<void>;
    wait(page: Page, wanted: number, requireCommit: boolean): Promise<void>;
    clear(page: Page): Promise<void>;
  },
) {
  const signal = officialPageSignal(page) ?? new AbortController().signal;
  let revision = 1;
  const snapshot = async (): Promise<RoleDiagnosticSnapshot> => {
    signal.throwIfAborted();
    await lifecycle.available(page);
    const value = await page.evaluate(
      (fields) => {
        const globals = window as Window & {
          QueryArgs?: Record<string, string | number>;
          QueryResult?: unknown[];
        };
        const args = globals.QueryArgs || {};
        const conditions = Object.fromEntries(
          Object.entries(args).filter(
            ([key, value]) =>
              !["page", "order_by"].includes(key) &&
              (typeof value === "string" || typeof value === "number") &&
              !/token|cookie|auth|password|fingerprint|session|signature|safe_code|nickname|account|^fp$|^sign$/i.test(
                key,
              ),
          ),
        );
        const form: Record<string, string> = {};
        for (const key of fields) {
          const controls = [
            ...document.querySelectorAll<HTMLInputElement>(
              `form input[name="${key}"],input#${key}`,
            ),
          ].filter((node) => node.checkVisibility());
          if (controls.length === 1) form[key] = controls[0].value;
        }
        const count = document.querySelectorAll("#soldList a.soldImg[href]").length;
        const pager = document.querySelector<HTMLElement>("#pager_bar")?.innerText || "";
        const empty = !!document
          .querySelector<HTMLElement>("#query_result")
          ?.innerText.includes("没有符合条件");
        const loading = [
          ...document.querySelectorAll("#LoadingCover,#LoadingImg,#loading_img"),
        ].some((node) => node.checkVisibility());
        return {
          conditions,
          fields: form,
          page: Number(pager.match(/第\s*(\d+)\s*页/)?.[1] || args.page || 1),
          sort: String(args.order_by || ""),
          evidence: {
            count,
            loaded: !loading,
            committed: Array.isArray(globals.QueryResult) && globals.QueryResult.length === count,
            emptyMarker: empty,
            identityMatched: true,
          },
        };
      },
      [...ROLE_DIAGNOSTIC_FIELDS],
    );
    const context = officialPageContext(page);
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return {
      ...value,
      revision: `${context?.pageId || "fixture"}:${context?.pageGeneration || 0}:${revision}:${digest}`,
    };
  };
  const unique = async (target: Locator, label: string) => {
    if ((await target.count()) !== 1 || !(await target.isVisible()))
      throw new Error(`角色诊断缺少唯一可见的${label}入口`);
    return target;
  };
  const click = async (target: Locator, wanted: number) => {
    signal.throwIfAborted();
    await lifecycle.available(page);
    await lifecycle.observe(page);
    try {
      await clickForInspection(target, signal);
      await lifecycle.wait(page, wanted, true);
      revision++;
    } finally {
      await lifecycle.clear(page).catch(() => {});
    }
  };
  return createRoleListDiagnostic(
    {
      snapshot,
      field: async (field, value) => {
        const target = await unique(
          page.locator(`form input[name="${field}"],input#${field}`).filter({ visible: true }),
          field,
        );
        await target.fill(value);
      },
      submit: async () => {
        const target = page
          .locator(
            '#searchForm button[type="submit"],#searchForm input[type="submit"],#query_form button[type="submit"],#query_form input[type="submit"],form[name="query_form"] button[type="submit"],form[name="query_form"] input[type="submit"],#btn_search',
          )
          .filter({ visible: true });
        await click(await unique(target, "官网搜索"), 1);
      },
      sort: async (value) => {
        const field = value.split(" ")[0];
        const target = await unique(
          page.locator(`#order_menu a[data_attr_name="${field}"]`).filter({ visible: true }),
          "官网排序",
        );
        // The public control may expose ASC after its first click. A second click is
        // allowed only after that exact, successfully committed intermediate state.
        await click(target, 1);
        const observed = await snapshot();
        if (observed.sort === `${field} ASC`) await click(target, 1);
      },
      page: async (value) => {
        const target = await unique(
          page.locator(`#pager_bar a[href="javascript:goto(${value})"]`).filter({ visible: true }),
          "官网分页",
        );
        await click(target, value);
      },
    },
    original,
  );
}
