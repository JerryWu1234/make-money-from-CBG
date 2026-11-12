import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { createMarketDetailReader, refreshMarketCandidates } from "./market-detail";

// Failure cases: missing/duplicate targets, denied/wrong/late/extra popups, cancellation,
// cross-task page ownership, cleanup failure, and saved candidates beyond the page budget.
const mocks = vi.hoisted(() => ({ click: vi.fn(), available: vi.fn() }));
vi.mock("../viewport", () => ({
  clickForInspection: mocks.click,
  ensureWorkViewport: async () => {},
}));
vi.mock("../crawler/page", () => ({ assertAvailable: mocks.available }));
vi.mock("../browser-evidence", () => ({
  captureBrowserStep: async () => {},
  registerBrowserEvidence: () => {},
}));
const url = (id: string) => `https://xyq.cbg.163.com/equip?s=1&eid=${id}`;
function fixture(hrefs = [url("a")]) {
  const context = new EventEmitter();
  const search = Object.assign(new EventEmitter(), {
    context: () => context,
    locator: () => ({ evaluateAll: async () => hrefs, nth: (index: number) => ({ index }) }),
  });
  const popup = Object.assign(new EventEmitter(), {
    url: () => hrefs[0],
    waitForURL: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });
  const control = new AbortController();
  const reader = createMarketDetailReader(search as unknown as Page, control.signal, 100);
  mocks.available.mockReset();
  mocks.click.mockReset().mockImplementation(async () => search.emit("popup", popup));
  return { context, search, popup, control, reader };
}
afterEach(() => vi.useRealTimers());

describe("market detail page ownership", () => {
  it("clicks once, reads the returned page, then closes it", async () => {
    const { reader, popup } = fixture();
    expect(
      await reader.read(url("a"), new AbortController().signal, async (page) => {
        expect(page).toBe(popup);
        expect(popup.close).not.toHaveBeenCalled();
        return "verified";
      }),
    ).toBe("verified");
    expect(mocks.click).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalledOnce();
    await reader.close();
  });
  it.each([{ hrefs: [] }, { hrefs: [url("a"), url("a")] }, { hrefs: [url("b")] }])(
    "does not click ambiguous or absent targets %j",
    async ({ hrefs }) => {
      const { reader } = fixture(hrefs);
      await expect(reader.read(url("a"), new AbortController().signal, vi.fn())).rejects.toThrow(
        "唯一",
      );
      expect(mocks.click).not.toHaveBeenCalled();
      await reader.close();
    },
  );
  it("rejects external URLs before clicking", async () => {
    const { reader } = fixture();
    await expect(
      reader.read("https://example.com/equip?s=1&eid=a", new AbortController().signal, vi.fn()),
    ).rejects.toThrow();
    expect(mocks.click).not.toHaveBeenCalled();
    await reader.close();
  });
  it.each([401, 403, 429])("rejects HTTP %i and closes the popup", async (status) => {
    const { reader, search, popup, context } = fixture();
    mocks.click.mockImplementation(async () => {
      context.emit("response", {
        request: () => ({ isNavigationRequest: () => true }),
        frame: () => ({ parentFrame: () => null, page: () => popup }),
        status: () => status,
      });
      search.emit("popup", popup);
    });
    const read = vi.fn();
    await expect(reader.read(url("a"), new AbortController().signal, read)).rejects.toThrow(
      "HTTP " + status,
    );
    expect(read).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledOnce();
    await reader.close();
  });
  it("rejects another product and preserves parse errors while closing pages", async () => {
    const { reader, popup } = fixture();
    popup.url = () => url("b");
    await expect(reader.read(url("a"), new AbortController().signal, vi.fn())).rejects.toThrow(
      "另一商品",
    );
    popup.url = () => url("a");
    const failure = new Error("incomplete description");
    popup.close.mockRejectedValue(new Error("close failed"));
    await expect(
      reader.read(url("a"), new AbortController().signal, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await reader.close();
  });
  it("cancellation while waiting also closes a late popup without another click", async () => {
    const { reader, search, popup, control } = fixture();
    mocks.click.mockResolvedValue(undefined);
    const work = reader.read(url("a"), control.signal, vi.fn());
    await vi.waitFor(() => expect(mocks.click).toHaveBeenCalledOnce());
    control.abort(new Error("paused"));
    await expect(work).rejects.toThrow("paused");
    search.emit("popup", popup);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(mocks.click).toHaveBeenCalledOnce();
    await reader.close();
  });
  it("timeout does not replay an uncertain click; an extra popup is closed", async () => {
    vi.useFakeTimers();
    const { reader, search, popup } = fixture();
    mocks.click.mockResolvedValue(undefined);
    const work = reader.read(url("a"), new AbortController().signal, vi.fn());
    const assertion = expect(work).rejects.toThrow("未及时打开");
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    search.emit("popup", popup);
    expect(popup.close).toHaveBeenCalledOnce();
    await expect(reader.read(url("a"), new AbortController().signal, vi.fn())).rejects.toThrow(
      "已关闭",
    );
    expect(mocks.click).toHaveBeenCalledOnce();
    await reader.close();
  });
  it("explicit close interrupts a read and does not accept an unrelated page", async () => {
    const { reader, popup, context, search } = fixture();
    mocks.click.mockImplementation(async () => context.emit("page", popup));
    const work = reader.read(url("a"), new AbortController().signal, vi.fn());
    await vi.waitFor(() => expect(mocks.click).toHaveBeenCalledOnce());
    await reader.close();
    await expect(work).rejects.toThrow("已关闭");
    expect(popup.close).not.toHaveBeenCalled();
    search.emit("popup", popup);
    expect(popup.close).toHaveBeenCalledOnce();
  });
});

it("re-finds saved candidates on their list page without opening URLs outside the budget", async () => {
  const pending = new Map([
    [url("a"), 0],
    [url("b"), 0],
    [url("c"), 1],
  ]);
  const read = vi.fn(async () => {});
  let pages = 0;
  const load = vi.fn(async (number: number) => {
    pages++;
    return { rows: [{ url: url(number === 1 ? "x" : "b") }], hasNext: true };
  });
  await refreshMarketCandidates(
    pending,
    0,
    load,
    read,
    () => pages < 2,
    () => true,
  );
  expect(read).toHaveBeenCalledExactlyOnceWith(url("b"));
  expect(pending).toEqual(
    new Map([
      [url("a"), 0],
      [url("c"), 1],
    ]),
  );
  expect(load.mock.calls).toEqual([[1], [2]]);
});
