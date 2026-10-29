export async function indexedDbNames(factory: IDBFactory | undefined): Promise<string[]> {
  if (!factory || typeof factory.databases !== "function")
    throw new Error("当前浏览器不支持读取 IndexedDB 数据库列表，无法清除。");
  const databases = await factory.databases();
  return databases
    .map(({ name }) => name)
    .filter((name): name is string => typeof name === "string");
}

export function deleteIndexedDb(
  factory: IDBFactory,
  name: string,
  onBlocked: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("数据库删除失败"));
    // A blocked delete is still pending and cannot be cancelled.
    request.onblocked = onBlocked;
  });
}
