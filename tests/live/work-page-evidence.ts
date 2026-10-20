import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright-core";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const accountRegions = "#userinfo,.userInfo,.user-info,.login-info,.account-info,#user_name";
export function isEvidencePage(url: string) {
  try {
    return new URL(url).origin === "https://xyq.cbg.163.com";
  } catch {
    return false;
  }
}

async function bounded<T>(work: Promise<T>, timeoutMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("evidence_read_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function observeWorkPage(page: Pick<Page, "evaluate">, timeoutMs = 2000) {
  return bounded(
    page.evaluate(
      ({ accountRegions }) => {
        if (location.origin !== "https://xyq.cbg.163.com")
          throw new Error("outside_evidence_scope");
        const visible = (node: Element) => node.checkVisibility();
        const gate = Array.from(
          document.querySelectorAll(
            "#qrcode,#loginContainer,#captcha_container,.yidun_popup,.geetest_panel,input[type=password]",
          ),
        ).some(visible);
        if (gate) return { gate: true as const };
        const sensitive =
          /password|passwd|token|ticket|cookie|session|auth|qrcode|shareid|openid|account|username|phone|email/i;
        const publicUrl = new URL(location.href);
        // Setting a duplicated key removes values, so iterate a snapshot of the keys.
        const queryKeys = Array.from(publicUrl.searchParams.keys());
        for (const key of queryKeys)
          if (sensitive.test(key)) publicUrl.searchParams.set(key, "[redacted]");
        const primitiveFields = (value: unknown) => {
          if (!value || typeof value !== "object") return {};
          return Object.fromEntries(
            Object.entries(value)
              .filter(
                ([key, item]) =>
                  !sensitive.test(key) &&
                  (item === null || ["string", "number", "boolean"].includes(typeof item)),
              )
              .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 4000) : item]),
          );
        };
        const g = window as unknown as {
          QueryArgs?: unknown;
          CurSearchValue?: { arg?: unknown };
          equip?: Record<string, unknown>;
          EquipInfo?: Record<string, unknown>;
        };
        const raw = g.equip || g.EquipInfo || {};
        const product = Object.fromEntries(
          [
            "eid",
            "equipid",
            "serverid",
            "server_id",
            "equip_name",
            "equip_type",
            "kindid",
            "price",
            "equip_desc",
          ]
            .filter((key) => ["string", "number", "boolean"].includes(typeof raw[key]))
            .map((key) => [
              key,
              typeof raw[key] === "string" ? (raw[key] as string).slice(0, 40000) : raw[key],
            ]),
        );
        const controls = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"),
        )
          .filter(
            (node) =>
              !sensitive.test(node.id + " " + node.name) &&
              !node.closest(accountRegions) &&
              node.type !== "password",
          )
          .map((node) => ({
            id: node.id,
            name: node.name,
            label:
              node.getAttribute("aria-label") ||
              Array.from(node.labels || [])
                .map((label) => label.textContent?.trim())
                .join(" ") ||
              node.getAttribute("placeholder") ||
              node.getAttribute("title") ||
              "",
            type: node.type,
            value: node.value.slice(0, 4000),
            visible: visible(node),
            ...(node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type)
              ? { checked: node.checked }
              : {}),
            ...(node instanceof HTMLSelectElement
              ? {
                  selected: Array.from(node.selectedOptions).map((option) => ({
                    value: option.value,
                    label: option.textContent,
                  })),
                }
              : {}),
          }));
        const text = Array.from(
          document.body.querySelectorAll<HTMLElement>(
            "p,pre,li,td,h1,h2,[role=tooltip],#equip_desc_panel,#pet_desc",
          ),
        )
          .filter((node) => visible(node) && !node.closest("nav,header,footer," + accountRegions))
          .map((node) => node.innerText)
          .join("\n");
        const tooltips = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-cbg-hover-tip],[role=tooltip],[id$="TipsBox"],.equip_tips,.tips,.tooltip,#tips_box,#role_tips_box',
          ),
        )
          .filter((node) => visible(node) && !node.closest(accountRegions))
          .map((node) => node.innerText.slice(0, 20000));
        const description = Array.from(
          document.querySelectorAll<HTMLElement>(
            "#equip_desc_panel,#equip_desc_value,#pet_desc,#pet_attr_panel",
          ),
        )
          .filter(visible)
          .map((node) => node.innerText)
          .join("\n")
          .slice(0, 40000);
        return {
          gate: false as const,
          url: publicUrl.href,
          title: document.title,
          controls,
          queryArgs: primitiveFields(g.QueryArgs),
          submittedArgs: primitiveFields(g.CurSearchValue?.arg),
          product,
          description,
          tooltips,
          visibleText: text.slice(0, 80000),
          textTruncated: text.length > 80000,
        };
      },
      { accountRegions },
    ),
    timeoutMs,
  );
}

export function evidenceSignature(observation: unknown) {
  return hash(JSON.stringify(observation));
}

/** Read-only observer of pages already attached to the production work connection. */
export async function startWorkPageEvidence(directory: string, getBrowser: () => Promise<Browser>) {
  const root = path.join(directory, "work-page-evidence");
  await mkdir(root, { recursive: true });
  const output = await mkdtemp(path.join(root, "session-"));
  const relative = (name: string) => path.relative(directory, path.join(output, name));
  const entries: Array<{
    page: number;
    observedAt: string;
    shotAt: string;
    url: string;
    signature: string;
    captureMode: "full-page" | "viewport";
    files: Array<{ name: string; sha256: string }>;
  }> = [];
  const failures = new Map<
    string,
    { reason: string; count: number; firstAt: string; lastAt: string }
  >();
  const seen = new WeakMap<Page, string>();
  const ids = new WeakMap<Page, number>();
  let pageCount = 0,
    stopping = false;
  let wake: (() => void) | undefined;
  const index = () => ({
    version: 1,
    scope: "production-connection-official-pages-only",
    minimumPauseMs: 750,
    limits: [
      "May miss pages visible for less than a polling cycle; serial page reads extend the interval",
      "Search forms use full-page screenshots; detail pages use viewport screenshots; no scrolling or hovering",
      "No wire listener: submittedArgs are page state, not independently recorded HTTP parameters",
      "Stable observations are not proof of every request or complete per-role coverage",
      "Image/description hashes differ from production sourceHash",
    ],
    entries,
    failures: [...failures.values()],
  });
  const flush = async () => {
    const bytes = JSON.stringify(index(), null, 2);
    await writeFile(path.join(output, "index.json"), bytes, { mode: 0o600 });
    return { name: relative("index.json"), sha256: hash(bytes) };
  };
  const failure = (reason: string) => {
    const at = new Date().toISOString(),
      previous = failures.get(reason);
    failures.set(reason, {
      reason,
      count: (previous?.count || 0) + 1,
      firstAt: previous?.firstAt || at,
      lastAt: at,
    });
  };
  await flush();
  const work = (async () => {
    while (!stopping) {
      try {
        const browser = await bounded(getBrowser());
        for (const page of browser.contexts().flatMap((context) => context.pages())) {
          if (stopping) break;
          if (page.isClosed() || !isEvidencePage(page.url())) continue;
          try {
            const observedAt = new Date().toISOString(),
              before = await observeWorkPage(page);
            if (before.gate) {
              failure("login_or_verification_visible");
              continue;
            }
            const signature = evidenceSignature(before);
            if (seen.get(page) === signature) continue;
            const shotAt = new Date().toISOString();
            const fullPage = new URL(before.url).pathname.startsWith("/cgi-bin/");
            const captureMode = fullPage ? "full-page" : "viewport";
            const png = await page.screenshot({
              timeout: fullPage ? 5000 : 2000,
              fullPage,
              mask: [page.locator(accountRegions)],
              maskColor: "#20394b",
            });
            const after = await observeWorkPage(page);
            if (after.gate || JSON.stringify(before) !== JSON.stringify(after)) {
              failure("page_changed_during_screenshot");
              continue;
            }
            if (!ids.has(page)) ids.set(page, ++pageCount);
            const stem = String(entries.length + 1).padStart(5, "0");
            const json = JSON.stringify(
              {
                observedAt,
                shotAt,
                verifiedAt: new Date().toISOString(),
                signature,
                captureMode,
                descriptionSha256: hash(before.description),
                observation: before,
              },
              null,
              2,
            );
            await writeFile(path.join(output, stem + ".png"), png, { mode: 0o600 });
            await writeFile(path.join(output, stem + ".json"), json, { mode: 0o600 });
            entries.push({
              page: ids.get(page)!,
              observedAt,
              shotAt,
              url: before.url,
              signature,
              captureMode,
              files: [
                { name: relative(stem + ".png"), sha256: hash(png) },
                { name: relative(stem + ".json"), sha256: hash(json) },
              ],
            });
            seen.set(page, signature);
            await flush();
          } catch (error) {
            failure(
              error instanceof Error && error.name === "TimeoutError"
                ? "screenshot_timeout"
                : "page_read_or_write_failed",
            );
          }
        }
      } catch {
        failure("production_browser_unavailable");
      }
      try {
        await flush();
      } catch {
        failure("evidence_index_write_failed");
      }
      if (!stopping)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 750);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
    }
  })();
  return {
    async stop() {
      stopping = true;
      wake?.();
      await work;
      return flush();
    },
  };
}
