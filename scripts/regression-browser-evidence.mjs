// Offline DOM regressions exercise browser actions; runtime screenshot evidence has separate tests.
export const browserEvidenceUrl = `data:text/javascript;base64,${Buffer.from(
  "export async function captureBrowserStep(){} export function registerBrowserEvidence(){}",
).toString("base64")}`;
