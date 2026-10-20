import type { AnalysisOverview } from "../../server/analysis/types";

export function streamingRoleCount(value?: string): number {
  const count = value === undefined ? 10 : Number(value);
  if (!Number.isInteger(count) || count < 2 || count > 100)
    throw new Error("CBG_LIVE_ROLE_COUNT 必须是 2 到 100 的整数");
  return count;
}

/** The status endpoint returns 20 records per page, including during a 100-role run. */
export async function allAnalysisRecords(
  read: (page: number) => Promise<AnalysisOverview>,
): Promise<AnalysisOverview> {
  const first = await read(1);
  const items = new Map(first.records.items.map((item) => [item.key, item]));
  for (let page = 2; page <= first.records.totalPages; page++) {
    const next = await read(page);
    for (const item of next.records.items) items.set(item.key, item);
  }
  return { ...first, records: { ...first.records, items: [...items.values()] } };
}

type EvidenceFile = { name: string; sha256: string };

/** Accept a verified earlier session of the same run when a completed run is resumed. */
export async function hasSearchParameterCapture(
  files: EvidenceFile[],
  readVerified: (file: EvidenceFile) => Promise<Buffer>,
): Promise<boolean> {
  for (const indexed of files) {
    if (!indexed.name.startsWith("work-page-evidence/") || !indexed.name.endsWith("/index.json"))
      continue;
    const index = JSON.parse((await readVerified(indexed)).toString("utf8"));
    for (const entry of index.entries) {
      if (entry.captureMode !== "full-page") continue;
      const source = entry.files.find((file: EvidenceFile) => file.name.endsWith(".json"));
      const image = entry.files.find((file: EvidenceFile) => file.name.endsWith(".png"));
      if (!source || !image) continue;
      const { observation } = JSON.parse((await readVerified(source)).toString("utf8"));
      if (observation.controls?.length && Object.keys(observation.submittedArgs || {}).length) {
        await readVerified(image);
        return true;
      }
    }
  }
  return false;
}
