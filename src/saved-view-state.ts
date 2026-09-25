function replaceUrl(params: URLSearchParams) {
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function savedRecordsPage() {
  const value = new URLSearchParams(window.location.search).get("recordsPage");
  const page = value == null ? NaN : Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function savedRecordKey() {
  return new URLSearchParams(window.location.search).get("record") || null;
}

export function replaceSavedRecordsPage(page: number) {
  const params = new URLSearchParams(window.location.search);
  if (page > 1) params.set("recordsPage", String(page));
  else params.delete("recordsPage");
  replaceUrl(params);
}

export function replaceSavedRecordKey(key: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (key) params.set("record", key);
  else params.delete("record");
  replaceUrl(params);
}
