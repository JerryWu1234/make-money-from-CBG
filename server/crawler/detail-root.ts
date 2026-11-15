import type { ElementHandle, Locator, Page } from "playwright-core";
import { MAIN_TABS } from "./detail-tabs";
import { readDetailIdentity } from "./detail-identity";

type DetailRoot = {
  element: ElementHandle<HTMLElement>;
  selector: string;
  url: string;
  encoded?: ElementHandle<HTMLTextAreaElement>;
  encodedInRoot: boolean;
  sourceIdentity?: { serverId: string; eid: string };
  petItems?: { path: string; section: string }[];
};
const roots = new WeakMap<Page, DetailRoot>();
const incomplete = () =>
  Object.assign(new Error("角色详情读取范围已变化或不唯一，未完整读取"), {
    name: "IncompleteDetailError",
  });

/** Keep document/node identity in the worker. Never publish a binding on the page. */
export async function retainDetailRoot(
  page: Page,
  explicit?: Locator,
  expected?: { serverId: string; eid: string },
): Promise<void> {
  const previous = roots.get(page);
  roots.delete(page);
  await previous?.element.dispose().catch(() => {});
  await previous?.encoded?.dispose().catch(() => {});
  if (expected) {
    const address = new URL(page.url());
    if (
      address.searchParams.get("s") !== expected.serverId ||
      address.searchParams.get("eid") !== expected.eid
    )
      throw incomplete();
  }
  const handle = explicit
    ? await explicit.elementHandle()
    : (
        await page.evaluateHandle(
          (names) => {
            const excluded =
              "aside,footer,#search_result,#bottomRecommands,#recommd_list,#recommend,.recommend,.recommd,.recommandWrp,.goodsRemmds,[role=tooltip],[id$=TipsBox]";
            const visible = (node: Element) =>
              node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            const labels = [
              ...document.querySelectorAll<HTMLElement>('a,button,li,span,[role="tab"],[data-tab]'),
            ].filter(
              (node) =>
                visible(node) &&
                !node.closest(excluded) &&
                names.includes(node.innerText.trim()) &&
                ![...node.children].some((child) =>
                  names.includes((child as HTMLElement).innerText?.trim()),
                ),
            );
            const candidates = new Set<HTMLElement>();
            for (const first of labels.filter((node) => node.innerText.trim() === names[0])) {
              for (
                let root = first.parentElement;
                root && root !== document.body && root !== document.documentElement;
                root = root?.parentElement ?? null
              ) {
                if (root.tagName === "NAV" || root.closest(excluded)) continue;
                if (
                  !names.every(
                    (name) =>
                      labels.filter(
                        (node) => root!.contains(node) && node.innerText.trim() === name,
                      ).length === 1,
                  )
                )
                  continue;
                const current = root,
                  mainLabels = labels.filter((node) => current.contains(node));
                // Sibling buttons/LI are still the tab bar, never content panels.
                if (
                  ![...current.children].some(
                    (node) =>
                      !mainLabels.some((label) => node === label || node.contains(label)) &&
                      !node.matches("script,style,nav") &&
                      visible(node) &&
                      (!!(node as HTMLElement).innerText?.trim() ||
                        [...node.querySelectorAll("img,table,input,textarea")].some(visible)),
                  )
                )
                  continue;
                candidates.add(root);
                break;
              }
            }
            return candidates.size === 1 ? [...candidates][0] : null;
          },
          [...MAIN_TABS],
        )
      ).asElement();
  if (!handle) {
    const missing: string[] = [];
    for (const name of MAIN_TABS)
      if (!(await page.getByText(name, { exact: true }).filter({ visible: true }).count()))
        missing.push(name);
    if (missing.length)
      throw Object.assign(new Error(`详情缺少「${missing.join("」「")}」标签，未标记完整采集`), {
        name: "IncompleteDetailError",
      });
    throw incomplete();
  }
  const element = handle as ElementHandle<HTMLElement>;
  if (explicit && (await explicit.count()) !== 1) {
    await element.dispose();
    throw incomplete();
  }
  const selector = await element.evaluate((root) => {
    if (!root.isConnected || root === document.body || root === document.documentElement) return "";
    const parts: string[] = [];
    for (let node: Element | null = root; node; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children] : [node];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(" > ");
  });
  if (!selector) {
    await element.dispose();
    throw incomplete();
  }
  const inside = await element.$$("textarea[id=equip_desc_value]");
  const candidates = inside.length
    ? inside
    : await page.locator("textarea[id=equip_desc_value]").elementHandles();
  if (candidates.length > 1) {
    await Promise.all(candidates.map((candidate) => candidate.dispose()));
    await element.dispose();
    throw incomplete();
  }
  const identity = candidates.length ? await readDetailIdentity(page) : undefined;
  const boundIdentity =
    identity &&
    !identity.issues.length &&
    (!expected || (identity.serverId === expected.serverId && identity.eid === expected.eid))
      ? { serverId: identity.serverId, eid: identity.eid }
      : undefined;
  // The public hidden source is sometimes a sibling. Without the existing product
  // identity proof, an arbitrary page-level textarea cannot become a role source.
  const encoded =
    inside.length || boundIdentity
      ? (candidates[0] as ElementHandle<HTMLTextAreaElement> | undefined)
      : undefined;
  if (!encoded) await candidates[0]?.dispose();
  roots.set(page, {
    element,
    selector,
    url: page.url(),
    encoded,
    encodedInRoot: inside.length > 0,
    sourceIdentity: boundIdentity,
  });
  await assertDetailRoot(page);
}

export async function assertDetailRoot(page: Page): Promise<void> {
  const root = roots.get(page);
  if (!root || page.url() !== root.url) throw incomplete();
  try {
    if (
      !(await root.element.evaluate(
        (element, selector) =>
          element.isConnected &&
          element.ownerDocument === document &&
          document.querySelector(selector) === element &&
          [
            "equip_desc_value",
            "RoleUsingEquips",
            "RoleStoreEquips",
            "RoleSplitEquips",
            "RoleYuHun",
            "RoleRiders",
            "pet_list",
            "summon_list",
          ].every((id) => element.querySelectorAll(`[id="${id}"]`).length <= 1),
        root.selector,
      ))
    )
      throw incomplete();
    if (
      root.encoded &&
      !(await root.encoded.evaluate(
        (element, { root, inside }) =>
          element.isConnected &&
          element.ownerDocument === document &&
          (inside
            ? root.contains(element)
            : document.querySelectorAll("textarea[id=equip_desc_value]").length === 1),
        { root: root.element, inside: root.encodedInRoot },
      ))
    )
      throw incomplete();
  } catch (error) {
    if (page.isClosed()) throw error;
    throw incomplete();
  }
}

/** A uniquely bound public source may be a hidden sibling of the visible detail container. */
export async function readDetailEncodedRole(page: Page): Promise<string | undefined> {
  await assertDetailRoot(page);
  const scope = roots.get(page)!;
  if (scope.sourceIdentity) {
    const identity = await readDetailIdentity(page);
    if (
      identity.issues.length ||
      identity.serverId !== scope.sourceIdentity.serverId ||
      identity.eid !== scope.sourceIdentity.eid
    )
      throw incomplete();
  }
  const value = await scope.encoded?.evaluate((element) => element.value);
  await assertDetailRoot(page);
  return value;
}

export async function detailRootLocator(page: Page): Promise<Locator> {
  await assertDetailRoot(page);
  return page.locator(roots.get(page)!.selector);
}
export async function detailRootSelector(page: Page): Promise<string> {
  await assertDetailRoot(page);
  return roots.get(page)!.selector;
}

export async function setDetailPetItems(page: Page, items: { path: string; section: string }[]) {
  await assertDetailRoot(page);
  roots.get(page)!.petItems = structuredClone(items);
}
export async function detailPetItems(page: Page) {
  await assertDetailRoot(page);
  return structuredClone(roots.get(page)!.petItems || []);
}

export async function evaluateDetailRoot<A, R>(
  page: Page,
  fn: (root: HTMLElement, arg: A) => R | Promise<R>,
  arg: A,
): Promise<Awaited<R>> {
  await assertDetailRoot(page);
  let value: Awaited<R>;
  try {
    value = await roots
      .get(page)!
      .element.evaluate(fn as (root: HTMLElement, arg: unknown) => R | Promise<R>, arg);
  } catch (error) {
    await assertDetailRoot(page);
    throw error;
  }
  await assertDetailRoot(page);
  return value;
}
