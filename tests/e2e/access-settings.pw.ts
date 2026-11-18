import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AccessGovernor } from "../../server/access";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

test("暂停原因、人工继续与策略更新保留同一风险版本", async ({ page }, info) => {
  const db = new DatabaseSync(":memory:"),
    gate = new AccessGovernor(db);
  gate.reportRisk({ reason: "login" });
  let rejectRecovery = true;
  const requests: unknown[] = [];
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/crawl/role-training-filter")
      return route.fulfill({ json: { minTotal: null } });
    if (url.origin !== "http://access-ui.test") return route.abort();
    if (url.pathname === "/api/access/status") return route.fulfill({ json: gate.read() });
    if (url.pathname === "/api/access/recover") {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (rejectRecovery) {
        gate.reportRisk({ reason: "verification" });
        return route.fulfill({
          status: 409,
          json: { error: "访问状态已变化，请重新核对全部原因" },
        });
      }
      const owner = gate.acquireOwner("test-recovery"),
        token = gate.beginRecovery(body.revision, owner);
      return route.fulfill({ json: gate.finishRecovery(token, body.acknowledgedReasons) });
    }
    if (url.pathname === "/api/access/policy") {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: gate.updatePolicy(body.policy, body.revision) });
    }
    if (url.pathname.startsWith("/api/")) {
      const responses: Record<string, unknown> = {
        "/api/browser/status": browserStatus,
        "/api/browser/settings": {
          mode: "dedicated",
          accessAdapter: "playwright",
          connected: true,
          busy: false,
        },
        "/api/runtime/settings": { saveScreenshots: false },
        "/api/crawl/settings": { analyzeEquipment: false },
        "/api/crawl/status": crawlStatus(false, false),
        "/api/crawl/records": { page: 1, total: 0, totalPages: 1, items: [] },
        "/api/crawl/head-refresh": { intervalSeconds: 60, random: false, listingAgeMinutes: 10 },
        "/api/scan/status": {
          config: {
            scheduleType: "daily",
            daily: { startTime: "09:00" },
            days: [],
            maxDurationMinutes: null,
          },
          mode: "disabled",
          state: "disabled",
          message: "未启用",
          timezone: "Asia/Shanghai",
        },
      };
      return route.fulfill({ json: responses[url.pathname] ?? {} });
    }
    const file = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(file),
    });
  });
  try {
    await page.goto("http://access-ui.test");
    const panel = page.getByRole("region", { name: "官网访问保护" });
    await expect(panel).toContainText("登录失效");
    const resume = panel.getByRole("button", { name: "核验页面并人工继续" });
    await expect(resume).toBeDisabled();
    await panel.getByRole("checkbox", { name: "我已在绑定页面处理全部暂停原因" }).check();
    await resume.click();
    await expect(panel.getByRole("alert")).toContainText("访问状态已变化");
    await expect(panel).toContainText("安全验证");
    await expect(resume).toBeDisabled();
    await panel.getByText("访问节奏与诊断设置").click();
    await panel.getByLabel("最小动作间隔（毫秒）", { exact: true }).fill("8000");
    await panel.getByRole("button", { name: "保存访问策略" }).click();
    await expect.poll(() => gate.read().policy.minIntervalMs).toBe(8000);
    expect(gate.read().state).toBe("needs_action");
    await panel.screenshot({ path: info.outputPath("access-protection.png") });
    gate.reportRisk({
      reason: "query_manual_verification",
      queryDiagnostic: {
        eventId: "offline-diagnostic-restoration",
        queryId: "offline-original-query",
        code: "restoration_failed",
        probeCode: "unsupported_condition",
        restoration: "failed",
        unsupportedFields: ["price_min"],
        nextAction: "restore_original_query",
      },
    });
    await expect(panel).toContainText("原条件、排序或页码未确认恢复");
    await expect(panel).toContainText("下一步：恢复原条件、排序和页码");
    await expect(panel).toContainText("需人工核对的字段：price_min");
    await expect(resume).toBeDisabled();
    await panel.getByText("访问节奏与诊断设置").click();
    await panel.screenshot({ path: info.outputPath("query-restoration-required.png") });
    rejectRecovery = false;
    await panel.getByRole("checkbox", { name: "我已在绑定页面处理全部暂停原因" }).check();
    await resume.click();
    await expect(panel).toContainText("可以开始官网任务");
    expect(requests).toHaveLength(2);
  } finally {
    db.close();
  }
});
