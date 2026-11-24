import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../extension/cbg-access/main.js", import.meta.url), "utf8");
function fixture() {
  const emitted: unknown[] = [],
    intervals: (() => void)[] = [],
    listeners = new Map<string, (event?: any) => void>(),
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
    postMessage: (value: any) => {
      if (value.channel === "cbg-passive-v1") emitted.push(value);
    },
    addEventListener: (name: string, listener: (event?: any) => void) =>
      listeners.set(name, listener),
    removeEventListener: (name: string, listener: unknown) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    QueryArgs: { page: 1, token: "secret" },
  };
  const timeouts = new Map<number, () => void>();
  let timeoutSequence = 0;
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
    setTimeout: (fn: () => void) => {
      const id = ++timeoutSequence;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => timeouts.delete(id),
    TextEncoder,
    URL,
    TextDecoder,
  };
  const control = (command: string, force = false) =>
    listeners.get("message")?.({
      source: window,
      origin: scope.location.origin,
      data: { channel: "cbg-observer-control-v1", command, token: "test-binding", force },
    });
  let installed = false;
  return {
    scope,
    control,
    flush: () => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const fn of pending) fn();
    },
    window,
    emitted,
    intervals,
    listeners,
    documentListeners,
    install: (start = true) => {
      runInNewContext(source, scope);
      if (!installed && start) control("bind");
      installed = true;
    },
  };
}
describe("MAIN passive observer", () => {
  it("is dormant before bind, removes hooks on stop and installs one layer on rebind", () => {
    const f = fixture();
    const original = () => 7;
    f.window.ajax_with_recommend = original;
    f.install(false);
    expect(f.window.ajax_with_recommend).toBe(original);
    expect(f.intervals).toHaveLength(0);
    expect(f.emitted).toHaveLength(0);
    f.control("bind");
    expect(f.window.ajax_with_recommend).not.toBe(original);
    f.control("stop");
    expect(f.window.ajax_with_recommend).toBe(original);
    expect(f.documentListeners.size).toBe(0);
    const before = f.emitted.length;
    f.intervals[0]();
    expect(f.emitted).toHaveLength(before);
    f.control("bind");
    expect((f.window.ajax_with_recommend as () => number)()).toBe(7);
  });
  it("coalesces identical renders and shares cached configuration until an explicit fresh read", () => {
    const f = fixture();
    let calls = 0;
    f.window.__CBGReadMarketConfig = () => {
      calls++;
      return { kinds: [[20, "腰带"]] };
    };
    f.install();
    f.intervals[0]();
    f.intervals[0]();
    expect(calls).toBe(1);
    expect(f.emitted).toHaveLength(1);
    f.control("capture");
    f.flush();
    expect(calls).toBe(1);
    f.control("capture", true);
    f.flush();
    expect(calls).toBe(2);
    f.scope.location.href += "?page=2";
    f.intervals[0]();
    expect(calls).toBe(3);
    f.window.__CBGReadMarketConfig = () => {
      calls++;
      return { kinds: [] };
    };
    f.intervals[0]();
    expect(calls).toBe(4);
  });
  it("caches role parsing by raw content and product identity while explicit capture bypasses it", () => {
    const f = fixture();
    let calls = 0;
    f.scope.document.querySelector = (() => ({ value: "encoded-role" })) as any;
    f.window.EquipInfo = { server_id: 367, eid: "one" };
    f.window.decode_desc = () => "{}";
    f.window.RoleInfoParser = function () {
      calls++;
      return { raw_info: {}, result: {} };
    };
    f.install();
    f.intervals[0]();
    expect(calls).toBe(1);
    f.window.EquipInfo = { server_id: 367, eid: "two" };
    f.intervals[0]();
    expect(calls).toBe(2);
    f.control("capture", true);
    f.flush();
    expect(calls).toBe(3);
  });
  it("fences an older digest and every digest completed after stop", async () => {
    const f = fixture(),
      pending: ((value: ArrayBuffer) => void)[] = [];
    Object.assign(f.scope, {
      crypto: {
        randomUUID: () => "observation",
        subtle: { digest: () => new Promise<ArrayBuffer>((resolve) => pending.push(resolve)) },
      },
    });
    Object.assign(f.scope.document, { querySelector: () => ({ value: "public-encoded" }) });
    f.window.EquipInfo = { server_id: 367, eid: "old" };
    f.install();
    f.window.EquipInfo = { server_id: 367, eid: "new" };
    f.intervals[0]();
    pending[1](new Uint8Array([2]).buffer);
    await Promise.resolve();
    await Promise.resolve();
    pending[0](new Uint8Array([1]).buffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({
      value: { globals: { EquipInfo: { eid: "new" }, productRevision: "02" } },
    });
    f.intervals[0]();
    f.control("stop");
    pending[2](new Uint8Array([3]).buffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.emitted).toHaveLength(1);
  });
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
  for (const name of ["onSuccess", "onFailure"] as const)
    for (const fault of ["scheduler", "metadata"] as const)
      it.each([false, true])(
        `preserves ${name} completion and cleanup when ${fault} fails (callback throws: %s)`,
        (throws) => {
          const f = fixture(),
            receiver = {},
            response = { status: 0, msg: [] },
            returned = {},
            websiteError = new Error("original website callback failure"),
            observerError = new Error("observer failure");
          let calls = 0,
            pending: Record<string, any> | undefined;
          f.window.ajax_with_recommend = (options: Record<string, any>) => {
            pending = options;
            return "website request";
          };
          const callback = function (this: unknown, ...args: unknown[]) {
            calls++;
            expect(this).toBe(receiver);
            expect(args).toEqual([response, 3]);
            if (throws) throw websiteError;
            return returned;
          };
          const options = { data: { act: "overall_search_equip", page: 1 }, [name]: callback };
          const descriptor = Object.getOwnPropertyDescriptor(options, name);
          f.install();
          f.flush();
          expect((f.window.ajax_with_recommend as (options: unknown) => unknown)(options)).toBe(
            "website request",
          );
          expect(pending).toBe(options);
          const wrapped = pending![name];
          expect(wrapped).not.toBe(callback);
          if (fault === "scheduler")
            f.scope.setTimeout = () => {
              throw observerError;
            };
          else
            Object.defineProperty(f.scope, "Date", {
              value: class extends Date {
                override toISOString(): string {
                  throw observerError;
                }
              },
            });
          if (throws) {
            let caught: unknown;
            try {
              wrapped.call(receiver, response, 3);
            } catch (error) {
              caught = error;
            }
            expect(caught).toBe(websiteError);
          } else expect(wrapped.call(receiver, response, 3)).toBe(returned);
          expect(calls).toBe(1);
          expect(Object.getOwnPropertyDescriptor(options, name)).toEqual(descriptor);
        },
      );
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
      const options = {
        data: { act: "overall_search_equip", page: 1, kindid: "20" },
        onSuccess() {},
      };
      if (state === "ended") click.eventPhase = 0;
      else ajax(options);
      expect(ajax({ ...options })).toBe("website request");
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
    const options = {
      data: { act: "overall_search_equip", page: 1, kindid: "20" },
      onSuccess() {},
    };
    ajax({ ...options });
    ajax({ ...options });
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
  it("retains the original options object, descriptor flags and lazy asynchronous callbacks", () => {
    const f = fixture(),
      receiver = {},
      sentinel = {},
      args = { extra: 1 };
    let saved: any,
      calls = 0;
    const callback = function (this: unknown, value: unknown, rest: unknown) {
      calls++;
      expect(this).toBe(receiver);
      expect(value).toBe(sentinel);
      expect(rest).toBe(args);
      return sentinel;
    };
    const options = { data: { act: "overall_search_equip", page: 1 }, onSuccess: callback };
    const descriptor = Object.getOwnPropertyDescriptor(options, "onSuccess")!;
    f.window.ajax_with_recommend = function (this: unknown, value: unknown, tail: unknown) {
      expect(this).toBe(receiver);
      expect(value).toBe(options);
      expect(tail).toBe(args);
      saved = value;
      return sentinel;
    };
    f.install();
    expect((f.window.ajax_with_recommend as Function).call(receiver, options, args)).toBe(sentinel);
    expect(Object.getOwnPropertyDescriptor(options, "onSuccess")).toMatchObject({
      configurable: descriptor.configurable,
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
    });
    expect(saved.onSuccess.call(receiver, sentinel, args)).toBe(sentinel);
    expect(calls).toBe(1);
    expect(Object.getOwnPropertyDescriptor(options, "onSuccess")).toEqual(descriptor);
  });
  it("abandons reused options and never relabels a saved old wrapper as the second request", () => {
    const f = fixture(),
      saved: any[] = [];
    let calls = 0;
    f.window.ajax_with_recommend = (options: unknown) => saved.push(options);
    f.install();
    const options = {
      data: { act: "overall_search_equip", page: 1 },
      onSuccess: () => {
        calls++;
        return 7;
      },
    };
    const ajax = f.window.ajax_with_recommend as (options: unknown) => unknown;
    ajax(options);
    const old = options.onSuccess as (...args: unknown[]) => number;
    ajax(options);
    expect(saved[0]).toBe(options);
    expect(saved[1]).toBe(options);
    expect(old({ status: 0, msg: [] })).toBe(7);
    expect(saved[1].onSuccess({ status: 0, msg: [] })).toBe(7);
    expect(calls).toBe(2);
    const events = (f.emitted as any[])
      .map(({ value }) => value)
      .filter((value) => value.kind === "jsonp");
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("request");
  });
  it.each(["frozen", "accessor"])("leaves %s callback descriptors untouched", (kind) => {
    const f = fixture();
    let reads = 0,
      calls = 0;
    const options: any = { data: { act: "overall_search_equip" } };
    const callback = () => {
      calls++;
      return 9;
    };
    if (kind === "accessor")
      Object.defineProperty(options, "onSuccess", {
        configurable: true,
        get() {
          reads++;
          return callback;
        },
      });
    else {
      options.onSuccess = callback;
      Object.freeze(options);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, "onSuccess");
    f.window.ajax_with_recommend = (received: any) => {
      expect(received).toBe(options);
      return received.onSuccess();
    };
    f.install();
    expect((f.window.ajax_with_recommend as Function)(options)).toBe(9);
    expect(reads).toBe(kind === "accessor" ? 1 : 0);
    expect(calls).toBe(1);
    expect(Object.getOwnPropertyDescriptor(options, "onSuccess")).toEqual(descriptor);
  });
});
