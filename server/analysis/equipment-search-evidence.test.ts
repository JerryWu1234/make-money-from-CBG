import { beforeEach, expect, it, vi } from "vite-plus/test";
import { errors, type Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { equipmentSearchEvidence } from "./equipment-search-evidence";
import type { EquipmentEvidenceCapture } from "./browser-equipment-source";
import { readFileSync } from "node:fs";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import { createProfile, PROMPT_FILE } from "./profile";
import { equipmentPricingPlan } from "./equipment-pricing";
import { finishPricingSearch } from "./pricing-progress";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
const diagnosticRecord = vi.hoisted(() => vi.fn());
vi.mock("../diagnostics", () => ({ diagnostics: { record: diagnosticRecord } }));
beforeEach(() => vi.resetAllMocks());
const input = {
  stage: "filled",
  equipmentKey: "道具/法宝:0",
  equipmentName: "测试剑",
  description: "伤害632；5段太阳石",
  mode: "base-attributes",
  page: 1,
  plannedArgs: { init_damage_raw: 592, serverid: "1" },
  form: { controls: [{ id: "txt_init_damage_raw", value: "592" }] },
} as unknown as Parameters<EquipmentEvidenceCapture>[1];
it("截图与真实填写参数按角色和装备绑定，稳定性核验通过后保存", async () => {
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("fixture-png"));
  const page = { screenshot, locator: vi.fn() } as unknown as Page;
  const verify = vi.fn().mockResolvedValue(undefined);
  const result = await equipmentSearchEvidence("fixture:role", "1")(page, input, verify);
  expect(verify).toHaveBeenCalledOnce();
  expect(screenshot).toHaveBeenCalledWith(
    expect.objectContaining({
      fullPage: true,
      timeout: 15_000,
      animations: "disabled",
      scale: "css",
    }),
  );
  expect(mkdir).toHaveBeenCalledOnce();
  expect(writeFile).toHaveBeenCalledTimes(2);
  const written = vi.mocked(writeFile).mock.calls[1][1];
  expect(typeof written).toBe("string");
  const json = JSON.parse(written as string);
  expect(json).toMatchObject({
    productKey: "fixture:role",
    serverId: "1",
    equipmentKey: "道具/法宝:0",
    plannedArgs: { init_damage_raw: 592 },
    form: { controls: [{ id: "txt_init_damage_raw", value: "592" }] },
  });
  expect(result.screenshotSha256).toMatch(/^[a-f0-9]{64}$/);
});
it("截图期间表单变化时不保存图片或参数，不产生成功凭证", async () => {
  const page = {
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fixture-png")),
    locator: vi.fn(),
  } as unknown as Page;
  await expect(
    equipmentSearchEvidence("fixture:role", "1")(page, input, async () => {
      throw new Error("表单已变化");
    }),
  ).rejects.toThrow("表单已变化");
  expect(writeFile).not.toHaveBeenCalled();
});

it("字体已加载后的截图超时也重试，重新核验表单后保留真实截图和重试次数", async () => {
  const screenshot = vi
    .fn()
    .mockRejectedValueOnce(
      new errors.TimeoutError("page.screenshot: Timeout 5000ms exceeded. fonts loaded"),
    )
    .mockResolvedValueOnce(Buffer.from("recovered-png"));
  const verify = vi.fn().mockResolvedValue(undefined);
  await equipmentSearchEvidence("fixture:role", "1")(
    { screenshot, locator: vi.fn() } as unknown as Page,
    input,
    verify,
  );
  expect(screenshot).toHaveBeenCalledTimes(2);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(writeFile).toHaveBeenCalledTimes(2);
  const json = JSON.parse(vi.mocked(writeFile).mock.calls[1][1] as string);
  expect(json).toMatchObject({ screenshotAttempts: 2, screenshotTimeoutMs: 15_000 });
  expect(diagnosticRecord).toHaveBeenCalledWith(
    "equipment.evidence_screenshot_failed",
    expect.objectContaining({ attempt: 1, stage: "filled" }),
  );
});

it("连续截图超时最多两次，缺少截图不生成报价凭证", async () => {
  const error = new errors.TimeoutError("page.screenshot: Timeout 15000ms exceeded.");
  const screenshot = vi.fn().mockRejectedValue(error);
  await expect(
    equipmentSearchEvidence("fixture:role", "1")(
      { screenshot, locator: vi.fn() } as unknown as Page,
      input,
      async () => {},
    ),
  ).rejects.toBe(error);
  expect(screenshot).toHaveBeenCalledTimes(2);
  expect(writeFile).not.toHaveBeenCalled();
});

it("重试前表单已变化则停止，不为新条件冒充原报价截图", async () => {
  const screenshot = vi.fn().mockRejectedValue(new errors.TimeoutError("page.screenshot: Timeout"));
  await expect(
    equipmentSearchEvidence("fixture:role", "1")(
      { screenshot, locator: vi.fn() } as unknown as Page,
      input,
      async () => {
        throw new Error("截图时表单发生变化");
      },
    ),
  ).rejects.toThrow("表单发生变化");
  expect(screenshot).toHaveBeenCalledOnce();
  expect(writeFile).not.toHaveBeenCalled();
});

it("页面关闭等非超时错误不重试，也不生成凭证", async () => {
  const screenshot = vi.fn().mockRejectedValue(new Error("Target page has been closed"));
  await expect(
    equipmentSearchEvidence("fixture:role", "1")(
      { screenshot, locator: vi.fn() } as unknown as Page,
      input,
      async () => {},
    ),
  ).rejects.toThrow("page has been closed");
  expect(screenshot).toHaveBeenCalledOnce();
  expect(writeFile).not.toHaveBeenCalled();
});

it("暂停时不再重试截图，不保存暂停后才返回的证据", async () => {
  const controller = new AbortController();
  const screenshot = vi.fn().mockImplementation(async () => {
    controller.abort(new Error("用户暂停"));
    throw new errors.TimeoutError("page.screenshot: Timeout");
  });
  await expect(
    equipmentSearchEvidence("fixture:role", "1", controller.signal)(
      { screenshot, locator: vi.fn() } as unknown as Page,
      input,
      async () => {},
    ),
  ).rejects.toThrow("用户暂停");
  expect(screenshot).toHaveBeenCalledOnce();
  expect(writeFile).not.toHaveBeenCalled();
});

it.each([1, 2])(
  "截图连续超时%s次后恢复，同一角色及下一角色都完成分析，已完成项不重算",
  async (failures) => {
    const crawl = new CrawlStore(":memory:");
    const store = new AnalysisStore(crawl.db);
    for (const key of ["evidence-first", "evidence-second"]) {
      const record = valuationRecord(key);
      const capture = {
        version: 1 as const,
        collectedAt: record.detail!.collectedAt,
        complete: true,
        issues: [],
        emptyProof: "explicit-text" as const,
      };
      record.detail!.equipmentCapture = capture;
      record.detail!.tabs.push({
        name: "道具/法宝",
        text: "没有装备",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        items: [],
      });
      crawl.observe(record.listing);
      crawl.save(record.listing, record.detail!);
    }
    let remaining = failures;
    const screenshot = vi.fn().mockImplementation(async () => {
      if (remaining-- > 0)
        throw new errors.TimeoutError("page.screenshot: Timeout 5000ms exceeded. fonts loaded");
      return Buffer.from("fixture-recovered-png");
    });
    const analyzed: string[] = [];
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), undefined, true, false);
    const runner = new AnalysisRunner(store, async () => ({
      model: "evidence-regression",
      searchEquipment: async (record, signal) => {
        try {
          await equipmentSearchEvidence(record.listing.key, record.listing.serverId, signal)(
            { screenshot, locator: vi.fn() } as unknown as Page,
            input,
            async () => {},
          );
        } catch (error) {
          throw new Error("装备查价截图记录失败，未采用报价：" + String(error));
        }
        return finishPricingSearch(equipmentPricingPlan(record));
      },
      analyze: async (prompt) => {
        analyzed.push(prompt.match(/商品 ID：([^。]+)。/)![1]);
        return {
          text: JSON.stringify({
            decision: "NEED_INFO",
            reason: "截图恢复回归测试",
            extracted_facts: [],
          }),
        };
      },
    }));
    try {
      const id = await runner.start("codex", false, profile);
      if (failures === 2) {
        await vi.waitFor(() =>
          expect(store.run(id)).toMatchObject({
            status: "paused",
            waitingPricing: 1,
            completed: 0,
          }),
        );
        expect(analyzed).toEqual([]);
        expect(store.run(id)?.queued).toBe(1);
        await runner.resume(id, true);
      }
      await vi.waitFor(() =>
        expect(store.run(id)).toMatchObject({
          status: "running",
          completed: 2,
          queued: 0,
          waitingPricing: 0,
          phase: "waiting_capture",
        }),
      );
      expect(analyzed).toEqual(["evidence-first", "evidence-second"]);
      expect(screenshot).toHaveBeenCalledTimes(failures + 2);
      await runner.pause(id);
      await runner.resume(id);
      expect(analyzed).toEqual(["evidence-first", "evidence-second"]);
    } finally {
      await runner.shutdown();
      crawl.close();
    }
  },
);
