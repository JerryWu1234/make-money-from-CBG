import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errors } from "playwright-core";
import { diagnostics } from "../diagnostics";
import type { EquipmentEvidenceCapture } from "./browser-equipment-source";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Called synchronously by the application's search flow at its actual fill/submit boundaries. */
export function equipmentSearchEvidence(
  productKey: string,
  serverId: string,
  signal?: AbortSignal,
): EquipmentEvidenceCapture {
  const directory = resolve(
    "data/equipment-search-evidence",
    new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
  );
  let sequence = 0;
  return async (page, input, verifyStable) => {
    const timeout = 15_000;
    let png!: Buffer;
    let attempt = 0;
    for (attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 1) await verifyStable();
      const started = Date.now();
      const context = { productKey, equipmentKey: input.equipmentKey, stage: input.stage, attempt };
      diagnostics.record("equipment.evidence_screenshot_started", { ...context, timeout });
      try {
        png = await page.screenshot({
          fullPage: true,
          timeout,
          animations: "disabled",
          scale: "css",
          mask: [
            page.locator(
              "#userinfo,.userInfo,.user-info,.login-info,.account-info,#user_name,#qrcode,#loginContainer",
            ),
          ],
          maskColor: "#20394b",
        });
        diagnostics.record("equipment.evidence_screenshot_completed", {
          ...context,
          elapsedMs: Date.now() - started,
        });
        break;
      } catch (error) {
        diagnostics.record("equipment.evidence_screenshot_failed", {
          ...context,
          elapsedMs: Date.now() - started,
          error,
        });
        signal?.throwIfAborted();
        if (!(error instanceof errors.TimeoutError) || attempt === 2) throw error;
      }
    }
    signal?.throwIfAborted();
    await verifyStable();
    signal?.throwIfAborted();
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
        screenshotAttempts: attempt,
        screenshotTimeoutMs: timeout,
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
