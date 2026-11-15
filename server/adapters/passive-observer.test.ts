import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../extension/cbg-access/main.js", import.meta.url), "utf8");
function fixture() {
  const emitted: unknown[] = [],
    intervals: (() => void)[] = [],
    listeners = new Map<string, () => void>();
  class XHR {
    open() {
      return "opened";
    }
    send() {
      return "sent";
    }
  }
  const window: Record<PropertyKey, unknown> = {
    postMessage: (value: unknown) => emitted.push(value),
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    QueryArgs: { page: 1, token: "secret" },
  };
  const scope = {
    window,
    XMLHttpRequest: XHR,
    location: {
      origin: "https://xyq.cbg.163.com",
      href: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
    },
    document: { querySelector: () => null },
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {},
    URL,
    TextDecoder,
  };
  return {
    scope,
    window,
    emitted,
    intervals,
    listeners,
    install: () => runInNewContext(source, scope),
  };
}
describe("MAIN passive observer", () => {
  it("installs once and redacts secrets from the bounded product/query snapshot", () => {
    const f = fixture();
    f.install();
    f.install();
    expect(f.intervals).toHaveLength(1);
    expect(JSON.stringify(f.emitted)).not.toContain("secret");
  });
  it("preserves callback receiver, arguments, result and original exception", () => {
    const f = fixture(),
      receiver = {},
      result = {},
      error = new Error("website failure");
    let calls = 0;
    f.window.ajax_with_recommend = function (
      this: unknown,
      options: { onSuccess: (...args: unknown[]) => unknown },
    ) {
      expect(this).toBe(receiver);
      return options.onSuccess.call(receiver, result, 3);
    };
    f.install();
    const ajax = f.window.ajax_with_recommend as (this: unknown, options: unknown) => unknown;
    expect(
      ajax.call(receiver, {
        onSuccess(this: unknown, ...args: unknown[]) {
          calls++;
          expect(this).toBe(receiver);
          expect(args).toEqual([result, 3]);
          return 42;
        },
      }),
    ).toBe(42);
    expect(calls).toBe(1);
    expect(() =>
      ajax.call(receiver, {
        onSuccess() {
          throw error;
        },
      }),
    ).toThrow(error);
  });
  it("does not swallow website errors or override a later page wrapper during teardown", () => {
    const f = fixture(),
      error = new Error("upstream failed");
    f.window.ajax_with_recommend = () => {
      throw error;
    };
    f.install();
    f.window.postMessage = () => {
      throw new Error("observer failed");
    };
    f.intervals[0]();
    expect(() => (f.window.ajax_with_recommend as () => void)()).toThrow(error);
    const later = () => "later";
    f.window.ajax_with_recommend = later;
    f.listeners.get("pagehide")!();
    expect(f.window.ajax_with_recommend).toBe(later);
  });
});
