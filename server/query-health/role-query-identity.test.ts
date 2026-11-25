import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";
import { AccessGovernor, type AccessContext } from "../access";
import { bindQueryPage, beginPageQuery, queryPageContext } from "./runtime";
import { beginRoleListQuery, readListings } from "../crawler/page";
import { hasLoginRequiredDialog } from "../crawler/login-dialog";
it("T08/T10 翻页新增筛选条件不与原查询合并，空尾页不能推进", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const gate = new AccessGovernor(db),
      owner = gate.acquireOwner("test");
    const context: AccessContext = {
      ...owner,
      stopEpoch: 0,
      runId: "run",
      queryId: "query",
      pageId: "page",
      pageGeneration: 1,
      browserSessionEpoch: "session",
      sourceKind: "test",
    };
    gate.registerPage(context);
    let data = {
      page: 1,
      totalPages: 2,
      order: "selling_time DESC",
      conditions: { server_type: "1,2,3" } as Record<string, string>,
      loading: false,
      empty: true,
      committed: true,
      items: [],
    };
    const page = {
      evaluate: async (fn: Function) =>
        fn === hasLoginRequiredDialog
          ? false
          : String(fn).includes("globals.CaptchaCheck")
            ? ""
            : data,
      isClosed: () => false,
      url: () => "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    } as unknown as Page;
    bindQueryPage(page, gate, context);
    beginPageQuery(page, {
      category: "role",
      server: "all",
      serverAge: "1,2,3",
      conditions: data.conditions,
      page: 1,
      sort: data.order,
    });
    await readListings(page);
    beginRoleListQuery(page, 2);
    data = { ...data, page: 2, conditions: { ...data.conditions, price_min: "999999" } };
    await expect(readListings(page)).rejects.toMatchObject({ name: "QueryHealthError" });
    expect(gate.read().state).toBe("ready");
    expect(() =>
      gate.withProgress(queryPageContext(page)!, () =>
        db.exec("CREATE TABLE incorrectly_completed(id)"),
      ),
    ).toThrow();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='incorrectly_completed'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
