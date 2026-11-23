export interface TrmRecord {
  id: number;
  value: string;
  unit: string;
  valid_from: string;
  valid_to: string;
  extended: boolean;
  source: string;
  source_id: string | null;
  obtained_at: string;
  validation_state: string;
  fingerprint: string;
}

export interface SyncRun {
  id: number;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  expected: number | null;
  received: number | null;
  inserted: number;
  revised: number;
  removed: number;
  error: string | null;
  audit: Record<string, unknown>;
}

export interface DataStatus {
  total: number;
  first: TrmRecord | null;
  last: TrmRecord | null;
  source: string;
  source_url: string;
  timezone: string;
  state: "empty" | "local" | "syncing" | "source_error";
  last_attempt: SyncRun | null;
  last_success: SyncRun | null;
  dataset_fingerprint: string;
  stored_versions: number;
  today?: string;
  checked_at?: string;
  auto_sync_enabled?: boolean;
  auto_sync_interval_hours?: number;
  next_auto_check_at?: string | null;
  manual_sync_available?: boolean;
  private_experiments?: boolean;
}

export interface Latest {
  record: TrmRecord | null;
  previous: TrmRecord | null;
  state: "current" | "stale" | "future" | "empty";
  today: string;
  delta: string | null;
  variation_pct: string | null;
}

export interface History {
  items: TrmRecord[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface Series {
  points: {
    date: string;
    valid_to: string;
    value: string;
    extended: boolean;
  }[];
  count: number;
  mean: string | null;
  minimum: string | null;
  maximum: string | null;
  convention: string;
}

export interface ProjectionSettings {
  method: "bootstrap" | "monte_carlo" | "arima";
  horizon: number;
  training_records: number;
  replicas: number;
  seed: number;
  target_date?: string | null;
  training_start?: string | null;
  training_end?: string | null;
  volatility_scale?: number;
  threshold?: string | null;
  interval_low?: string | null;
  interval_high?: string | null;
}

export interface Projection {
  id: string;
  request: ProjectionSettings;
  as_of: string;
  valid_from: string;
  valid_to: string;
  estimate: number;
  lower: number;
  upper: number;
  change: number;
  relative_change: number;
  experiment: Simulation;
  convention: string;
  model_version?: string;
  target_date?: string | null;
  projected_from?: string | null;
  projected_to?: string | null;
  points?: ProjectionPoint[];
  history?: Series["points"];
  calendar_version?: string | null;
  calendar_convention?: string;
  calendar_sources?: string[];
  published_references?: TrmRecord[];
  validation?: RollingEvaluation | null;
  validation_status?: string;
}

export interface ProjectionPoint {
  step: number;
  date: string;
  valid_from: string;
  valid_to: string;
  median: number;
  p5: number;
  p95: number;
  change: number;
  relative_change: number;
  requested: boolean;
}

export interface RollingEvaluation {
  id: string;
  request: {
    settings: ProjectionSettings;
    horizons: number[];
    folds: number;
    unit?: "calendar_days" | "transitions";
    last_cutoff?: string | null;
  };
  created_at: string;
  summaries: {
    horizon: number;
    count: number;
    model: Backtest["baseline"];
    baseline: Backtest["baseline"];
    mean_width: number;
  }[];
  cases: {
    cutoff: string;
    target: string;
    horizon: number;
    experiment_id: string;
    initial: number;
    actual: number;
    predicted: number;
    lower: number;
    upper: number;
    model?: "bootstrap" | "monte_carlo" | "arima" | null;
    absolute_error?: number | null;
    relative_error?: number | null;
    target_valid_from?: string | null;
    target_valid_to?: string | null;
    simulated_steps?: number | null;
    calendar_matches?: boolean | null;
  }[];
  skipped: number;
  convention: string;
  warnings: string[];
}

export interface EvaluationHistoryEntry {
  id: string;
  created_at: string;
  request: RollingEvaluation["request"];
  evaluated_folds: number;
  skipped: number;
}

export interface EvaluationHistoryPage {
  items: EvaluationHistoryEntry[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export type AnalysisVariable = "price" | "simple_return" | "log_return";

export interface Statistics {
  variable: AnalysisVariable;
  unit: "COP/USD" | "fraction";
  summary: {
    count: number;
    mean: number | null;
    median: number | null;
    minimum: number | null;
    maximum: number | null;
    range: number | null;
    population_variance: number | null;
    sample_variance: number | null;
    sample_std: number | null;
    q1: number | null;
    q3: number | null;
    iqr: number | null;
    coefficient_variation_pct: number | null;
    percentiles: Record<string, number>;
  };
  histogram: {
    lower: number;
    upper: number;
    right_closed: boolean;
    frequency: number;
    relative_frequency: number;
    cumulative_frequency: number;
    cumulative_probability: number;
  }[];
  histogram_method: string;
  ecdf: { value: number; probability: number; cumulative_count: number }[];
  boxplot: {
    lower_fence: number;
    upper_fence: number;
    whisker_low: number;
    whisker_high: number;
    outliers: number[];
    outlier_count: number;
  } | null;
  points: { date: string; value: number | null }[];
  returns: {
    from_date: string;
    date: string;
    elapsed_calendar_days: number;
    simple_return: number | null;
    log_return: number | null;
    absolute_change: number | null;
    excluded_gap: boolean;
  }[];
  volatility: {
    log_return_count: number;
    historical: number | null;
    annualized: null;
    rolling_window: number;
    points: { date: string; value: number | null }[];
    convention: string;
  };
  record_count: number;
  extended_records: number;
  excluded_gap_pairs: number;
  excluded_future_records: number;
  first_date: string | null;
  last_date: string | null;
  dataset_fingerprint: string;
  source: string;
  calculated_at: string;
  cutoff_date: string;
  model_version: string;
  numpy_version: string;
  filters: {
    year: number | null;
    month: number | null;
    start: string | null;
    end: string | null;
  };
  convention: string;
  interpretation: string;
  warnings: string[];
}

export type SimulationMethod = "monte_carlo" | "bootstrap" | "arima";

export interface SimulationRequest {
  training_start: string;
  training_end: string;
  cutoff_date: string;
  method: SimulationMethod | "both";
  horizon: number;
  replicas: number;
  seed: number;
  initial_price: string | null;
  initial_return?: number | null;
  volatility_scale?: number;
  threshold: string | null;
  interval_low: string | null;
  interval_high: string | null;
  display_paths: number;
}
export interface SimulationMethodResult {
  method: SimulationMethod;
  paths: number[][];
  displayed_paths: number;
  total_paths: number;
  bands: {
    step: number;
    mean: number;
    median: number;
    p5: number;
    p25: number;
    p75: number;
    p95: number;
  }[];
  terminal_values: number[];
  terminal_summary: Statistics["summary"];
  histogram: Statistics["histogram"];
  probabilities: {
    event:
      | "above_initial"
      | "below_initial"
      | "equal_initial"
      | "above_threshold"
      | "below_threshold"
      | "within_interval";
    count: number | null;
    probability: number | null;
  }[];
  interpretation: string;
  assumptions: string;
  fitted_parameters?: Record<string, number>;
}
export interface Simulation {
  id: string;
  replay_of: string | null;
  request: SimulationRequest;
  initial_price: number;
  initial_price_origin: "last_training_record" | "configured";
  threshold: number;
  training: {
    record_count: number;
    return_count: number;
    gap_count: number;
    extended_records: number;
    first_date: string;
    last_date: string;
    initial_record_date: string;
    mu: number;
    sigma: number;
    history: Series["points"];
    dataset_fingerprint: string;
  };
  methods: SimulationMethodResult[];
  created_at: string;
  model_version: string;
  numpy_version: string;
  python_version: string;
  machine: string;
  bit_generator: string;
  source: string;
  numeric_fingerprint: string;
  convention: string;
  warnings: string[];
}

export interface DiagnosticTest {
  name: string;
  hypothesis: string;
  statistic: number | null;
  p_value: number | null;
  alpha: number;
  decision: "reject" | "do_not_reject" | "not_applicable";
  detail: string;
}
export interface EvaluationMetrics {
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  coverage: number | null;
  terminal_absolute_error: number | null;
  terminal_relative_error: number | null;
}
export interface Backtest {
  id: string;
  experiment_id: string;
  request: {
    training_start: string;
    cutoff_date: string;
    method: SimulationMethod | "both";
    horizon: number;
    replicas: number;
    seed: number;
    alpha: number;
  };
  status: "complete" | "insufficient";
  evaluated_steps: number;
  stopped_at_gap: boolean;
  initial_price: number;
  observations: { date: string; value: number }[];
  baseline: EvaluationMetrics;
  methods: {
    method: SimulationMethod;
    metrics: EvaluationMetrics;
    points: {
      step: number;
      date: string;
      actual: number;
      predicted_mean: number;
      predicted_median: number;
      p5: number;
      p95: number;
      error: number;
      absolute_error: number;
      relative_error: number;
      covered: boolean;
    }[];
  }[];
  model_diagnostics: {
    return_count: number;
    normality: DiagnosticTest;
    lag_one_correlation: number | null;
    correlation_pairs: number;
    outlier_count: number;
    convention: string;
  };
  training_fingerprint: string;
  evaluation_fingerprint: string;
  created_at: string;
  model_version: string;
  scipy_version: string;
  source: string;
  interpretation: string;
  convention: string;
  warnings: string[];
}
