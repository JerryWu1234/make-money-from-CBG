import { afterEach, describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { roleRecord } from "../../tests/fixtures/saved-role";
import type { SavedRoleRecord } from "../crawler/types";
import { buildProductDocument } from "./product-document";
import { prepareProductInputs } from "./prepare-inputs";

function fixture(): SavedRoleRecord {
  const source = roleRecord("a", true);
  return {
    ...source,
    status: "complete",
    listing: {
      ...source.listing,
      ordersn: "fixture-order",
      createdTime: null,
      orderTime: null,
      attrs: { "data-visible": "测试列表属性" },
    },
    detail: {
      ...source.detail,
      url: source.listing.url,
      raw: {
        zero: 0,
        flag: false,
        nested: { missing: null },
        longText: "完整补充内容".repeat(2000),
      },
    },
    error: null,
  } as SavedRoleRecord;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function databaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "cbg-product-input-test-"));
  directories.push(directory);
  const database = join(directory, "cbg.sqlite");
  const output = join(directory, "inputs");
  const record = fixture();
  const db = new DatabaseSync(database);
  try {
    db.exec(
      "CREATE TABLE listings(key TEXT PRIMARY KEY, listing_json TEXT, detail_json TEXT, status TEXT)",
    );
    const insert = db.prepare("INSERT INTO listings VALUES(?,?,?,?)");
    insert.run(
      record.listing.key,
      JSON.stringify(record.listing),
      JSON.stringify(record.detail),
      "complete",
    );
    insert.run("pending", "{}", null, "pending");
    insert.run("failed", "{}", null, "failed");
  } finally {
    db.close();
  }
  return { database, output, record };
}

describe("一件商品一份完整 AI 输入", () => {
  it("完整保留所有标签、装备、八只召唤兽和补充数据，不截断原文", () => {
    const record = fixture();
    record.detail!.tabs[0].tables = [
      [
        ["气血", "0"],
        ["防御", "未采集"],
      ],
    ];
    record.detail!.tabs[0].tooltips = ["保留原始提示"];
    const document = buildProductDocument(record);
    const payload = document.text.split("【商品资料开始】\n")[1].split("\n【商品资料结束】")[0];
    expect(JSON.parse(payload)).toEqual({ listing: record.listing, detail: record.detail });
    expect(document.text).toContain("宝宝8");
    expect(document.text).toContain("罗汉金钟");
    expect(document.text).toContain("玄武躯");
    expect(document.text).toContain("保留原始提示");
    expect(document.contentHash).toBe(
      createHash("sha256").update(document.text, "utf8").digest("hex"),
    );
  });

  it("字段键顺序变化仍指向同一原文，价格或召唤兽变化生成新快照", () => {
    const record = fixture();
    const first = buildProductDocument(record);
    const reordered = structuredClone(record);
    reordered.listing = Object.fromEntries(
      Object.entries(record.listing).reverse(),
    ) as SavedRoleRecord["listing"];
    reordered.detail!.raw = {
      longText: record.detail!.raw.longText,
      nested: { missing: null },
      flag: false,
      zero: 0,
    };
    expect(buildProductDocument(reordered)).toEqual(first);
    reordered.listing.price = "223";
    expect(buildProductDocument(reordered).contentHash).not.toBe(first.contentHash);
    const petChanged = structuredClone(record);
    petChanged.detail!.tabs.find((tab) => tab.pets?.length)!.pets![7].equipment[0].description =
      "速度：999";
    expect(buildProductDocument(petChanged).contentHash).not.toBe(first.contentHash);
  });

  it("详情未完成或缺少追溯信息时不生成可发送的商品资料", () => {
    expect(() => buildProductDocument({ ...fixture(), status: "pending" })).toThrow("尚未完整采集");
    expect(() => buildProductDocument({ ...fixture(), detail: null })).toThrow("尚未完整采集");
    const record = fixture();
    record.detail!.collectedAt = "";
    expect(() => buildProductDocument(record)).toThrow("采集时间缺失");
  });

  it("从 SQLite 生成完整 TXT 和索引，复用相同原文并保留价格变化前的快照", async () => {
    const { database, output, record } = await databaseFixture();
    const first = await prepareProductInputs(database, output);
    expect(first).toMatchObject({ total: 3, ready: 1, waitingDetail: 2 });
    const saved = first.documents[0];
    const filename = join(output, saved.file);
    const original = await readFile(filename, "utf8");
    expect(original).toBe(buildProductDocument(record).text);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(first.manifestFile, "utf8"));
    expect(manifest.documents).toEqual(first.documents);

    const repeated = await prepareProductInputs(database, output);
    expect(repeated.documents).toEqual(first.documents);
    expect(repeated.manifestFile).not.toBe(first.manifestFile);
    const db = new DatabaseSync(database);
    try {
      expect(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n,
      ).toBe(1);
      record.listing.price = "223";
      db.prepare("UPDATE listings SET listing_json=? WHERE key=?").run(
        JSON.stringify(record.listing),
        record.listing.key,
      );
    } finally {
      db.close();
    }
    const updated = await prepareProductInputs(database, output);
    expect(updated.documents[0].contentHash).not.toBe(saved.contentHash);
    expect(await readFile(filename, "utf8")).toBe(original);
    expect(await readFile(join(output, updated.documents[0].file), "utf8")).toBe(
      buildProductDocument(record).text,
    );
  });

  it("已有原文被修改时报告错误，避免把错误资料关联到旧哈希", async () => {
    const { database, output } = await databaseFixture();
    const first = await prepareProductInputs(database, output);
    await writeFile(join(output, first.documents[0].file), "修改后的文本");
    await expect(prepareProductInputs(database, output)).rejects.toThrow("原文与哈希不一致");
  });

  it("商品记录身份与数据库主键不一致时停止导出", async () => {
    const { database, output } = await databaseFixture();
    const db = new DatabaseSync(database);
    try {
      db.prepare("UPDATE listings SET key='another-key' WHERE status='complete'").run();
    } finally {
      db.close();
    }
    await expect(prepareProductInputs(database, output)).rejects.toThrow("商品 ID 不一致");
  });
});
