import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../extension/cbg-access/main.js", import.meta.url), "utf8");
function fixture() {
  const emitted: unknown[] = [],
    intervals: (() => void)[] = [],
    listeners = new Map<string, () => void>(),
    documentListeners = new Map<string, (event: unknown) => void>();
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
    document: {
      querySelector: () => null,
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        documentListeners.set(name, listener),
      removeEventListener: (name: string, listener: (event: unknown) => void) => {
        if (documentListeners.get(name) === listener) documentListeners.delete(name);
      },
    },
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
    documentListeners,
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
  it("pairs the start and callback of each request using immutable public conditions", () => {
    const f = fixture();
    let pending: { onSuccess: (value: unknown) => unknown } | undefined;
    f.window.ajax_with_recommend = (options: typeof pending) => {
      pending = options;
      return "website request";
    };
    f.install();
    f.documentListeners.get("click")!({ isTrusted: true, timeStamp: 123.5, eventPhase: 2 });
    f.documentListeners.get("click")!({ isTrusted: false, timeStamp: 999 });
    const data = {
      act: "overall_search_equip",
      page: 1,
      order_by: "price ASC",
      kindid: "20",
      token: "request-secret",
    };
    const ajax = f.window.ajax_with_recommend as (options: unknown) => unknown;
    expect(ajax({ data, onSuccess: () => 7 })).toBe("website request");
    const events = () =>
      (f.emitted as { value: Record<string, any> }[])
        .map(({ value }) => value)
        .filter((value) => value.kind === "jsonp");
    expect(events()).toHaveLength(1);
    const started = events()[0];
    expect(started).toMatchObject({
      phase: "request",
      activationTime: 123.5,
      act: "overall_search_equip",
      page: 1,
      orderBy: "price ASC",
      conditions: { kindid: "20" },
    });
    expect(typeof started.requestId).toBe("string");
    expect(started.requestId).not.toBe("");
    expect(Number.isFinite(Date.parse(started.startedAt))).toBe(true);
    data.page = 2;
    data.order_by = "price DESC";
    data.kindid = "21";
    expect(pending!.onSuccess({ status: 0, msg: [] })).toBe(7);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({
      phase: "response",
      requestId: started.requestId,
      startedAt: started.startedAt,
      activationTime: 123.5,
      act: "overall_search_equip",
      page: 1,
      orderBy: "price ASC",
      conditions: { kindid: "20" },
      success: true,
      count: 0,
    });
    expect(events()[1].eventId).not.toBe(started.eventId);
    expect(JSON.stringify(f.emitted)).not.toContain("request-secret");
  });
  it.each(["ended", "consumed"])(
    "does not reuse a trusted click whose event dispatch has %s",
    (state) => {
      const f = fixture();
      f.window.ajax_with_recommend = () => "website request";
      f.install();
      const click = { isTrusted: true, timeStamp: 123.5, eventPhase: 2 };
      f.documentListeners.get("click")!(click);
      const ajax = f.window.ajax_with_recommend as (options: unknown) => unknown;
      const options = { data: { act: "overall_search_equip", page: 1, kindid: "20" } };
      if (state === "ended") click.eventPhase = 0;
      else ajax(options);
      expect(ajax(options)).toBe("website request");
      const requests = (f.emitted as { value: Record<string, any> }[])
        .map(({ value }) => value)
        .filter((value) => value.phase === "request");
      if (state === "consumed") expect(requests[0].activationTime).toBe(123.5);
      expect(requests.at(-1)!.activationTime).toBeNull();
    },
  );
  it("captures public response identities before the website callback mutates its input", () => {
    const f = fixture();
    const response = { status: 0, msg: [{ serverid: 299, eid: "received" }] };
    f.window.ajax_with_recommend = (options: { onSuccess: (value: typeof response) => unknown }) =>
      options.onSuccess(response);
    f.install();
    const ajax = f.window.ajax_with_recommend as (options: unknown) => unknown;
    expect(
      ajax({
        data: { act: "overall_search_equip", page: 1, kindid: "20" },
        onSuccess(value: typeof response) {
          value.status = 1;
          value.msg[0].eid = "website-mutated";
          value.msg.length = 0;
          return 7;
        },
      }),
    ).toBe(7);
    const observed = (f.emitted as { value: Record<string, any> }[]).at(-1)!.value;
    expect(observed).toMatchObject({
      phase: "response",
      success: true,
      count: 1,
      resultRows: [{ serverId: "299", eid: "received" }],
    });
  });
  it("keeps identical concurrent requests distinct when callbacks finish out of order", () => {
    const f = fixture();
    const pending: { onSuccess: (value: unknown) => unknown }[] = [];
    f.window.ajax_with_recommend = (options: (typeof pending)[number]) => pending.push(options);
    f.install();
    const ajax = f.window.ajax_with_recommend as (options: unknown) => unknown;
    const options = { data: { act: "overall_search_equip", page: 1, kindid: "20" } };
    ajax(options);
    ajax(options);
    const events = () =>
      (f.emitted as { value: Record<string, any> }[])
        .map(({ value }) => value)
        .filter((value) => value.kind === "jsonp");
    expect(events()).toHaveLength(2);
    const starts = [...events()];
    expect(starts[0].requestId).not.toBe(starts[1].requestId);
    pending[1].onSuccess({ status: 0, msg: [{ eid: "new" }] });
    pending[0].onSuccess({ status: 0, msg: [{ eid: "old" }] });
    expect(
      events()
        .slice(2)
        .map((event) => event.requestId),
    ).toEqual([starts[1].requestId, starts[0].requestId]);
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
