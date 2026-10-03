import { pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import { readFile } from "node:fs/promises";

// Use the same TypeScript implementation as the server without another runtime dependency.
async function moduleUrl(filename, replacements = {}) {
  const source = await readFile(new URL(filename, import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [name, url] of Object.entries(replacements))
    compiled = compiled.replaceAll(`from "${name}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}

export async function prepare(database, directory) {
  const documentUrl = await moduleUrl("../server/analysis/product-document.ts");
  const { prepareProductInputs } = await import(
    await moduleUrl("../server/analysis/prepare-inputs.ts", { "./product-document": documentUrl })
  );
  return prepareProductInputs(database, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepare(process.argv[2], process.argv[3]);
    console.log(
      `已生成 ${result.ready} 份商品完整文本，${result.waitingDetail} 件详情未完成。\n资料索引：${result.manifestFile}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "生成商品分析资料失败");
    process.exitCode = 1;
  }
}
