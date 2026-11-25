import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { nativeHostManifest } from "../native/cbg-access/install-plan.mjs";

// Public test key only. It fixes the temporary extension's identity across runs.
const key =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1Ej4FC/9wLJ8uvTDkTM1HunbRW7cOAzk/gfDbB1ej+vqHMIWZ57hO1W3EVLOTtJd8E06LTUQm0zkyd9vChLQpe7za/fceImGcse/TDdmtD90uky6mr9MYnG6MjIy9ZmrT20ia0qnas3m5v9OL+bh8hTQg4F2ru8DseYIBdn6iMikCOsJ/kA/ceoNlLi7zQjBjtZX5TDAGeeIzyLpWK6qnCss9M54p5K0plWoF4Ay37xLVH2vl+9FTrywbjNAC9tFSeId4zA5vDPvJxmyWTT38DLOfyt7IMd601QaOOjU88FoJnzTFlCKDgTiG92qkN9wjnYP16YRovk+gbGofz4xUwIDAQAB";
const extensionId = [
  ...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16),
]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
  .join("");
const repository = fileURLToPath(new URL("../", import.meta.url));
const chromePath =
  process.env.CBG_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hostName = "com.cbg.access_bridge";
const fixtureUrl =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role&installed_fixture=1";
const fixtureListings = Array.from({ length: 15 }, (_, index) => ({
  game_ordersn: `fixture-order-${index}`,
  eid: `fixture-eid-${index}`,
  server_id: 1,
  server_name: "隔离服",
  selling_time: "2026-11-18 08:00:00",
  create_time: "2026-11-18 07:00:00",
  expire_time: "2026-11-25 08:00:00",
  desc: "offline-description-".repeat(3000),
}));
assert(JSON.stringify(fixtureListings).length > 200000);
const fixtureRows = fixtureListings
  .map(
    (row, index) =>
      `<a class="soldImg" href="/equip?s=1&eid=${row.eid}" data_ordersn="${row.game_ordersn}" data_eid="${row.eid}" data_serverid="1" data_name="隔离角色${index + 1}" data_price="100" data_level="100">隔离角色${index + 1}</a>`,
  )
  .join("<br>");
const arguments_ = process.argv.slice(2);
if (
  arguments_.some((value) => !["--run", "--prepare-only", "--help"].includes(value)) ||
  (arguments_.includes("--run") && arguments_.includes("--prepare-only"))
)
  throw new Error("Usage: node scripts/native-installed-integration.mjs [--prepare-only | --run]");
if (arguments_.includes("--help")) {
  console.log(
    "Default/--prepare-only builds isolated artifacts without launching Chrome. --run launches only a new temporary Chrome profile; in Codex it requires escalated approval and coordination with other browser tests.",
  );
  process.exit(0);
}
assert.equal(process.platform, "darwin", "This acceptance script currently supports macOS only");
const artifact = await mkdtemp("/private/tmp/cbg-installed-");
const profile = path.join(artifact, "chrome-profile"),
  extension = path.join(artifact, "extension"),
  native = path.join(artifact, "native"),
  socketPath = path.join(artifact, "bridge.sock"),
  launchesPath = path.join(artifact, "native-launch-pids.txt");
const result = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  artifact,
  profile,
  extensionId,
  mode: arguments_.includes("--run") ? "installed-read-only" : "prepare-only",
  node: process.execPath,
  chrome: chromePath,
  assertions: [],
  messages: [],
  console: [],
  differences: [
    "Temporary manifest adds only the fixed public key; extension scripts are copied unchanged.",
    "Temporary host.mjs changes only configPath to the temporary mode-0600 host.json.",
    "The local Unix-socket fixture records and ACKs envelopes, and sends read-only status/focus only. It never sends resume/activity/execute.",
    "CDP installs the real extension; the focused fixture page must bind automatically without any toolbar action in this temporary profile. No chrome.runtime replacement or content-script injection is used.",
  ],
  notRun: [
    "OS business input",
    "TCC grants",
    "AX target execution",
    "lock screen",
    "display disconnection / second display",
    "user takeover during input",
    "active-input host restart",
  ],
};
const record = (name, status, evidence) => {
  result.assertions.push({ name, status, evidence });
  console.log(`${status}: ${name}`);
};
const save = () => writeFile(path.join(artifact, "result.json"), JSON.stringify(result, null, 2));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function command(binary, args) {
  const completed = spawnSync(binary, args, { encoding: "utf8" });
  assert.equal(completed.status, 0, completed.stderr || `${binary} failed`);
  return completed.stdout;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  return undefined;
}

let context, server;
const sockets = new Set();
try {
  await mkdir(native, { recursive: true, mode: 0o700 });
  await mkdir(path.join(profile, "NativeMessagingHosts"), { recursive: true, mode: 0o700 });
  await cp(path.join(repository, "extension/cbg-access"), extension, { recursive: true });
  result.extensionScriptHashes = {};
  for (const name of [
    "main.js",
    "isolated.js",
    "service-worker.js",
    "market-config.js",
    "market-rules.js",
    "pet-product-observation.js",
  ]) {
    const original = await readFile(path.join(repository, "extension/cbg-access", name));
    assert((await readFile(path.join(extension, name))).equals(original));
    result.extensionScriptHashes[name] = createHash("sha256").update(original).digest("hex");
  }
  const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  manifest.key = key;
  await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest, null, 2));
  const configPath = path.join(native, "host.json");
  await writeFile(configPath, JSON.stringify({ version: 1, extensionId, socketPath }), {
    mode: 0o600,
  });
  const hostSource = await readFile(path.join(repository, "native/cbg-access/host.mjs"), "utf8");
  const configDeclaration =
    'const configPath = path.join(os.homedir(), "Library/Application Support/CBGAccess/host.json");';
  assert.equal(
    hostSource.split(configDeclaration).length,
    2,
    "Host config declaration changed; inspect before adapting the test copy",
  );
  const installedHost = hostSource.replace(
    configDeclaration,
    `const configPath = ${JSON.stringify(configPath)};`,
  );
  await writeFile(path.join(native, "host.mjs"), installedHost);
  for (const name of ["command-authority.mjs", "activity-authority.mjs"])
    await cp(path.join(repository, "native/cbg-access", name), path.join(native, name));
  const helper = path.join(native, "cbg-input");
  command("/usr/bin/clang", [
    "-fobjc-arc",
    "-fblocks",
    path.join(repository, "native/cbg-access/Input.m"),
    "-o",
    helper,
    "-framework",
    "Cocoa",
    "-framework",
    "ApplicationServices",
  ]);
  record(
    "production helper build and no-input self-test",
    "passed",
    command(helper, ["--self-test"]).trim(),
  );
  await writeFile(
    path.join(native, "launch-host"),
    `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(launchesPath)}\nexec ${quote(process.execPath)} ${quote(path.join(native, "host.mjs"))} "$@"\n`,
    { mode: 0o700 },
  );
  const registration = path.join(profile, "NativeMessagingHosts", `${hostName}.json`);
  await writeFile(registration, JSON.stringify(nativeHostManifest(native, extensionId), null, 2), {
    mode: 0o600,
  });
  result.registration = registration;
  result.hostCopy = {
    productionSha256: createHash("sha256").update(hostSource).digest("hex"),
    temporarySha256: createHash("sha256").update(installedHost).digest("hex"),
    onlyReplacement: {
      from: configDeclaration,
      to: `const configPath = ${JSON.stringify(configPath)};`,
    },
  };
  await writeFile(
    path.join(artifact, "plan.json"),
    JSON.stringify(
      {
        ...result,
        runCommand: "node scripts/native-installed-integration.mjs --run",
        registrationRule:
          "NativeMessagingHosts under this invocation's --user-data-dir; no HOME change and no global/user-default registration",
      },
      null,
      2,
    ),
  );
  if (result.mode === "prepare-only") {
    record(
      "Chrome installation and Native Messaging",
      "not-run",
      "Prepared only; Chrome was not launched",
    );
    result.outcome = "prepared-not-run";
    await save();
    console.log(`Artifacts: ${artifact}`);
    process.exit(0);
  }

  let connectionSequence = 0;
  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    sockets.add(socket);
    const connection = ++connectionSequence;
    let buffer = "";
    socket.on("error", (error) => result.messages.push({ connection, socketError: error.message }));
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        result.messages.push({ connection, receivedAt: new Date().toISOString(), message });
        if (message.kind === "host-hello")
          socket.write(
            JSON.stringify({
              kind: "command",
              command: "status",
              actionId: `installed-status-${connection}`,
            }) + "\n",
          );
        if (message.version === 1 && message.connectionEpoch && message.messageId)
          socket.write(
            JSON.stringify({
              kind: "ack",
              connectionEpoch: message.connectionEpoch,
              messageId: message.messageId,
              sequence: message.sequence,
            }) + "\n",
          );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  console.log("Launching real Chrome with a temporary profile and real extension installation.");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--enable-logging=stderr", "--log-level=1"],
  });
  result.browserVersion = context.browser()?.version();
  context.on("console", (message) =>
    result.console.push({ type: message.type(), text: message.text() }),
  );
  await context.route("**/*", (route) => {
    if (route.request().url() === fixtureUrl)
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><title>Installed extension isolation fixture</title>
<h1>实装只读验收 · 隔离模拟页</h1><p>此页为本地固定数据；扩展与 Native Messaging 使用真实安装。没有发送原生业务输入。</p>
<a href="javascript:logout('https://xyq.cbg.163.com/cgi-bin/logout.py?act=logout')">退出</a><form><input name="price_min" value="100"></form>
<div id="query_result"><div id="soldList">${fixtureRows}</div><div id="pager_bar">第 1 页 共 1 页</div></div>
<script>var IsLogin=1,LoginInfo={login:1},QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC',price_min:'100'},QueryResult=${JSON.stringify(fixtureListings)};
window.ajax_with_recommend=function(){return 'fixture-only'};window.__installedFixtureAjax=window.ajax_with_recommend;</script>`,
      });
    if (route.request().url().startsWith(`chrome-extension://${extensionId}/`))
      return route.continue();
    return route.abort("blockedbyclient");
  });
  const browser = context.browser();
  assert(browser, "Persistent Chrome did not expose its browser session");
  const protocol = await browser.newBrowserCDPSession();
  let loaded;
  try {
    loaded = await protocol.send("Extensions.loadUnpacked", { path: extension });
  } catch (error) {
    record(
      "real unpacked extension installation",
      "blocked",
      `Chrome does not accept Extensions.loadUnpacked over this debugging pipe: ${error.message}. No global registration or flag bypass was attempted.`,
    );
    process.exitCode = 2;
    throw error;
  }
  assert.equal(loaded.id, extensionId);
  const extensions = await protocol.send("Extensions.getExtensions");
  assert(extensions.extensions.some((entry) => entry.id === extensionId && entry.enabled));
  record("real unpacked extension installation", "passed", {
    id: loaded.id,
    manifestKeyOnly: true,
  });
  const worker =
    context
      .serviceWorkers()
      .find((value) => value.url().startsWith(`chrome-extension://${extensionId}/`)) ||
    (await context.waitForEvent("serviceworker", {
      predicate: (value) => value.url().startsWith(`chrome-extension://${extensionId}/`),
      timeout: 10000,
    }));
  record("real MV3 service worker", "passed", {
    url: worker.url(),
    id: await worker.evaluate(() => chrome.runtime.id),
  });
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.bringToFront();
  await page.waitForFunction(() => !!window[Symbol.for("cbg.passive-observer.v1")]);
  const isolated = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((entry) => entry.url === url);
    if (!tab?.id) throw new Error("Fixture tab not found by the installed extension");
    return { tabId: tab.id, reply: await chrome.tabs.sendMessage(tab.id, { kind: "capture" }) };
  }, fixtureUrl);
  assert.equal(isolated.reply.ok, true);
  record("automatic MAIN and ISOLATED content-script installation", "passed", isolated);
  result.screenshots = [];
  const fixtureScreenshot = path.join(artifact, "installed-fixture-page.png");
  await page.screenshot({ path: fixtureScreenshot, fullPage: true });
  result.screenshots.push({
    path: fixtureScreenshot,
    description:
      "Actual isolated fixture page rendered by Chrome; no permission or input success is depicted",
  });
  result.actionTarget = { mode: "automatic-no-toolbar-action", url: fixtureUrl };
  const observed = await until(async () => {
    const stored = await worker.evaluate(() => chrome.storage.local.get("bridge"));
    const socketSnapshot = result.messages.find(
      (entry) =>
        entry.message?.kind === "snapshot" && entry.message.payload?.authenticated === true,
    );
    const pendingSnapshot = stored.bridge?.outbox?.find(
      (entry) => entry.kind === "snapshot" && entry.payload?.authenticated === true,
    );
    return socketSnapshot
      ? { via: "real Native Messaging socket", snapshot: socketSnapshot.message.payload }
      : pendingSnapshot
        ? { via: "real SW durable outbox", snapshot: pendingSnapshot.payload }
        : undefined;
  }, 10000);
  if (observed) {
    assert.equal(observed.snapshot.listing?.items?.length, fixtureListings.length);
    for (const [index, item] of observed.snapshot.listing.items.entries()) {
      assert.equal(item.raw.game_ordersn, fixtureListings[index].game_ordersn);
      assert.equal(item.raw.eid, fixtureListings[index].eid);
      assert.equal(item.raw.selling_time, fixtureListings[index].selling_time);
      assert.equal(item.raw.create_time, fixtureListings[index].create_time);
      assert.equal(item.raw.expire_time, fixtureListings[index].expire_time);
      assert.equal(item.raw.desc, undefined);
    }
    result.largeListingProjection = {
      sourceCharacters: JSON.stringify(fixtureListings).length,
      expectedRows: fixtureListings.length,
      observedRows: observed.snapshot.listing.items.length,
      noToolbarAction: true,
    };
  }
  record(
    "automatic domain binding and observer snapshot without toolbar action",
    observed ? "passed" : "blocked",
    observed ||
      "Real monitor denial disconnected the native port before a committed snapshot was retained; no synthetic runtime was substituted.",
  );

  // Use the installed worker's actual API. These are real native processes, with no input permit.
  const probe = () =>
    worker.evaluate(
      (name) =>
        new Promise((resolve) => {
          const messages = [];
          const nativePort = chrome.runtime.connectNative(name);
          nativePort.onMessage.addListener((message) => messages.push(message));
          const timer = setTimeout(() => {
            nativePort.disconnect();
            resolve({ closedByProbe: true, messages });
          }, 6500);
          nativePort.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError?.message || null;
            clearTimeout(timer);
            resolve({ error, messages });
          });
        }),
      hostName,
    );
  const launchedPids = async () =>
    (await readFile(launchesPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const firstProbe = await probe(),
    firstPids = await launchedPids();
  const secondProbe = await probe(),
    pids = await launchedPids();
  result.nativeProbes = [
    { attempt: 1, outcome: firstProbe, pids: firstPids },
    { attempt: 2, outcome: secondProbe, pids },
  ];
  const newPidsAfterTermination = pids.filter((pid) => !firstPids.includes(pid));
  const hellos = result.messages.filter((entry) => entry.message?.kind === "host-hello");
  if (!hellos.length || !pids.length) {
    record("temporary-profile Native host registration", "blocked", {
      nativeProbes: result.nativeProbes,
      reason:
        "Chrome did not launch the host registered under the temporary user-data-dir. No default/global path was installed or overwritten.",
    });
    process.exitCode = 2;
  } else {
    record("temporary-profile Native host registration", "passed", {
      registration,
      realHostConnections: hellos.length,
      pids,
    });
    record(
      "new real host process after native port termination",
      newPidsAfterTermination.length ? "passed" : "blocked",
      {
        pids,
        newPidsAfterTermination,
        scope: "Read-only connection/relaunch only; active-input restart remains untested",
      },
    );
  }
  const bridgeForFocus = await worker.evaluate(
    async () => (await chrome.storage.local.get("bridge")).bridge,
  );
  const focusTab = await worker.evaluate(
    async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0],
  );
  // No resume/activity/execute is sent. Focusing an existing binding must remain read-only.
  const focusAction = "installed-readonly-focus";
  const focusSocket = [...sockets].at(-1);
  assert(focusSocket && bridgeForFocus.bound);
  focusSocket.write(
    JSON.stringify({
      kind: "command",
      command: "focus",
      actionId: focusAction,
      context: {
        ...bridgeForFocus.bound,
        connectionEpoch: bridgeForFocus.connectionEpoch,
        url: focusTab.url.split("#")[0],
      },
    }) + "\n",
  );
  const focusedReply = await until(
    async () =>
      result.messages.find(
        (entry) => entry.message?.kind === "input-result" && entry.message.actionId === focusAction,
      ),
    10000,
  );
  assert.equal(focusedReply?.message.ok, true, JSON.stringify(focusedReply));
  assert.equal(focusedReply?.message.posted, false);
  assert.equal(
    result.messages.some(
      (entry) => entry.message?.kind === "command-proof" && entry.message.actionId === focusAction,
    ),
    false,
  );
  record("explicit focus through real Native host remains read-only", "passed", {
    ok: true,
    posted: false,
    noInputAuthority: true,
  });
  const denied = result.messages.filter(
    (entry) =>
      entry.message?.kind === "host-status" &&
      entry.message.reason === "input-monitor-startup-failed",
  );
  const startupUnconfirmed = result.messages.filter(
    (entry) =>
      entry.message?.kind === "host-status" &&
      /startup-timeout|native-helper-(?:exited|unavailable)/.test(entry.message.reason || ""),
  );
  const permissions = result.messages.filter(
    (entry) => entry.message?.kind === "input-result" && entry.message.permissions,
  );
  record(
    "real helper permission/startup outcome",
    denied.length
      ? "rejected-as-expected"
      : permissions.length
        ? "observed-ready-without-input"
        : "blocked",
    { denied, startupUnconfirmed, permissions },
  );
  record(
    "OS business input",
    "not-run",
    "The socket fixture sent ACK/status/focus only; no resume, activity lease, execute, permission spoof or TCC grant was issued.",
  );
  const installedPage = await context.newPage();
  await installedPage.goto(`chrome://extensions/?id=${extensionId}`);
  await installedPage.locator("extensions-manager").waitFor();
  const installedScreenshot = path.join(artifact, "chrome-installed-extension.png");
  await installedPage.screenshot({ path: installedScreenshot, fullPage: true });
  result.screenshots.push({
    path: installedScreenshot,
    description: "Actual Chrome extension management page in the temporary profile",
  });
} catch (error) {
  result.failure = { name: error.name, message: error.message };
  if (!process.exitCode) process.exitCode = 1;
} finally {
  if (context)
    await context
      .close()
      .catch((error) => result.console.push({ type: "cleanup", text: error.message }));
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  const blocked = result.assertions.some((entry) => entry.status === "blocked");
  result.outcome = result.failure
    ? "failed"
    : blocked
      ? "blocked-read-only-scope"
      : "passed-read-only-scope";
  if (blocked && !process.exitCode) process.exitCode = 2;
  result.exitCode = process.exitCode || 0;
  result.finishedAt = new Date().toISOString();
  await save();
  console.log(`Artifacts: ${artifact}`);
}
