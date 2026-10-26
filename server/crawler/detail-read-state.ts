import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { CAPTURE_VERSION } from "./compact";
import { readDetailIdentity } from "./detail-identity";
import type { Listing, RoleDetail, TabSnapshot } from "./types";
import { readOfficialModels } from "./official-model-page";
import { officialModelFromAttributes } from "./official-model";

/** One collectRole call owns this state. It is never shared across roles or persisted runs. */
export class DetailReadState {
  private revision: string | null = null;
  private tabs = new Map<string, { tabs: TabSnapshot[]; petCapture?: RoleDetail["petCapture"] }>();

  begin(revision: string | null) {
    if (!revision || revision !== this.revision) this.tabs.clear();
    this.revision = revision;
  }
  get(name: string) {
    const value = this.revision && this.tabs.get(name);
    return value ? structuredClone(value) : undefined;
  }
  save(name: string, tabs: TabSnapshot[], petCapture?: RoleDetail["petCapture"]) {
    if (this.revision) this.tabs.set(name, structuredClone({ tabs, petCapture }));
  }
  invalidate() {
    this.begin(null);
  }
}

/** Recheck the exact public model records used to classify cached gear/pets. */
export async function cachedModelsUnchanged(page: Page, tabs: TabSnapshot[]) {
  const equipment = tabs
    .flatMap((tab) => [...(tab.items || []), ...(tab.pets || []).flatMap((pet) => pet.equipment)])
    .filter((item) => item.kind === "equipment");
  if (equipment.some((item) => !item.modelId)) return false;
  if (!equipment.length) return true;
  const metadata = await readOfficialModels(
    page,
    equipment.map((item) => item.modelId!),
  );
  if (metadata.issues.length) return false;
  return equipment.every(
    (item) =>
      JSON.stringify(item.officialModel) ===
      JSON.stringify(
        officialModelFromAttributes({
          data_equip_type: item.modelId!,
          data_official_model_metadata: metadata.models[item.modelId!] || "",
        }),
      ),
  );
}

/** Missing or conflicting observed identity/source means no reuse, even if the URL looks right. */
export async function readDetailRevision(page: Page, listing: Listing): Promise<string | null> {
  const identity = await readDetailIdentity(page);
  if (
    identity.issues.length ||
    identity.serverId !== listing.serverId ||
    identity.eid !== listing.eid
  )
    return null;
  const source = await page.evaluate(async () => ({
    encoded: document.querySelector<HTMLTextAreaElement>("#equip_desc_value")?.value,
    price: document
      .querySelector<HTMLElement>("[data-cbg-detail-root]")
      ?.innerText.match(/价格[：:]\s*[￥¥]\s*([\d,.]+)/)?.[1]
      ?.replaceAll(",", ""),
    scripts: Array.from(document.scripts)
      .map((script) => script.src)
      .filter(Boolean),
    // Hash public inline parser/config definitions in the page; never return inline source.
    configDigest: Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            Array.from(document.scripts)
              .filter(
                (script) =>
                  !script.src &&
                  /(?:\b(?:function|class)\s+(?:RoleNameConf|RoleInfoParser|decode_desc)\b|\b(?:CBG_GAME_CONFIG|RoleNameConf|RoleInfoParser|decode_desc)(?:\.\w+)*\s*=)/.test(
                    script.textContent || "",
                  ),
              )
              .map((script) => script.textContent)
              .join("\n"),
          ),
        ),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  }));
  if (!source.encoded) return null;
  const after = await readDetailIdentity(page);
  if (after.issues.length || after.serverId !== identity.serverId || after.eid !== identity.eid)
    return null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        serverId: identity.serverId,
        eid: identity.eid,
        captureVersion: CAPTURE_VERSION,
        ...source,
      }),
    )
    .digest("hex");
}
