export interface PeriodSelection {
  mode: "year" | "month" | "range";
  year: string;
  month: string;
  start: string;
  end: string;
}

export function initialPeriod(year?: number): PeriodSelection {
  return {
    mode: year ? "year" : "range",
    year: year ? String(year) : "",
    month: "1",
    start: year ? `${year}-01-01` : "",
    end: year ? `${year}-12-31` : "",
  };
}

export function periodBounds(selection: PeriodSelection): {
  start: string;
  end: string;
} {
  if (selection.mode === "range")
    return { start: selection.start, end: selection.end };
  if (!selection.year) return { start: "", end: "" };
  if (selection.mode === "year")
    return { start: `${selection.year}-01-01`, end: `${selection.year}-12-31` };
  const year = Number(selection.year),
    month = Number(selection.month);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${selection.year}-${String(month).padStart(2, "0")}`;
  return { start: `${prefix}-01`, end: `${prefix}-${last}` };
}
