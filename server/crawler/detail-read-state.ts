import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { CAPTURE_VERSION } from "./compact";
import { readDetailIdentity } from "./detail-identity";
import type { Listing } from "./types";

declare const CBG_GAME_CONFIG: unknown;
declare const RoleNameConf: unknown;
declare const RoleInfoParser: unknown;
declare const decode_desc: unknown;

/** Verify role data and its actual parsers across one read; unrelated page scripts are excluded. */
export async function readDetailRevision(page: Page, listing: Listing): Promise<string | null> {
  const identity = await readDetailIdentity(page);
  if (
    identity.issues.length ||
    identity.serverId !== listing.serverId ||
    identity.eid !== listing.eid
  )
    return null;
  const source = await page.evaluate(async () => {
    try {
      const seen = new WeakSet<object>();
      const accessorDefinition = (descriptor: PropertyDescriptor, name: "get" | "set") => {
        const definition: unknown = Reflect.get(descriptor, name);
        return typeof definition === "function"
          ? Function.prototype.toString.call(definition)
          : null;
      };
      // Public metadata may contain getters, toJSON or cycles. Record descriptors
      // and function definitions without invoking optional application code.
      const passive = (value: unknown): unknown => {
        if (value === null) return null;
        if (typeof value === "undefined") return { type: "undefined" };
        if (typeof value === "bigint" || typeof value === "symbol")
          return { type: typeof value, value: String(value) };
        if (typeof value !== "object" && typeof value !== "function") return value;
        if (seen.has(value)) return { cycle: true };
        seen.add(value);
        return {
          definition: typeof value === "function" ? Function.prototype.toString.call(value) : null,
          properties: Object.entries(Object.getOwnPropertyDescriptors(value))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, descriptor]) => [
              name,
              "value" in descriptor
                ? { value: passive(descriptor.value) }
                : {
                    get: accessorDefinition(descriptor, "get"),
                    set: accessorDefinition(descriptor, "set"),
                  },
            ]),
        };
      };
      const binding = (name: string, read: () => unknown) => {
        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        return descriptor && !("value" in descriptor) ? passive(descriptor) : passive(read());
      };
      const config = {
        config: binding("CBG_GAME_CONFIG", () =>
          typeof CBG_GAME_CONFIG === "undefined" ? null : CBG_GAME_CONFIG,
        ),
        names: binding("RoleNameConf", () =>
          typeof RoleNameConf === "undefined" ? null : RoleNameConf,
        ),
        parser: binding("RoleInfoParser", () =>
          typeof RoleInfoParser === "undefined" ? null : RoleInfoParser,
        ),
        decode: binding("decode_desc", () =>
          typeof decode_desc === "undefined" ? null : decode_desc,
        ),
      };
      return {
        encoded: document.querySelector<HTMLTextAreaElement>("#equip_desc_value")?.value,
        price: document
          .querySelector<HTMLElement>("[data-cbg-detail-root]")
          ?.innerText.match(/价格[：:]\s*[￥¥]\s*([\d,.]+)/)?.[1]
          ?.replaceAll(",", ""),
        configDigest: Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(config))),
          ),
        )
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      };
    } catch {
      // Proxy traps or otherwise unreadable required evidence fail this item;
      // an ordinary page error must not stop the entire collection run.
      return { revisionIssue: true };
    }
  });
  if ("revisionIssue" in source)
    throw Object.assign(new Error("详情解析器或公开配置无法核验，本件资料未标记完整"), {
      name: "IncompleteDetailError",
    });
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
