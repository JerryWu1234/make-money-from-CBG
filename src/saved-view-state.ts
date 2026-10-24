function replaceUrl(params: URLSearchParams) {
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function savedRecordsPage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("recordsScope") === "tasks") return 1;
  const value = params.get("recordsPage");
  const page = value == null ? NaN : Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function savedRecordKey() {
  const params = new URLSearchParams(window.location.search);
  return params.get("recordsScope") === "tasks" ? null : params.get("record") || null;
}

export function replaceSavedRecordsPage(page: number) {
  const params = new URLSearchParams(window.location.search);
  if (page > 1) params.set("recordsPage", String(page));
  else params.delete("recordsPage");
  replaceUrl(params);
}

export function normalizeSavedRecordsView() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("recordsScope")) return;
  if (params.get("recordsScope") === "tasks") {
    params.delete("recordsPage");
    params.delete("record");
  }
  params.delete("recordsScope");
  replaceUrl(params);
}

export function replaceSavedRecordKey(key: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (key) params.set("record", key);
  else params.delete("record");
  replaceUrl(params);
}
