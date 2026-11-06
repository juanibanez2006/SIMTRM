from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StrictInt, model_validator


class HistoryFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    year: int | None = Field(default=None, ge=1900, le=9999)
    month: int | None = Field(default=None, ge=1, le=12)
    start: date | None = None
    end: date | None = None

    @model_validator(mode="after")
    def valid_range(self):
        if self.start and self.end and self.start > self.end:
            raise ValueError("La fecha inicial debe ser anterior o igual a la final")
        if self.month and not self.year:
            raise ValueError("Seleccione un año para filtrar por mes")
        return self


class HistoryQuery(HistoryFilter):
    page: int = Field(default=1, ge=1, le=1000000)
    page_size: int = Field(default=20, ge=1, le=200)
    sort: Literal["date", "value"] = "date"
    direction: Literal["asc", "desc"] = "desc"


class RecordOut(BaseModel):
    id: int
    value: str
    unit: str
    valid_from: date
    valid_to: date
    source: str
    source_id: str | None
    obtained_at: str
    validation_state: str
    fingerprint: str
    extended: bool


class HistoryOut(BaseModel):
    items: list[RecordOut]
    total: int
    page: int
    page_size: int
    pages: int


class SeriesPoint(BaseModel):
    date: date
    valid_to: date
    value: str
    extended: bool


class SeriesOut(BaseModel):
    points: list[SeriesPoint]
    count: int
    mean: str | None
    minimum: str | None
    maximum: str | None
    convention: str


class LatestOut(BaseModel):
    record: RecordOut | None
    previous: RecordOut | None
    state: Literal["current", "stale", "future", "empty"]
    today: date
    delta: str | None
    variation_pct: str | None


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["full", "incremental"] = "full"


class SyncRun(BaseModel):
    id: int
    mode: str
    status: str
    started_at: str
    finished_at: str | None
    expected: int | None
    received: int | None
    inserted: int
    revised: int
    removed: int
    error: str | None
    audit: dict


class DataStatus(BaseModel):
    total: int
    first: RecordOut | None
    last: RecordOut | None
    source: str
    source_url: str
    timezone: str
    last_attempt: SyncRun | None
    last_success: SyncRun | None
    state: Literal["empty", "local", "syncing", "source_error"]
    dataset_fingerprint: str
    stored_versions: int
    today: date | None = None
    checked_at: str | None = None
    auto_sync_enabled: bool = False
    auto_sync_interval_hours: float = 6
    next_auto_check_at: str | None = None


class StatisticsQuery(HistoryFilter):
    variable: Literal["price", "simple_return", "log_return"] = "price"
    bins: int | None = Field(default=None, ge=1, le=80)
    rolling_window: int = Field(default=20, ge=2, le=252)


class DescriptiveSummary(BaseModel):
    count: int
    mean: FiniteFloat | None
    median: FiniteFloat | None
    minimum: FiniteFloat | None
    maximum: FiniteFloat | None
    range: FiniteFloat | None
    population_variance: FiniteFloat | None
    sample_variance: FiniteFloat | None
    sample_std: FiniteFloat | None
    q1: FiniteFloat | None
    q3: FiniteFloat | None
    iqr: FiniteFloat | None
    coefficient_variation_pct: FiniteFloat | None
    percentiles: dict[str, FiniteFloat]


class FrequencyBin(BaseModel):
    lower: FiniteFloat
    upper: FiniteFloat
    right_closed: bool
    frequency: int
    relative_frequency: FiniteFloat
    cumulative_frequency: int
    cumulative_probability: FiniteFloat


class EcdfPoint(BaseModel):
    value: FiniteFloat
    probability: FiniteFloat
    cumulative_count: int


class BoxSummary(BaseModel):
    lower_fence: FiniteFloat
    upper_fence: FiniteFloat
    whisker_low: FiniteFloat
    whisker_high: FiniteFloat
    outliers: list[FiniteFloat]
    outlier_count: int


class AnalysisPoint(BaseModel):
    date: date
    value: FiniteFloat | None


class ReturnPoint(BaseModel):
    from_date: date
    date: date
    elapsed_calendar_days: int
    simple_return: FiniteFloat | None
    log_return: FiniteFloat | None
    absolute_change: FiniteFloat | None
    excluded_gap: bool


class VolatilityOut(BaseModel):
    log_return_count: int
    historical: FiniteFloat | None
    annualized: None = None
    rolling_window: int
    points: list[AnalysisPoint]
    convention: str


class StatisticsOut(BaseModel):
    variable: Literal["price", "simple_return", "log_return"]
    unit: Literal["COP/USD", "fraction"]
    summary: DescriptiveSummary
    histogram: list[FrequencyBin]
    histogram_method: str
    ecdf: list[EcdfPoint]
    boxplot: BoxSummary | None
    points: list[AnalysisPoint]
    returns: list[ReturnPoint]
    volatility: VolatilityOut
    record_count: int
    extended_records: int
    excluded_gap_pairs: int
    excluded_future_records: int
    first_date: date | None
    last_date: date | None
    dataset_fingerprint: str
    source: str
    calculated_at: str
    cutoff_date: date
    model_version: str
    numpy_version: str
    filters: HistoryFilter
    convention: str
    interpretation: str
    warnings: list[str]


class ComparisonQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a_start: date
    a_end: date
    b_start: date
    b_end: date
    alignment: Literal["observation", "elapsed_days"] = "observation"

    @model_validator(mode="after")
    def valid_ranges(self):
        if self.a_start > self.a_end:
            raise ValueError("El periodo A tiene las fechas invertidas")
        if self.b_start > self.b_end:
            raise ValueError("El periodo B tiene las fechas invertidas")
        return self


class ComparisonPoint(BaseModel):
    position: int
    date: date
    valid_to: date
    effective_date: date
    effective_until: date
    value: str
    normalized: FiniteFloat
    gap_before: bool


class ComparisonMetrics(BaseModel):
    count: int
    mean: FiniteFloat | None
    median: FiniteFloat | None
    minimum: FiniteFloat | None
    maximum: FiniteFloat | None
    sample_std: FiniteFloat | None
    initial_value: FiniteFloat | None
    final_value: FiniteFloat | None
    absolute_change: FiniteFloat | None
    relative_change: FiniteFloat | None
    cumulative_return: FiniteFloat | None
    volatility: FiniteFloat | None


class ComparisonPeriod(BaseModel):
    requested_start: date
    requested_end: date
    observed_start: date | None
    observed_end: date | None
    return_count: int
    gap_count: int
    excluded_future_records: int
    metrics: ComparisonMetrics
    points: list[ComparisonPoint]
    dataset_fingerprint: str
    warnings: list[str]


class ComparisonDifference(BaseModel):
    metric: str
    unit: Literal["COP/USD", "fraction", "count"]
    a: FiniteFloat | None
    b: FiniteFloat | None
    delta: FiniteFloat | None
    relative_delta: FiniteFloat | None


class ComparisonRow(BaseModel):
    position: int
    a: ComparisonPoint | None
    b: ComparisonPoint | None


class ComparisonOut(BaseModel):
    alignment: Literal["observation", "elapsed_days"]
    a: ComparisonPeriod
    b: ComparisonPeriod
    differences: list[ComparisonDifference]
    rows: list[ComparisonRow]
    paired_positions: int
    source: str
    cutoff_date: date
    calculated_at: str
    model_version: str
    dataset_fingerprint: str
    convention: str
    interpretation: str
    warnings: list[str]


SimulationMoney = Annotated[Decimal, Field(gt=0, le=Decimal("1000000000"), decimal_places=2)]


class SimulationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    training_start: date
    training_end: date
    cutoff_date: date
    method: Literal["monte_carlo", "bootstrap", "both"] = "both"
    horizon: StrictInt = Field(default=30, ge=1, le=365)
    replicas: StrictInt = Field(default=1000, ge=1, le=50000)
    seed: StrictInt = Field(default=2026, ge=0, le=4294967295)
    initial_price: SimulationMoney | None = None
    threshold: SimulationMoney | None = None
    interval_low: SimulationMoney | None = None
    interval_high: SimulationMoney | None = None
    display_paths: StrictInt = Field(default=20, ge=1, le=50)

    @model_validator(mode="after")
    def valid_experiment(self):
        if self.training_start > self.training_end:
            raise ValueError("El intervalo de entrenamiento tiene fechas invertidas")
        if self.training_end > self.cutoff_date:
            raise ValueError("El entrenamiento no puede terminar después del corte")
        if (self.interval_low is None) != (self.interval_high is None):
            raise ValueError("Indique ambos límites del intervalo de interés")
        if self.interval_low is not None and self.interval_low > self.interval_high:
            raise ValueError("El intervalo de interés tiene límites invertidos")
        methods = 2 if self.method == "both" else 1
        if self.replicas * (self.horizon + 1) * methods > 2000000:
            raise ValueError(
                "El experimento supera 2.000.000 de celdas; reduzca réplicas u horizonte"
            )
        return self


class SimulationBand(BaseModel):
    step: int
    mean: FiniteFloat
    median: FiniteFloat
    p5: FiniteFloat
    p25: FiniteFloat
    p75: FiniteFloat
    p95: FiniteFloat


class EventProbability(BaseModel):
    event: Literal[
        "above_initial",
        "below_initial",
        "equal_initial",
        "above_threshold",
        "below_threshold",
        "within_interval",
    ]
    count: int | None
    probability: FiniteFloat | None


class SimulationMethodOut(BaseModel):
    method: Literal["monte_carlo", "bootstrap"]
    paths: list[list[FiniteFloat]]
    displayed_paths: int
    total_paths: int
    bands: list[SimulationBand]
    terminal_values: list[FiniteFloat]
    terminal_summary: DescriptiveSummary
    histogram: list[FrequencyBin]
    probabilities: list[EventProbability]
    interpretation: str
    assumptions: str


class SimulationTraining(BaseModel):
    record_count: int
    return_count: int
    gap_count: int
    extended_records: int
    first_date: date
    last_date: date
    initial_record_date: date
    mu: FiniteFloat
    sigma: FiniteFloat
    history: list[SeriesPoint]
    dataset_fingerprint: str


class SimulationOut(BaseModel):
    id: str
    replay_of: str | None
    request: SimulationRequest
    initial_price: FiniteFloat
    initial_price_origin: Literal["last_training_record", "configured"]
    threshold: FiniteFloat
    training: SimulationTraining
    methods: list[SimulationMethodOut]
    created_at: str
    model_version: str
    numpy_version: str
    python_version: str
    machine: str
    bit_generator: str
    source: str
    numeric_fingerprint: str
    convention: str
    warnings: list[str]


class BacktestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    training_start: date
    cutoff_date: date
    method: Literal["monte_carlo", "bootstrap", "both"] = "both"
    horizon: StrictInt = Field(default=30, ge=1, le=365)
    replicas: StrictInt = Field(default=1000, ge=1, le=50000)
    seed: StrictInt = Field(default=2026, ge=0, le=4294967295)
    uniform_count: StrictInt = Field(default=1000, ge=250, le=10000)
    alpha: Literal[0.01, 0.05, 0.1] = 0.05

    def simulation_request(self) -> SimulationRequest:
        return SimulationRequest(
            training_start=self.training_start,
            training_end=self.cutoff_date,
            cutoff_date=self.cutoff_date,
            method=self.method,
            horizon=self.horizon,
            replicas=self.replicas,
            seed=self.seed,
        )

    @model_validator(mode="after")
    def validate_simulation(self):
        self.simulation_request()
        return self


class DiagnosticTest(BaseModel):
    name: str
    hypothesis: str
    statistic: FiniteFloat | None
    p_value: FiniteFloat | None
    alpha: FiniteFloat
    decision: Literal["reject", "do_not_reject", "not_applicable"]
    detail: str


class GeneratorDiagnostics(BaseModel):
    seed: int
    count: int
    mean: FiniteFloat
    sample_variance: FiniteFloat
    expected_mean: FiniteFloat
    expected_variance: FiniteFloat
    d_plus: FiniteFloat
    d_minus: FiniteFloat
    uniforms: list[FiniteFloat]
    frequencies: list[int]
    expected_frequency: FiniteFloat
    series_frequencies: list[int]
    series_pairs: int
    series_expected_frequency: FiniteFloat
    tests: list[DiagnosticTest]
    convention: str


class ModelDiagnostics(BaseModel):
    return_count: int
    normality: DiagnosticTest
    lag_one_correlation: FiniteFloat | None
    correlation_pairs: int
    outlier_count: int
    convention: str


class EvaluationMetrics(BaseModel):
    mae: FiniteFloat | None
    rmse: FiniteFloat | None
    mape: FiniteFloat | None
    coverage: FiniteFloat | None
    terminal_absolute_error: FiniteFloat | None
    terminal_relative_error: FiniteFloat | None


class EvaluationPoint(BaseModel):
    step: int
    date: date
    actual: FiniteFloat
    predicted_mean: FiniteFloat
    predicted_median: FiniteFloat
    p5: FiniteFloat
    p95: FiniteFloat
    error: FiniteFloat
    absolute_error: FiniteFloat
    relative_error: FiniteFloat
    covered: bool


class BacktestMethod(BaseModel):
    method: Literal["monte_carlo", "bootstrap"]
    metrics: EvaluationMetrics
    points: list[EvaluationPoint]


class BacktestOut(BaseModel):
    id: str
    experiment_id: str
    request: BacktestRequest
    status: Literal["complete", "insufficient"]
    evaluated_steps: int
    stopped_at_gap: bool
    initial_price: FiniteFloat
    observations: list[AnalysisPoint]
    baseline: EvaluationMetrics
    methods: list[BacktestMethod]
    generator_diagnostics: GeneratorDiagnostics
    model_diagnostics: ModelDiagnostics
    training_fingerprint: str
    evaluation_fingerprint: str
    created_at: str
    model_version: str
    scipy_version: str
    source: str
    interpretation: str
    convention: str
    warnings: list[str]


class SimulationExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    experiment_id: UUID
    include_paths: bool = True
