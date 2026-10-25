import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errors } from "playwright-core";
import { diagnostics } from "../diagnostics";
import { screenshotsEnabled } from "../runtime-settings";
import type { EquipmentEvidenceCapture } from "./browser-equipment-source";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Called synchronously by the application's search flow at its actual fill/submit boundaries. */
export function equipmentSearchEvidence(
  productKey: string,
  serverId: string,
  signal?: AbortSignal,
): EquipmentEvidenceCapture {
  const directory = resolve(
    diagnostics.evidenceDirectory(),
    "pricing",
    new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
  );
  let sequence = 0;
  return async (page, input, verifyStable) => {
    const timeout = 15_000;
    let png: Buffer | undefined;
    let attempt = 0;
    for (attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      if (!screenshotsEnabled()) break;
      if (attempt > 1) await verifyStable();
      signal?.throwIfAborted();
      if (!screenshotsEnabled()) break;
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
    const image = png
      ? { screenshot, screenshotSha256: hash(png) }
      : { screenshotDisabled: true as const };
    const json = JSON.stringify(
      {
        productKey,
        serverId,
        capturedAt: new Date().toISOString(),
        ...input,
        ...image,
        screenshotAttempts: png ? attempt : 0,
        ...(png ? { screenshotTimeoutMs: timeout } : {}),
      },
      null,
      2,
    );
    await mkdir(directory, { recursive: true });
    if (png) await writeFile(screenshot, png, { mode: 0o600 });
    await writeFile(parameters, json, { mode: 0o600 });
    return { ...image, parameters, parametersSha256: hash(json) };
  };
}
