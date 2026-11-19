import type { ProjectionSettings } from "./types";

export const defaultProjection: ProjectionSettings = {
  method: "bootstrap",
  horizon: 30,
  training_records: 252,
  replicas: 2000,
  seed: 2026,
  volatility_scale: 1,
};
export const methodNames = {
  bootstrap: "Bootstrap",
  monte_carlo: "Montecarlo",
  arima: "ARIMA(1,1,0)",
};

export function afterDays(day: string, days: number): string {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
