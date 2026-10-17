import { expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { equipmentSearchEvidence } from "./equipment-search-evidence";
import type { EquipmentEvidenceCapture } from "./browser-equipment-source";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
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
  vi.clearAllMocks();
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("fixture-png"));
  const page = { screenshot, locator: vi.fn() } as unknown as Page;
  const verify = vi.fn().mockResolvedValue(undefined);
  const result = await equipmentSearchEvidence("fixture:role", "1")(page, input, verify);
  expect(verify).toHaveBeenCalledOnce();
  expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
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
  vi.clearAllMocks();
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
