import type { Filters } from "./types";

export function quickPeriod(months: number | null, end: string): Filters {
  if (months === null) return { year: "", month: "", start: "", end: "" };
  const [year, month, day] = end.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last) + 1);
  return { year: "", month: "", start: target.toISOString().slice(0, 10), end };
}

export function selectedBounds(filters: Filters, first: string, last: string) {
  const starts = [first],
    ends = [last];
  if (filters.year) {
    const year = Number(filters.year),
      month = Number(filters.month);
    starts.push(`${year}-${String(month || 1).padStart(2, "0")}-01`);
    ends.push(
      new Date(Date.UTC(year, month || 12, 0)).toISOString().slice(0, 10),
    );
  }
  if (filters.start) starts.push(filters.start);
  if (filters.end) ends.push(filters.end);
  return { start: starts.sort().at(-1)!, end: ends.sort()[0] };
}
