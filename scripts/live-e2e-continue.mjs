import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

if (!process.argv[2]) throw new Error("请指定正在等待的真实 E2E 运行目录");
const directory = path.resolve(process.argv[2]);
const attention = JSON.parse(await readFile(path.join(directory, "attention.json"), "utf8"));
if (attention.state !== "waiting") throw new Error("该测试当前没有等待确认");
await writeFile(
  path.join(directory, "continue.json"),
  JSON.stringify({ id: attention.id, confirmedAt: new Date().toISOString() }),
  { mode: 0o600 },
);
console.log("已确认当前等待点；测试会重新检查真实状态。");
