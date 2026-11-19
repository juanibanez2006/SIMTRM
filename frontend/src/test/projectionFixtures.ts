import type {
  DataStatus,
  Latest,
  Projection,
  RollingEvaluation,
  Simulation,
} from "../types";
import original from "./simulation-synthetic.json";

// Synthetic data confined to tests. Every displayed estimate comes from this matrix fixture.
export const simulation = structuredClone(original) as Simulation;
simulation.methods = [
  simulation.methods.find((m) => m.method === "bootstrap")!,
];
const bands = simulation.methods[0].bands;
export const latest: Latest = {
  today: "2026-11-12",
  state: "current",
  previous: null,
  delta: null,
  variation_pct: null,
  record: {
    id: 1,
    value: "120",
    unit: "COP",
    valid_from: "2026-11-12",
    valid_to: "2026-11-12",
    extended: false,
    source: "synthetic-test",
    source_id: "test",
    obtained_at: "2026-11-12T12:00:00-05:00",
    validation_state: "validated",
    fingerprint: "test",
  },
};
export const status: DataStatus = {
  total: 160,
  first: latest.record,
  last: latest.record,
  source: "synthetic-test",
  source_url: "https://example.test",
  timezone: "America/Bogota",
  state: "local",
  last_attempt: null,
  last_success: null,
  dataset_fingerprint: "test",
  stored_versions: 160,
};
export const projection: Projection = {
  id: simulation.id,
  request: {
    method: "bootstrap",
    horizon: 3,
    training_records: 252,
    replicas: 2000,
    seed: 2026,
    target_date: "2026-11-18",
  },
  as_of: "2026-11-12",
  valid_from: "2026-11-12",
  valid_to: "2026-11-12",
  target_date: "2026-11-18",
  projected_from: "2026-11-18",
  projected_to: "2026-11-18",
  estimate: bands[3].median,
  lower: bands[3].p5,
  upper: bands[3].p95,
  change: bands[3].median - simulation.initial_price,
  relative_change: bands[3].median / simulation.initial_price - 1,
  experiment: simulation,
  convention: "Convención sintética de prueba",
  calendar_version: "test-1",
  calendar_sources: [],
  validation_status:
    "Sin observaciones suficientes para validar la muestra sintética",
  history: [
    {
      date: "2026-11-11",
      valid_to: "2026-11-11",
      value: "121",
      extended: false,
    },
    {
      date: "2026-11-12",
      valid_to: "2026-11-12",
      value: "120",
      extended: false,
    },
  ],
  points: bands.map((band, step) => ({
    step,
    date: ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-18"][step],
    valid_from: ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-18"][step],
    valid_to: ["2026-11-12", "2026-11-13", "2026-11-17", "2026-11-18"][step],
    median: band.median,
    p5: band.p5,
    p95: band.p95,
    change: band.median - simulation.initial_price,
    relative_change: band.median / simulation.initial_price - 1,
    requested: step === 3,
  })),
};
export const rolling: RollingEvaluation = {
  id: "00000000-0000-4000-8000-000000000003",
  request: {
    settings: projection.request,
    horizons: [7],
    folds: 2,
    unit: "calendar_days",
  },
  created_at: "2026-11-12T12:00:00-05:00",
  skipped: 0,
  convention: "Synthetic rolling test",
  warnings: ["Muestra sintética de prueba"],
  summaries: [
    {
      horizon: 7,
      count: 2,
      mean_width: 30,
      model: {
        mae: 4,
        rmse: 5,
        mape: 0.04,
        coverage: 0.5,
        terminal_absolute_error: null,
        terminal_relative_error: null,
      },
      baseline: {
        mae: 5,
        rmse: 6,
        mape: 0.05,
        coverage: null,
        terminal_absolute_error: null,
        terminal_relative_error: null,
      },
    },
  ],
  cases: [
    {
      cutoff: "2026-10-01",
      target: "2026-10-08",
      horizon: 7,
      experiment_id: "test-case",
      initial: 100,
      actual: 110,
      predicted: 105,
      lower: 95,
      upper: 115,
      absolute_error: 5,
      relative_error: 5 / 110,
      model: "bootstrap",
      target_valid_from: "2026-10-08",
      target_valid_to: "2026-10-08",
      simulated_steps: 5,
      calendar_matches: true,
    },
  ],
};
