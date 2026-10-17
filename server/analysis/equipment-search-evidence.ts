import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EquipmentEvidenceCapture } from "./browser-equipment-source";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Called synchronously by the application's search flow at its actual fill/submit boundaries. */
export function equipmentSearchEvidence(
  productKey: string,
  serverId: string,
): EquipmentEvidenceCapture {
  const directory = resolve(
    "data/equipment-search-evidence",
    new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
  );
  let sequence = 0;
  return async (page, input, verifyStable) => {
    const png = await page.screenshot({
      fullPage: true,
      timeout: 5000,
      mask: [
        page.locator(
          "#userinfo,.userInfo,.user-info,.login-info,.account-info,#user_name,#qrcode,#loginContainer",
        ),
      ],
      maskColor: "#20394b",
    });
    await verifyStable();
    const stem = String(++sequence).padStart(4, "0") + "-" + input.stage;
    const screenshot = resolve(directory, stem + ".png"),
      parameters = resolve(directory, stem + ".json");
    const json = JSON.stringify(
      {
        productKey,
        serverId,
        capturedAt: new Date().toISOString(),
        ...input,
        screenshot,
        screenshotSha256: hash(png),
      },
      null,
      2,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(screenshot, png, { mode: 0o600 });
    await writeFile(parameters, json, { mode: 0o600 });
    return { screenshot, parameters, screenshotSha256: hash(png), parametersSha256: hash(json) };
  };
}
