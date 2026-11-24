import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(path.join(tmpdir(), "cbg-page-ax-"));
const executable = path.join(temporary, "page-ax");
const source = fileURLToPath(new URL("../../native/cbg-access/Input.m", import.meta.url));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

beforeAll(() => {
  if (process.platform !== "darwin") return;
  const harness = path.join(temporary, "page-ax.m");
  writeFileSync(
    harness,
    `// Include the production traversal/guards; disable all OS event posting.
#define CBG_INPUT_TEST_MONITOR 1
#define main unusedProductionMain
#include ${JSON.stringify(source)}
#undef main
int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *scenario = [NSString stringWithUTF8String:argv[1]];
    acceptedHostInstance = @"host"; acceptedGeneration = 1;
    acceptedStopEpoch = 0; acceptedSessionEpoch = @"session";
    stopped = preempted = false;
    NSDictionary *lease = @{@"activityId": @"old", @"authorizationEpoch": @1,
      @"stopEpoch": @0, @"browserSessionEpoch": @"session"};
    NSDictionary *newLease = @{@"activityId": @"new", @"authorizationEpoch": @2,
      @"stopEpoch": @0, @"browserSessionEpoch": @"session"};
    NSDictionary *request = @{@"hostInstanceEpoch": @"host", @"hostGeneration": @1,
      @"plan": @{@"stopEpoch": @0, @"browserSessionEpoch": @"session", @"activity": lease}};
    activeActivity = lease; ownsInput = true;
    activityDeadline = progressDeadline = monotonicMs() + 10000;
    __block int checks = 0, invalidations = 0, displayChecks = 0;
    __block NSString *reason = @"";
    if ([scenario hasPrefix:@"watchdog-"]) {
      bool expired = [scenario isEqual:@"watchdog-expired"] || [scenario isEqual:@"watchdog-old-scope"];
      checkActivityWatchdog([scenario isEqual:@"watchdog-idle"] ? nil : lease, expired, 1,
        ^NSString *{ checks++; return [scenario isEqual:@"watchdog-failure"] ? @"desktop-failed" : nil; },
        ^bool(CGDirectDisplayID value) { displayChecks++; return ![scenario isEqual:@"watchdog-display"]; },
        ^(NSDictionary *expected, NSString *failure) {
          invalidations++; reason = failure;
          if ([scenario isEqual:@"watchdog-old-scope"]) activeActivity = newLease;
          invalidateActivityFor(expected, failure, false);
        });
      writeResult(@{@"checks": @(checks), @"displayChecks": @(displayChecks),
        @"invalidations": @(invalidations), @"reason": reason,
        @"activeId": activeActivity[@"activityId"] ?: @"", @"ownsInput": @(ownsInput), @"stopped": @(stopped)});
      return 0;
    }
    if ([scenario hasPrefix:@"actual-"]) {
      if ([scenario isEqual:@"actual-stale"]) acceptedGeneration++;
      else activityDeadline = 0;
      // Both failures must precede check(), so no WindowServer access is needed.
      writeResult(@{@"error": pageInputGuard(request, 0) ?: @""});
      return 0;
    }
    __block double now = 0;
    double deadline = [scenario isEqual:@"proof-expired"] ? 30 : 700;
    __block int reads = 0, scans = 0, pauses = 0;
    __block bool wrongTimeout = false, pidChanged = false;
    __block NSString *focused = @"window";
    PageAXGuard guard = ^NSString *{
      if (stopped || preempted) return @"input-stopped-or-user-preempted";
      if (!authorityMatches(request)) return @"stale-native-dispatch-generation";
      NSString *failure = activityFailure(lease);
      if (failure) return failure;
      if ([scenario isEqual:@"proof-expired"] && now >= 30) return @"target-proof-expired-before-input";
      return pidChanged ? @"native-page-application-changed" : nil;
    };
    PageAXRead read = ^id(id element, CFStringRef attribute, double timeout, AXError *status) {
      reads++;
      if (timeout <= 0 || timeout > 0.1 || timeout * 1000 > deadline - now + 0.000001) wrongTimeout = true;
      now += [scenario isEqual:@"node-budget"] ? 0 : 1;
      *status = kAXErrorSuccess;
      NSString *key = (__bridge NSString *)attribute;
      if ([element isEqual:@"app"]) {
        if ([key isEqual:(__bridge NSString *)kAXRoleAttribute]) return @"AXApplication";
        return focused;
      }
      if ([key isEqual:(__bridge NSString *)kAXRoleAttribute]) {
        if ([element isEqual:@"malformed-role"]) return @{};
        if ([element isEqual:@"empty-role"]) return @"";
        if ([@[@"malformed-url", @"empty-url", @"other-url"] containsObject:element]) return @"AXWebArea";
        if ([element isEqual:@"web"]) {
          if ([scenario isEqual:@"window-changed"]) focused = @"other-window";
          if ([scenario isEqual:@"pid-changed"]) pidChanged = true;
          if ([scenario isEqual:@"stopped"]) stopped = true;
          if ([scenario isEqual:@"preempted"]) preempted = true;
          if ([scenario isEqual:@"old-scope"]) activeActivity = newLease;
          if ([scenario isEqual:@"authority-changed"]) acceptedGeneration++;
          if ([scenario isEqual:@"lease-expired"]) activityDeadline = 0;
        }
        return [@[@"web", @"duplicate"] containsObject:element] ? @"AXWebArea" : @"AXGroup";
      }
      if ([key isEqual:@"AXURL"]) {
        if ([element isEqual:@"malformed-url"]) return @{};
        if ([element isEqual:@"empty-url"]) return @"";
        if ([element isEqual:@"other-url"]) return [NSURL URLWithString:@"https://xyq.cbg.163.com/other"];
        if ([scenario isEqual:@"url-missing"]) { *status = kAXErrorNoValue; return nil; }
        return @"https://xyq.cbg.163.com/fixture";
      }
      if ([element isEqual:@"window"]) {
        scans++;
        if ([scenario isEqual:@"read-timeout"]) { now += timeout * 1000; *status = kAXErrorCannotComplete; return nil; }
        if ([scenario isEqual:@"late-read"]) { now = 701; return @[@"web"]; }
        if ([scenario isEqual:@"wide-tree"]) {
          NSMutableArray *children = [NSMutableArray new];
          for (int i = 0; i < 201; i++) [children addObject:@"leaf"];
          return children;
        }
        if ([scenario isEqual:@"node-budget"]) {
          NSMutableArray *children = [NSMutableArray new];
          for (int i = 0; i < 200; i++) [children addObject:@"branch"];
          return children;
        }
        if ([scenario isEqual:@"persistent-zero"] || [scenario isEqual:@"proof-expired"]) return @[];
        if ([scenario isEqual:@"zero-to-one"] && scans == 1) return @[@"stale"];
        if ([scenario isEqual:@"multiple"]) return @[@"web", @"duplicate"];
        if ([scenario isEqual:@"partial-after-one"]) return @[@"web", @"broken"];
        if ([@[@"malformed-role", @"empty-role", @"malformed-url", @"empty-url", @"other-url"] containsObject:scenario]) return @[@"web", scenario];
        if ([scenario isEqual:@"children-success-nil"] || [scenario isEqual:@"children-absence-value"]) return @[@"web", @"incomplete"];
        if ([scenario isEqual:@"deep-tree"]) return @[@"web", @"depth-1"];
        return @[@"web"];
      }
      if ([element isEqual:@"broken"]) { *status = kAXErrorCannotComplete; return nil; }
      if ([element isEqual:@"incomplete"]) {
        if ([scenario isEqual:@"children-success-nil"]) return nil;
        *status = kAXErrorAttributeUnsupported; return @[@"hidden-webarea"];
      }
      if ([element isEqual:@"branch"]) {
        NSMutableArray *children = [NSMutableArray new];
        for (int i = 0; i < 200; i++) [children addObject:@"leaf"];
        return children;
      }
      if ([element hasPrefix:@"depth-"]) return @[[NSString stringWithFormat:@"depth-%d", [[element substringFromIndex:6] intValue] + 1]];
      *status = kAXErrorAttributeUnsupported; return nil;
    };
    id window = nil, area = nil;
    NSArray *nodes = nil;
    NSString *error = waitForPageAX(@"app", @"https://xyq.cbg.163.com/fixture", read,
      guard, ^{ return now; }, ^(double ms) { pauses++; now += ms; }, deadline,
      &window, &nodes, &area);
    writeResult(@{@"error": error ?: @"", @"window": window ?: @"", @"area": area ?: @"",
      @"nodes": nodes ?: @[], @"reads": @(reads), @"scans": @(scans), @"pauses": @(pauses),
      @"now": @(now), @"wrongTimeout": @(wrongTimeout)});
    return 0;
  }
}
`,
  );
  const build = spawnSync(
    "clang",
    [
      "-fobjc-arc",
      "-fblocks",
      harness,
      "-o",
      executable,
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
    ],
    { encoding: "utf8" },
  );
  expect(build.stderr).toBe("");
  expect(build.status).toBe(0);
}, 15000);

function run(scenario: string) {
  const result = spawnSync(executable, [scenario], { encoding: "utf8", timeout: 5000 });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

it.skipIf(process.platform !== "darwin")(
  "accepts a complete unique first scan without an extra wait",
  () => {
    expect(run("already-ready")).toMatchObject({
      error: "",
      area: "web",
      nodes: ["web"],
      scans: 1,
      pauses: 0,
      wrongTimeout: false,
    });
  },
);

it.skipIf(process.platform !== "darwin")(
  "keeps a legal nonmatching WebArea URL distinct from an unknown URL",
  () => {
    expect(run("other-url")).toMatchObject({
      error: "",
      area: "web",
      nodes: ["web", "other-url"],
      scans: 1,
      pauses: 0,
    });
  },
);

it.skipIf(process.platform !== "darwin")(
  "accepts only the fresh complete tree after zero matches become one",
  () => {
    expect(run("zero-to-one")).toMatchObject({
      error: "",
      window: "window",
      area: "web",
      nodes: ["web"],
      scans: 2,
      pauses: 1,
      wrongTimeout: false,
    });
  },
);

it.skipIf(process.platform !== "darwin").each([
  ["multiple", "native-page-url-unverified"],
  ["read-timeout", "native-page-ax-read-failed"],
  ["url-missing", "native-page-ax-read-failed"],
  ["late-read", "native-page-url-unverified"],
  ["wide-tree", "native-page-ax-scan-incomplete"],
  ["deep-tree", "native-page-ax-scan-incomplete"],
  ["node-budget", "native-page-ax-scan-incomplete"],
  ["partial-after-one", "native-page-ax-read-failed"],
  ["malformed-role", "native-page-ax-read-failed"],
  ["empty-role", "native-page-ax-read-failed"],
  ["malformed-url", "native-page-ax-read-failed"],
  ["empty-url", "native-page-ax-read-failed"],
  ["children-success-nil", "native-page-ax-read-failed"],
  ["children-absence-value", "native-page-ax-read-failed"],
  ["window-changed", "native-page-window-changed"],
  ["pid-changed", "native-page-application-changed"],
  ["stopped", "input-stopped-or-user-preempted"],
  ["preempted", "input-stopped-or-user-preempted"],
  ["old-scope", "native-workflow-activity-required"],
  ["authority-changed", "stale-native-dispatch-generation"],
  ["lease-expired", "native-workflow-activity-expired"],
])("rejects %s without accepting a partial tree or retrying input", (scenario, error) => {
  expect(run(scenario)).toMatchObject({
    error,
    area: "",
    nodes: [],
    scans: 1,
    pauses: 0,
    wrongTimeout: false,
  });
});

it.skipIf(process.platform !== "darwin").each([
  ["persistent-zero", "native-page-url-unverified", 700],
  ["proof-expired", "target-proof-expired-before-input", 30],
])("bounds %s by the original remaining budget", (scenario, error, deadline) => {
  const result = run(String(scenario));
  expect(result).toMatchObject({ error, area: "", nodes: [], wrongTimeout: false });
  expect(result.now).toBeGreaterThanOrEqual(Number(deadline));
  expect(result.now).toBeLessThanOrEqual(Number(deadline) + 1);
  expect(result.pauses).toBeGreaterThan(0);
});

it.skipIf(process.platform !== "darwin").each([
  ["actual-stale", "stale-native-dispatch-generation"],
  ["actual-expired", "native-workflow-activity-expired"],
])("rejects %s before consulting WindowServer", (scenario, error) => {
  expect(run(scenario)).toEqual({ error });
});

it.skipIf(process.platform !== "darwin")(
  "revokes an already expired lease before any desktop or display query",
  () => {
    expect(run("watchdog-expired")).toEqual({
      checks: 0,
      displayChecks: 0,
      invalidations: 1,
      reason: "native-workflow-activity-expired",
      activeId: "",
      ownsInput: false,
      stopped: true,
    });
  },
);
it.skipIf(process.platform !== "darwin")(
  "fences an expired old watchdog sample from a replacement lease",
  () => {
    expect(run("watchdog-old-scope")).toEqual({
      checks: 0,
      displayChecks: 0,
      invalidations: 1,
      reason: "native-workflow-activity-expired",
      activeId: "new",
      ownsInput: true,
      stopped: false,
    });
  },
);
it.skipIf(process.platform !== "darwin").each([
  ["watchdog-idle", 0, 0, 0, "", "old"],
  ["watchdog-healthy", 1, 1, 0, "", "old"],
  ["watchdog-failure", 1, 0, 1, "desktop-failed", ""],
  ["watchdog-display", 1, 1, 1, "activity-display-unavailable", ""],
])(
  "preserves %s guard behavior",
  (scenario, checks, displayChecks, invalidations, reason, activeId) => {
    expect(run(String(scenario))).toMatchObject({
      checks,
      displayChecks,
      invalidations,
      reason,
      activeId,
    });
  },
);
