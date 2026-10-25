const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();

/** The provider's weekly table can fill a missing heat rank, never a price or row-order rank. */
export function parseTravelHeatRanks(html: string, fetchedAt: string) {
  const headings = [...html.matchAll(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi)]
    .map((match) =>
      text(match[1]).match(/^梦幻西游-(\d{4})年(\d{1,2})月(\d{1,2})日-三年外服务器-烟花列表$/),
    )
    .filter((match) => match !== null);
  if (headings.length !== 1) return null;
  const [, year, month, day] = headings[0];
  const date = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const parsed = new Date(date);
  const fetched = Date.parse(fetchedAt);
  if (
    !Number.isFinite(fetched) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day)
  )
    return null;
  const local = new Date(fetched + 8 * 3600000);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  if (date > today || today - date > 7 * 86400000) return null;
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((match) =>
    [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => text(cell[1])),
    ),
  );
  const candidates = tables.flatMap((rows) =>
    rows.flatMap((header, index) => {
      const normalized = header.map((cell) =>
        cell.replace(/\s/g, "").replace(/（/g, "(").replace(/）/g, ")"),
      );
      const server = normalized.flatMap((cell, i) => (cell === "服务器" ? [i] : []));
      const heat = normalized.flatMap((cell, i) => (cell === "热度值(排名)" ? [i] : []));
      return server.length === 1 && heat.length === 1
        ? [{ rows, header, index, server: server[0], heat: heat[0] }]
        : [];
    }),
  );
  if (candidates.length !== 1) return null;
  const table = candidates[0],
    ranks = new Map<string, number>();
  for (const row of table.rows.slice(table.index + 1)) {
    if (row.length !== table.header.length) continue;
    const name = row[table.server],
      value = row[table.heat];
    const match = value.match(/^\d+(?:\.\d+)?\s*[（(]([1-9]\d*)[）)]$/);
    if (!name || !match || !Number.isFinite(parseFloat(value))) continue;
    const rank = Number(match[1]);
    if (!Number.isSafeInteger(rank) || ranks.has(name)) return null;
    ranks.set(name, rank);
  }
  return { date: parsed.toISOString().slice(0, 10), ranks };
}
