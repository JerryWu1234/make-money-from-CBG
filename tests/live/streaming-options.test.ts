import { describe, expect, it } from "vite-plus/test";
import type { AnalysisOverview } from "../../server/analysis/types";
import {
  allAnalysisRecords,
  hasSearchParameterCapture,
  streamingRoleCount,
} from "./streaming-options";

describe("真实角色批次数量与分页", () => {
  it("默认保留十角色，可显式选择五十角色，拒绝无效规模", () => {
    expect(streamingRoleCount()).toBe(10);
    expect(streamingRoleCount("50")).toBe(50);
    for (const value of ["", "0", "1", "2.5", "51", "NaN", "Infinity"])
      expect(() => streamingRoleCount(value)).toThrow("2 到 50");
  });

  it("读取全部三页五十角色，末页失败不会伪装成完整结果", async () => {
    const pages: number[] = [];
    const read = async (page: number) => {
      pages.push(page);
      return {
        records: {
          page,
          total: 50,
          totalPages: 3,
          items: Array.from({ length: page === 3 ? 10 : 20 }, (_, index) => ({
            key: String((page - 1) * 20 + index),
          })),
        },
      } as AnalysisOverview;
    };
    const overview = await allAnalysisRecords(read);
    expect(pages).toEqual([1, 2, 3]);
    expect(overview.records.items).toHaveLength(50);
    expect(overview.records.items.at(-1)?.key).toBe("49");
    await expect(
      allAnalysisRecords(async (page) => {
        if (page === 3) throw new Error("last page failed");
        return read(page);
      }),
    ).rejects.toThrow("last page failed");
  });

  it("已完成批次续跑接受原批次有参数的旧截图，且仍核验图片", async () => {
    const file = (name: string) => ({ name, sha256: "test" });
    const oldIndex = file("work-page-evidence/session-old/index.json");
    const newIndex = file("work-page-evidence/session-new/index.json");
    const source = file("work-page-evidence/session-old/00001.json");
    const image = file("work-page-evidence/session-old/00001.png");
    const entries = [{ captureMode: "full-page", files: [source, image] }];
    const reads: string[] = [];
    const read = async ({ name }: { name: string }) => {
      reads.push(name);
      if (name === oldIndex.name) return Buffer.from(JSON.stringify({ entries }));
      if (name === newIndex.name) return Buffer.from(JSON.stringify({ entries: [] }));
      if (name === source.name)
        return Buffer.from(
          JSON.stringify({
            observation: { controls: [{ id: "level", value: "80" }], submittedArgs: { level: 80 } },
          }),
        );
      if (name === image.name) return Buffer.from("test-image");
      throw new Error("unexpected evidence");
    };
    expect(await hasSearchParameterCapture([newIndex, oldIndex], read)).toBe(true);
    expect(reads).toContain(image.name);
    await expect(
      hasSearchParameterCapture([oldIndex], async (entry) => {
        if (entry.name === image.name) throw new Error("hash mismatch");
        return read(entry);
      }),
    ).rejects.toThrow("hash mismatch");
    expect(await hasSearchParameterCapture([newIndex], read)).toBe(false);
  });
});
