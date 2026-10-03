import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildProductDocument } from "./product-document";
import type { ProductDocument } from "./product-document";
import type { SavedRoleRecord } from "../crawler/types";

/** Read one database snapshot and archive the exact per-product text for later SDK calls. */
export async function prepareProductInputs(
  database = resolve("data/cbg.sqlite"),
  directory = resolve("data/analysis-inputs"),
) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("BEGIN");
    const counts = db.prepare("SELECT count(*) AS total FROM listings").get()!;
    const documents: (Omit<ProductDocument, "text"> & { file: string })[] = [];
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const row of db
      .prepare(
        "SELECT key,listing_json,detail_json FROM listings WHERE status='complete' AND detail_json IS NOT NULL ORDER BY key ASC",
      )
      .iterate()) {
      const record: SavedRoleRecord = {
        listing: JSON.parse(String(row.listing_json)),
        detail: JSON.parse(String(row.detail_json)),
        status: "complete",
        error: null,
      };
      if (record.listing.key !== row.key)
        throw new Error("数据库中的商品 ID 不一致，已停止生成分析资料");
      const { text, ...metadata } = buildProductDocument(record);
      const file = `${metadata.contentHash}.txt`;
      const filename = join(directory, file);
      try {
        await writeFile(filename, text, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readFile(filename, "utf8")) !== text)
          throw new Error("已有商品资料原文与哈希不一致，请检查分析资料目录");
      }
      documents.push({ ...metadata, file });
    }
    db.exec("COMMIT");
    const manifest = {
      formatVersion: 1,
      preparedAt: new Date().toISOString(),
      database: resolve(database),
      total: Number(counts.total),
      ready: documents.length,
      waitingDetail: Number(counts.total) - documents.length,
      documents,
    };
    const manifestFile = join(directory, `manifest-${randomUUID()}.json`);
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return { ...manifest, manifestFile };
  } finally {
    db.close();
  }
}
