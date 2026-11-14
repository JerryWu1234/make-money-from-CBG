import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquireConditionAuditRuntime,
  compileAuditThroughService,
} from "./condition-rules-audit-runtime.mjs";

// Fake listeners exercise ownership ordering without touching a real login directory,
// calling a model, or starting a second application service.
function listener(events, fail = false) {
  const http = new EventEmitter();
  http.listening = false;
  http.listen = () => {
    events.push("listen");
    queueMicrotask(() => {
      if (fail) http.emit("error", new Error("fixture-bind-failure"));
      else {
        http.listening = true;
        http.emit("listening");
      }
    });
  };
  http.close = () => {
    events.push("close");
    http.listening = false;
    queueMicrotask(() => http.emit("close"));
  };
  return http;
}

await test("standalone audit acquires ownership before binding and releases after listener closes", async () => {
  const events = [];
  const lease = await acquireConditionAuditRuntime("/fixture/project", {
    httpServerFactory: () => listener(events),
    attach: async (server, options) => {
      events.push("attach");
      assert.equal(server.config.root, "/fixture/project");
      assert.equal(options.projectRoot, "/fixture/project");
      return async () => {
        events.push("release");
      };
    },
  });
  assert.deepEqual(events, ["attach", "listen"]);
  await lease.close();
  await lease.close();
  assert.deepEqual(events, ["attach", "listen", "close", "release"]);
});

await test("an existing service owner blocks standalone audit before binding or AI", async () => {
  const events = [];
  const blocked = new Error("已有服务持有租约");
  await assert.rejects(
    acquireConditionAuditRuntime("/fixture/project", {
      httpServerFactory: () => listener(events),
      attach: async () => {
        events.push("attach-denied");
        throw blocked;
      },
    }),
    (error) => error.cause === blocked && /未启动 AI/.test(error.message),
  );
  assert.deepEqual(events, ["attach-denied"]);
});

await test("bind failure releases audit ownership without leaving a listener", async () => {
  const events = [];
  await assert.rejects(
    acquireConditionAuditRuntime("/fixture/project", {
      httpServerFactory: () => listener(events, true),
      attach: async () => async () => {
        events.push("release");
      },
    }),
    (error) => /fixture-bind-failure/.test(error.cause?.message),
  );
  assert.deepEqual(events, ["listen", "release"]);
});

const input = [
  { id: "C1", text: "速度大于800" },
  { id: "C2", text: "等级175" },
];
const endpoint = "http://127.0.0.1:5173/api/analysis/conditions/compile";
const normalize = (rule, text) => {
  assert.ok(rule);
  assert.equal(rule.sourceText, text);
  return rule;
};
await test("managed compilation uses the service process and binds the exact input texts", async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(String(url), endpoint);
    assert.equal(options.headers.Origin, "http://127.0.0.1:5173");
    const data = JSON.parse(options.body);
    assert.equal(data.conditions.evaluation, "sequence");
    assert.equal(data.conditions.children[1].join, "and");
    assert.equal(data.provider, "codex");
    assert.equal(data.model, "fixture-model");
    return {
      ok: true,
      json: async () => ({
        conditions: {
          children: input.map((item) => ({ ...item, rule: { sourceText: item.text } })),
        },
      }),
    };
  };
  const result = await compileAuditThroughService(
    endpoint,
    input,
    { provider: "codex", model: "fixture-model" },
    normalize,
    request,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    result.map((item) => item.id),
    ["C1", "C2"],
  );
});

await test("compile-url cannot send conditions or local auth context to a remote endpoint", async () => {
  let calls = 0;
  for (const url of [
    "https://example.com/api/analysis/conditions/compile",
    "http://127.0.0.1:5173/api/analysis/start",
    "http://user:password@localhost:5173/api/analysis/conditions/compile",
    endpoint + "?extra=1",
  ]) {
    await assert.rejects(
      compileAuditThroughService(url, input, { provider: "codex" }, normalize, async () => {
        calls++;
      }),
    );
  }
  assert.equal(calls, 0);
});

await test("managed service errors and malformed results fail closed without standalone fallback", async () => {
  await assert.rejects(
    compileAuditThroughService(endpoint, input, { provider: "codex" }, normalize, async () => ({
      ok: false,
      status: 404,
    })),
    /HTTP 404/,
  );
  await assert.rejects(
    compileAuditThroughService(endpoint, input, { provider: "codex" }, normalize, async () => ({
      ok: true,
      json: async () => ({ conditions: { children: [{ id: "C1" }, { id: "C1" }] } }),
    })),
    /重复/,
  );
  await assert.rejects(
    compileAuditThroughService(endpoint, input, { provider: "codex" }, normalize, async () => ({
      ok: true,
      json: async () => ({
        conditions: {
          children: [
            { id: "C1", rule: { sourceText: "被替换" } },
            { id: "C2", rule: { sourceText: input[1].text } },
          ],
        },
      }),
    })),
  );
});
