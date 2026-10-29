import { expect, it, vi } from "vite-plus/test";
import { deleteIndexedDb, indexedDbNames } from "./indexeddb-cleanup";

// Failure cases: unsupported/enumeration failures look like success, empty names are
// skipped, delete errors are hidden, or blocked requests resolve before deletion.
it("枚举保留合法的空名称，浏览器不支持或枚举失败时拒绝", async () => {
  const factory = {
    databases: vi.fn().mockResolvedValue([{ name: "" }, { name: "records" }, { version: 1 }]),
  } as unknown as IDBFactory;
  await expect(indexedDbNames(factory)).resolves.toEqual(["", "records"]);
  await expect(indexedDbNames(undefined)).rejects.toThrow("不支持");
  (factory.databases as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("读取被拒绝"));
  await expect(indexedDbNames(factory)).rejects.toThrow("读取被拒绝");
});

it("blocked 保持等待，直到原删除请求成功才完成", async () => {
  const request = {} as IDBOpenDBRequest;
  const deleteDatabase = vi.fn(() => request);
  const factory = { deleteDatabase } as unknown as IDBFactory;
  const blocked = vi.fn();
  const finished = vi.fn();
  const clearing = deleteIndexedDb(factory, "records", blocked).then(finished);
  request.onblocked!.call(request, new Event("blocked") as IDBVersionChangeEvent);
  await Promise.resolve();
  expect(blocked).toHaveBeenCalledOnce();
  expect(finished).not.toHaveBeenCalled();
  request.onsuccess!.call(request, new Event("success"));
  await clearing;
  expect(deleteDatabase).toHaveBeenCalledWith("records");
  expect(finished).toHaveBeenCalledOnce();
});

it("原生删除错误和同步异常都拒绝，不能报告成功", async () => {
  const request = { error: new Error("删除被拒绝") } as unknown as IDBOpenDBRequest;
  const factory = { deleteDatabase: vi.fn(() => request) } as unknown as IDBFactory;
  const clearing = deleteIndexedDb(factory, "records", vi.fn());
  const failed = expect(clearing).rejects.toThrow("删除被拒绝");
  request.onerror!.call(request, new Event("error"));
  await failed;
  (factory.deleteDatabase as ReturnType<typeof vi.fn>).mockImplementation(() => {
    throw new Error("操作受限");
  });
  await expect(deleteIndexedDb(factory, "records", vi.fn())).rejects.toThrow("操作受限");
});
