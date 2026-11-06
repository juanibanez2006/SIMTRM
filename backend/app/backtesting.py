import json
import uuid
from datetime import date, timedelta

import numpy as np
import scipy

from app.config import SOURCE_NAME, now_bogota
from app.db import Database
from app.diagnostics import generator_diagnostics, model_diagnostics
from app.records import Record, canonical_json, digest, normalize
from app.schemas import BacktestOut, BacktestRequest, SimulationOut
from app.simulation import SimulationError, run_experiment

MODEL_VERSION = "backtest-1.0.0"


def evaluation_metrics(
    actual: np.ndarray, predicted: np.ndarray, complete: bool, coverage=None
) -> dict:
    if not len(actual):
        return dict.fromkeys(
            [
                "mae",
                "rmse",
                "mape",
                "coverage",
                "terminal_absolute_error",
                "terminal_relative_error",
            ]
        )
    absolute = np.abs(predicted - actual)
    return {
        "mae": float(np.mean(absolute)),
        "rmse": float(np.sqrt(np.mean((predicted - actual) ** 2))),
        "mape": float(np.mean(absolute / actual)),
        "coverage": coverage,
        "terminal_absolute_error": float(absolute[-1]) if complete else None,
        "terminal_relative_error": float(absolute[-1] / actual[-1]) if complete else None,
    }


def evaluate_experiment(
    experiment: SimulationOut,
    training: list[Record],
    candidates: list[Record],
    request: BacktestRequest,
    today: date,
) -> tuple[BacktestOut, list[Record]]:
    if training[-1].valid_to < request.cutoff_date:
        raise SimulationError(
            "La última vigencia de entrenamiento no cubre el corte; "
            "elija una fecha con cobertura oficial"
        )
    observed, gap = [], False
    previous = training[-1]
    for row in sorted(candidates, key=lambda item: item.valid_from):
        if row.valid_from <= request.cutoff_date or row.valid_from > today:
            continue
        if row.valid_from != previous.valid_to + timedelta(days=1):
            gap = True
            break
        observed.append(row)
        previous = row
        if len(observed) == request.horizon:
            break
    complete = len(observed) == request.horizon
    actual = np.array([float(row.value) for row in observed])
    baseline = evaluation_metrics(actual, np.full(len(actual), experiment.initial_price), complete)
    methods = []
    for model in experiment.methods:
        points = []
        for step, row in enumerate(observed, start=1):
            band = model.bands[step]
            value = float(row.value)
            error = band.mean - value
            points.append(
                {
                    "step": step,
                    "date": str(row.valid_from),
                    "actual": value,
                    "predicted_mean": band.mean,
                    "predicted_median": band.median,
                    "p5": band.p5,
                    "p95": band.p95,
                    "error": error,
                    "absolute_error": abs(error),
                    "relative_error": abs(error) / value,
                    "covered": band.p5 <= value <= band.p95,
                }
            )
        coverage = sum(point["covered"] for point in points) / len(points) if points else None
        metrics = evaluation_metrics(
            actual, np.array([point["predicted_mean"] for point in points]), complete, coverage
        )
        methods.append({"method": model.method, "metrics": metrics, "points": points})
    warnings = [
        "Una sola ventana retrospectiva no demuestra capacidad predictiva general "
        "ni calibración perfecta.",
        "La cobertura es puntual por observación dentro de bandas marginales P5–P95; "
        "no es cobertura simultánea de una trayectoria.",
    ]
    if not complete:
        warnings.append(
            f"Validación insuficiente: hay {len(observed)} de {request.horizon} "
            "observaciones posteriores contiguas. Las métricas parciales "
            "no son errores del horizonte completo."
        )
    if gap:
        warnings.append(
            "La evaluación se detuvo en el primer hueco de cobertura; "
            "no se interpolaron ni saltaron pasos."
        )
    result = BacktestOut.model_validate(
        {
            "id": str(uuid.uuid4()),
            "experiment_id": experiment.id,
            "request": request,
            "status": "complete" if complete else "insufficient",
            "evaluated_steps": len(observed),
            "stopped_at_gap": gap,
            "initial_price": experiment.initial_price,
            "observations": [
                {"date": str(row.valid_from), "value": float(row.value)} for row in observed
            ],
            "baseline": baseline,
            "methods": methods,
            "generator_diagnostics": generator_diagnostics(
                request.seed, request.uniform_count, request.alpha
            ),
            "model_diagnostics": model_diagnostics(training, request.alpha),
            "training_fingerprint": experiment.training.dataset_fingerprint,
            "evaluation_fingerprint": digest([row.fingerprint for row in observed]),
            "created_at": now_bogota().isoformat(),
            "model_version": MODEL_VERSION,
            "scipy_version": scipy.__version__,
            "source": SOURCE_NAME,
            "interpretation": (
                f"Con corte {request.cutoff_date}, se calibró exclusivamente con "
                f"{experiment.training.return_count} rendimientos previos y se evaluaron "
                f"{len(observed)} de {request.horizon} pasos con datos posteriores "
                "no usados en calibración. Los errores de la media simulada "
                "se comparan con la persistencia del precio inicial; "
                "la evaluación es descriptiva y debe repetirse en otros cortes."
            ),
            "convention": (
                "Entrenamiento hasta el corte inclusive; "
                "precio inicial oficial vigente en el corte. "
                "Evaluación con los primeros registros de vigencia nuevos posteriores al corte, "
                "sin repetir días de una vigencia extendida. Un paso por transición contigua. "
                "MAE = media |predicción − real|; RMSE = raíz de media del error al cuadrado; "
                "MAPE = media del error absoluto / valor real. Predicción puntual: media de todas "
                "las réplicas. Referencia de persistencia: mantener P0 en todos los pasos. "
                "Cobertura: conteo P5 ≤ real ≤ P95 / pasos evaluados. Solo una evaluación completa "
                "permite error terminal del horizonte. Se guardan entrenamiento y evaluación."
            ),
            "warnings": warnings,
        }
    )
    return result, observed


def create_backtest(db: Database, request: BacktestRequest) -> BacktestOut:
    today = now_bogota().date()
    if request.cutoff_date > today:
        raise SimulationError("La fecha de corte no puede ser posterior a hoy")
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT raw_json FROM records WHERE valid_to >= ? ORDER BY valid_from",
            (str(request.training_start),),
        ).fetchall()
    records = [normalize(json.loads(row["raw_json"])) for row in rows]
    training = [row for row in records if row.valid_from <= request.cutoff_date]
    experiment, archive, selected = run_experiment(training, request.simulation_request(), today)
    if selected[-1].valid_to < request.cutoff_date:
        raise SimulationError("La fuente no cubre la fecha de corte")
    result, observed = evaluate_experiment(experiment, selected, records, request, today)
    # Persist both immutable samples and complete simulated matrices in one transaction.
    with db.connect() as connection:
        save_experiment_values = (
            experiment.id,
            experiment.created_at,
            experiment.request.model_dump_json(),
            canonical_json([json.loads(row.raw_json) for row in selected]),
            experiment.model_dump_json(),
            archive,
        )
        connection.execute(
            "INSERT INTO simulation_experiments VALUES(?,?,?,?,?,?)", save_experiment_values
        )
        connection.execute(
            "INSERT INTO backtests VALUES(?,?,?,?,?)",
            (
                result.id,
                result.created_at,
                request.model_dump_json(),
                result.model_dump_json(),
                canonical_json([json.loads(row.raw_json) for row in observed]),
            ),
        )
    return result


def get_backtest(db: Database, id: str) -> BacktestOut | None:
    with db.connect() as connection:
        row = connection.execute("SELECT result_json FROM backtests WHERE id=?", (id,)).fetchone()
    return BacktestOut.model_validate_json(row["result_json"]) if row else None
