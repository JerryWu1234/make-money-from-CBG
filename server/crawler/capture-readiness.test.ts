import { expect, it, vi } from "vite-plus/test";
import { CAPTURE_VERSION } from "./compact";
import { captureIssues, collectCompleteCapture, IncompleteCaptureError } from "./capture-readiness";
import { CrawlStore } from "./store";
import { analysisRecord } from "../../tests/fixtures/analysis";
import type { RoleDetail } from "./types";
import { gunzipSync } from "node:zlib";

const complete = () => ({
  ...analysisRecord("a").detail!,
  captureVersion: CAPTURE_VERSION,
  valuation: {
    version: 1 as const,
    fields: [],
    issues: [],
    source: { serverId: "367", eid: "item-a" },
  },
  equipmentCapture: {
    version: 1 as const,
    collectedAt: "now",
    complete: true,
    issues: [] as string[],
    emptyProof: "explicit-text" as const,
  },
  petCapture: { version: 1 as const, collectedAt: "now", complete: true, issues: [] as string[] },
});

it("读取返回时单件预算到期保留真实超时原因，不显示整轮暂停", async () => {
  const control = new AbortController();
  const reason = Object.assign(new Error("角色详情采集超过 180 秒总时限"), {
    name: "IncompleteDetailError",
  });
  const partial = complete();
  partial.equipmentCapture.complete = false;
  partial.equipmentCapture.issues = ["装备名称缺失"];
  const read = vi.fn(async () => {
    control.abort(reason);
    return partial;
  });
  const error = (await collectCompleteCapture(read, control.signal, vi.fn()).catch(
    (error: unknown) => error,
  )) as IncompleteCaptureError;
  expect(error.message).toContain(reason.message);
  expect(error.message).not.toContain("采集已暂停");
  expect(error.cause).toBe(reason);
  expect(error.detail).toBe(partial);
  expect(read).toHaveBeenCalledOnce();
});
it("缺项只读取一次，保留部分资料而不返回可分析半成品", async () => {
  const partial = complete();
  partial.petCapture.complete = false;
  partial.petCapture.issues = ["宝宝装备图标未完整读取"];
  const read = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(complete());
  const report = vi.fn();
  await expect(
    collectCompleteCapture(read, new AbortController().signal, report),
  ).rejects.toMatchObject({
    name: "IncompleteDetailError",
    detail: partial,
    message: expect.stringContaining("未进入角色分析"),
  });
  expect(read).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});
it("中途超时携带已读资料，不再重开整件并保留快照与原始错误", async () => {
  const partial = complete();
  delete (partial as RoleDetail).valuation;
  const timeout = Object.assign(new Error("坐骑标签读取超时"), { name: "TimeoutError" });
  const interrupted = new IncompleteCaptureError("详情读取中断（坐骑）", partial, timeout);
  const read = vi.fn().mockRejectedValueOnce(interrupted).mockResolvedValueOnce(complete());
  const error = (await collectCompleteCapture(read, new AbortController().signal, vi.fn()).catch(
    (error: unknown) => error,
  )) as IncompleteCaptureError;
  expect(error).toBeInstanceOf(IncompleteCaptureError);
  expect(error.detail).toBe(partial);
  expect(error.cause).toBe(interrupted);
  expect(read).toHaveBeenCalledOnce();
  expect(captureIssues(partial, true)).toContain("角色本体资料未核验");
});
it.each(["网站要求安全验证", "page.goto: net::ERR_CONNECTION_CLOSED"])(
  "部分资料包装不能吞掉不可重试原因：%s",
  async (message) => {
    const cause = new Error(message);
    const read = vi
      .fn()
      .mockRejectedValue(new IncompleteCaptureError("部分资料", complete(), cause));
    await expect(collectCompleteCapture(read, new AbortController().signal, vi.fn())).rejects.toBe(
      cause,
    );
    expect(read).toHaveBeenCalledOnce();
  },
);
it("中途携带快照时收到暂停立即退出，保留快照及暂停原因", async () => {
  const control = new AbortController();
  const reason = new Error("用户暂停采集");
  const partial = complete();
  const read = vi.fn(async () => {
    control.abort(reason);
    throw new IncompleteCaptureError(
      "部分资料",
      partial,
      Object.assign(new Error("超时"), { name: "TimeoutError" }),
    );
  });
  await expect(collectCompleteCapture(read, control.signal, vi.fn())).rejects.toMatchObject({
    detail: partial,
    cause: reason,
  });
  expect(read).toHaveBeenCalledOnce();
});
it("已经暂停时不启动新读取", async () => {
  const control = new AbortController();
  const reason = new Error("用户暂停采集");
  control.abort(reason);
  const read = vi.fn().mockResolvedValue(complete());
  await expect(collectCompleteCapture(read, control.signal, vi.fn())).rejects.toBe(reason);
  expect(read).not.toHaveBeenCalled();
});
it("登录或安全验证不自动重试，停止采集而不越过访问限制", async () => {
  const read = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("网站要求安全验证"), { name: "IncompleteDetailError" }),
    );
  await expect(collectCompleteCapture(read, new AbortController().signal, vi.fn())).rejects.toThrow(
    "安全验证",
  );
  expect(read).toHaveBeenCalledOnce();
});
const detailUrl = "https://xyq.cbg.163.com/equip?s=962&eid=202609301400113-962-FKBHP23OIEVM";
const interruptedNavigation = (from = detailUrl, to = from) =>
  new Error(
    `page.goto: Navigation to "${from}" is interrupted by another navigation to "${to}"\nCall log:\n  - navigating to "${from}", waiting until "domcontentloaded"\n`,
  );
it("同一官网详情URL的导航互相中断后重读，完整资料通过核验再返回", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(interruptedNavigation())
    .mockResolvedValueOnce(complete());
  const report = vi.fn();
  const captured = await collectCompleteCapture(read, new AbortController().signal, report);
  expect(captureIssues(captured, true)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledOnce();
});
it("同URL导航中断最多重读三次，耗尽后仅标记该商品详情未完成", async () => {
  const original = interruptedNavigation();
  const read = vi.fn().mockRejectedValue(original);
  const report = vi.fn();
  await expect(
    collectCompleteCapture(read, new AbortController().signal, report),
  ).rejects.toMatchObject({
    name: "IncompleteDetailError",
    message: expect.stringContaining("未进入角色分析"),
    cause: original,
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(report).toHaveBeenCalledTimes(2);
});
it("已返回缺项资料后不再进行下一轮导航，保留该次资料", async () => {
  const partial = complete();
  partial.petCapture.complete = false;
  partial.petCapture.issues = ["宝宝资料缺项"];
  const read = vi.fn().mockResolvedValueOnce(partial).mockRejectedValue(interruptedNavigation());
  const error = await collectCompleteCapture(read, new AbortController().signal, vi.fn()).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(IncompleteCaptureError);
  expect((error as IncompleteCaptureError).detail).toBe(partial);
  expect(read).toHaveBeenCalledOnce();
});
it.each([
  ["其他角色", detailUrl, detailUrl.replace("FKBHP23OIEVM", "ANOTHERROLE")],
  ["同角色不同追踪URL", detailUrl, detailUrl + "&reco_request_id=other"],
  ["登录页", detailUrl, "https://xyq.cbg.163.com/login"],
  ["同一登录URL", "https://xyq.cbg.163.com/login", "https://xyq.cbg.163.com/login"],
  ["其他站点", "https://example.com/equip?s=962&eid=a", "https://example.com/equip?s=962&eid=a"],
])("%s导航中断不按可恢复同详情处理", async (_label, from, to) => {
  const error = interruptedNavigation(from, to);
  const read = vi.fn().mockRejectedValue(error);
  await expect(collectCompleteCapture(read, new AbortController().signal, vi.fn())).rejects.toBe(
    error,
  );
  expect(read).toHaveBeenCalledOnce();
});
it("同URL中断伴随安全验证提示仍立即停止", async () => {
  const error = interruptedNavigation();
  error.message += "网站要求安全验证";
  const read = vi.fn().mockRejectedValue(error);
  await expect(collectCompleteCapture(read, new AbortController().signal, vi.fn())).rejects.toBe(
    error,
  );
  expect(read).toHaveBeenCalledOnce();
});
it("普通详情错误不被同URL重读规则吞掉", async () => {
  const error = new Error("page.goto: net::ERR_CONNECTION_CLOSED");
  const read = vi.fn().mockRejectedValue(error);
  await expect(collectCompleteCapture(read, new AbortController().signal, vi.fn())).rejects.toBe(
    error,
  );
  expect(read).toHaveBeenCalledOnce();
});
it("同URL导航中断期间收到暂停时立即退出，不再重读", async () => {
  const control = new AbortController();
  const reason = new Error("用户暂停采集");
  const read = vi.fn(async () => {
    control.abort(reason);
    throw interruptedNavigation();
  });
  await expect(collectCompleteCapture(read, control.signal, vi.fn())).rejects.toBe(reason);
  expect(read).toHaveBeenCalledOnce();
});
it("缺少完整性证据不能通过新采集核验", () => {
  const detail = analysisRecord("a").detail!;
  delete detail.equipmentCapture;
  delete detail.petCapture;
  expect(captureIssues(detail, true)).toEqual(
    expect.arrayContaining(["装备完整性未核验", "宝宝完整性未核验"]),
  );
});
it("装备空库存原因只显示一次，仍保留失败核验", () => {
  const detail = complete();
  delete (detail.equipmentCapture as { emptyProof?: string }).emptyProof;
  detail.equipmentCapture.complete = false;
  detail.equipmentCapture.issues = [
    "人物装备库存是否为空尚未核对，需确认穿戴与随身装备区域后再计价",
  ];
  detail.tabs.push({
    name: "道具/法宝",
    text: "现金100",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  });
  expect(
    captureIssues(detail, true).filter((issue) => issue.includes("装备库存是否为空")),
  ).toHaveLength(1);
  expect(captureIssues(detail, true).length).toBeGreaterThan(0);
});
it("部分资料仍保存，但不标记详情完整、不推进成功断点；补采后才能转完整", () => {
  const store = new CrawlStore(":memory:");
  const record = analysisRecord("a");
  try {
    store.observe(record.listing);
    const partial = complete();
    partial.equipmentCapture.complete = false;
    partial.equipmentCapture.issues = ["装备属性未读全"];
    const point = {
      key: record.listing.key,
      time: null,
      order: "selling_time DESC",
      page: 1,
      savedAt: "now",
    };
    expect(store.save(record.listing, partial, point)).toBe(false);
    expect(store.detail(record.listing.key)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("装备属性未读全"),
    });
    expect(store.checkpoint()).toBeUndefined();
    expect(store.save(record.listing, complete(), point)).toBe(true);
    expect(store.detail(record.listing.key)).toMatchObject({ status: "complete", error: null });
    expect(store.checkpoint()).toEqual(point);
  } finally {
    store.close();
  }
});

const schoolPairs = [
  ["0", "九转玄功"],
  ["164", "武神显圣"],
  ["161", "啸傲"],
  ["164", "气吞山河"],
  ["164", "诛魔"],
  ["164", "天地无极"],
  ["164", "法天象地"],
];
function schoolCapture(observed = 7, textPairs = 7): RoleDetail {
  const detail: RoleDetail = { ...complete(), captureMode: "all" };
  delete detail.formatVersion;
  detail.raw = { encodedRoleData: "原始商品源码必须保留", role: { school: "fixture" } };
  detail.tabs = detail.tabs.map((tab) =>
    tab.name === "技能"
      ? {
          ...tab,
          text: `师门技能\n${schoolPairs.slice(0, textPairs).flat().join("\n")}\n生活技能\n140\n强身术`,
          elements: [{ tag: "IMG", data_skill_type: "school_skill", data_equip_name: "原始图标" }],
          items: schoolPairs.slice(0, observed).map(([level, name], index) => ({
            index,
            name,
            level,
            kind: "skill",
            category: "师门技能",
          })),
        }
      : tab,
  );
  return detail;
}
const schoolTab = (detail: RoleDetail) => detail.tabs.find((tab) => tab.name === "技能")!;
it.each(["all", "body"] as const)("当前%s采集合同不把六项师门资料称为完整", (mode) => {
  const detail = schoolCapture(6, 6);
  detail.captureMode = mode;
  expect(captureIssues(detail, true, mode === "all")).toEqual(
    expect.arrayContaining([expect.stringContaining("师门技能")]),
  );
});
it("六项原文缺失时单次失败并保留原始部分资料", async () => {
  const detail = schoolCapture(6, 6);
  const read = vi.fn().mockResolvedValue(detail);
  const error = await collectCompleteCapture(read, new AbortController().signal, vi.fn()).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(IncompleteCaptureError);
  expect(read).toHaveBeenCalledOnce();
  expect((error as IncompleteCaptureError).detail.raw).toEqual(detail.raw);
  expect(schoolTab((error as IncompleteCaptureError).detail).items).toHaveLength(6);
});
it("七对明确原文可补齐六个图标，不重采且不丢源码、elements或时间", async () => {
  const detail = schoolCapture(6, 7);
  const original = structuredClone(detail);
  const read = vi.fn().mockResolvedValue(detail);
  const result = await collectCompleteCapture(read, new AbortController().signal, vi.fn());
  expect(read).toHaveBeenCalledOnce();
  expect(schoolTab(result).items).toHaveLength(7);
  expect(result.raw).toBe(detail.raw);
  expect(schoolTab(result).elements).toBe(schoolTab(detail).elements);
  expect(result.url).toBe(detail.url);
  expect(result.collectedAt).toBe(detail.collectedAt);
  expect(result.formatVersion).toBeUndefined();
  expect(detail).toEqual(original);
  expect(captureIssues(result, true)).toEqual([]);
});
it.each([
  "missing-tab",
  "duplicate-tab",
  "duplicate-name",
  "blank-name",
  "missing-level",
  "negative-level",
  "fractional-level",
  "wrong-kind",
  "ambiguous-text",
])("明确采集合同拒绝不完整或歧义师门资料：%s", (kind) => {
  const detail = schoolCapture(kind === "ambiguous-text" ? 6 : 7, 7);
  const tab = schoolTab(detail);
  if (kind === "missing-tab") detail.tabs = detail.tabs.filter((value) => value !== tab);
  if (kind === "duplicate-tab") detail.tabs.push(structuredClone(tab));
  if (kind === "duplicate-name") tab.items![1].name = tab.items![0].name;
  if (kind === "blank-name") tab.items![1].name = " ";
  if (kind === "missing-level") delete tab.items![1].level;
  if (kind === "negative-level") tab.items![1].level = "-1";
  if (kind === "fractional-level") tab.items![1].level = "1.5";
  if (kind === "wrong-kind") tab.items![1].kind = "equipment";
  if (kind === "ambiguous-text") tab.text = tab.text.replace("法天象地", "法天象地：164");
  expect(captureIssues(detail, true)).toEqual(
    expect.arrayContaining([expect.stringContaining("师门技能")]),
  );
});
it("七项唯一技能和明确零级通过，不把零级当缺失", async () => {
  const detail = schoolCapture();
  await expect(
    collectCompleteCapture(
      vi.fn().mockResolvedValue(detail),
      new AbortController().signal,
      vi.fn(),
    ),
  ).resolves.toBe(detail);
});
it.each(["no-mode", "old-version", "no-valuation"])(
  "历史简化资料维持兼容，不扩大本次门槛：%s",
  (kind) => {
    const detail = schoolCapture(6, 6);
    if (kind === "no-mode") delete detail.captureMode;
    if (kind === "old-version") detail.captureVersion = CAPTURE_VERSION - 1;
    if (kind === "no-valuation") delete detail.valuation;
    expect(captureIssues(detail).some((issue) => issue.includes("师门技能"))).toBe(false);
  },
);
it("六项师门不得入完整库，补全后才推进断点并保留归档源码", () => {
  const store = new CrawlStore(":memory:");
  const record = analysisRecord("school-contract");
  const partial = schoolCapture(6, 6);
  partial.valuation!.source = { serverId: record.listing.serverId, eid: record.listing.eid };
  const point = {
    key: record.listing.key,
    time: null,
    order: "selling_time DESC",
    page: 1,
    savedAt: partial.collectedAt,
  };
  try {
    store.observe(record.listing);
    expect(store.save(record.listing, partial, point)).toBe(false);
    expect(store.count()).toBe(0);
    expect(store.count()).toBe(0);
    expect(store.checkpoint()).toBeUndefined();
    expect(store.detail(record.listing.key)).toMatchObject({ status: "failed" });
    const correctable = schoolCapture(6, 7);
    correctable.valuation!.source = { serverId: record.listing.serverId, eid: record.listing.eid };
    expect(store.save(record.listing, correctable, point)).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.checkpoint()).toEqual(point);
    const saved = store.detail(record.listing.key) as { detail: RoleDetail };
    expect(schoolTab(saved.detail).items).toHaveLength(7);
    const archived = JSON.parse(
      gunzipSync(
        store.db
          .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
          .get(record.listing.key)!.source_gzip as Uint8Array,
      ).toString(),
    ) as RoleDetail;
    expect(archived.raw).toEqual(correctable.raw);
    expect(schoolTab(archived).elements).toEqual(schoolTab(correctable).elements);
  } finally {
    store.close();
  }
});

it("一次采集返回缺项时只保存缺项，不自动重新打开整件商品", async () => {
  const partial = complete();
  partial.equipmentCapture.complete = false;
  partial.equipmentCapture.issues = ["武器属性尚未读取"];
  const read = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(complete());
  await expect(
    collectCompleteCapture(read, new AbortController().signal, vi.fn()),
  ).rejects.toMatchObject({
    name: "IncompleteDetailError",
    detail: partial,
  });
  expect(read).toHaveBeenCalledOnce();
});
