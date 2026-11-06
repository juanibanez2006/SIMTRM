import io
import json
import platform
import uuid
from datetime import date

import numpy as np
from numpy.typing import NDArray

from app.config import SOURCE_NAME, now_bogota
from app.db import Database
from app.queries import where_filter
from app.records import Record, canonical_json, digest, normalize
from app.schemas import HistoryFilter, SimulationOut, SimulationRequest
from app.statistics import compute_returns, describe, distribution, select_past_records

MODEL_VERSION = "simulation-1.0.0"


class SimulationError(ValueError):
    pass


def prepare_training(
    records: list[Record], request: SimulationRequest, today: date
) -> tuple[list[Record], NDArray, dict]:
    if request.cutoff_date > today:
        raise SimulationError("La fecha de corte no puede ser posterior a hoy en America/Bogota")
    records = [
        row
        for row in records
        if row.valid_to >= request.training_start and row.valid_from <= request.training_end
    ]
    records, _ = select_past_records(records, request.cutoff_date)
    returns, _ = compute_returns(records, rolling_window=2)
    logs = np.array(
        [row["log_return"] for row in returns if not row["excluded_gap"]], dtype=np.float64
    )
    if len(logs) < 2:
        raise SimulationError(
            "Se requieren al menos tres precios y dos rendimientos contiguos válidos para calibrar"
        )
    training = {
        "record_count": len(records),
        "return_count": len(logs),
        "gap_count": sum(row["excluded_gap"] for row in returns),
        "extended_records": sum(row.valid_to > row.valid_from for row in records),
        "first_date": str(max(records[0].valid_from, request.training_start)),
        "last_date": str(min(records[-1].valid_to, request.training_end)),
        "initial_record_date": str(records[-1].valid_from),
        "mu": float(np.mean(logs)),
        "sigma": float(np.std(logs, ddof=1)),
        "history": [
            {
                "date": str(row.valid_from),
                "valid_to": str(min(row.valid_to, request.training_end)),
                "value": format(row.value, "f"),
                "extended": row.valid_to > row.valid_from,
            }
            for row in records[-60:]
        ],
        "dataset_fingerprint": digest([row.fingerprint for row in records]),
    }
    return records, logs, training


def simulate_paths(
    log_returns: NDArray, request: SimulationRequest, method: str, initial_price: float
) -> NDArray:
    rng = np.random.default_rng(request.seed)
    shape = (request.replicas, request.horizon)
    with np.errstate(over="raise", under="raise", invalid="raise"):
        if method == "monte_carlo":
            increments = rng.normal(
                float(np.mean(log_returns)), float(np.std(log_returns, ddof=1)), size=shape
            )
        elif method == "bootstrap":
            increments = rng.choice(log_returns, size=shape, replace=True)
        else:
            raise SimulationError("Método de simulación no admitido")
        paths = np.empty((request.replicas, request.horizon + 1), dtype=np.float64)
        paths[:, 0] = initial_price
        paths[:, 1:] = initial_price * np.exp(np.cumsum(increments, axis=1))
    if not np.all(np.isfinite(paths)) or np.any(paths <= 0):
        raise SimulationError("El escenario produjo precios no positivos o no finitos")
    return paths


def summarize_paths(
    paths: NDArray, request: SimulationRequest, method: str, initial_price: float, threshold: float
) -> dict:
    terminal = paths[:, -1]
    quantiles = np.quantile(paths, [0.05, 0.25, 0.5, 0.75, 0.95], axis=0, method="linear")
    means = np.mean(paths, axis=0)
    bands = [
        {
            "step": step,
            "mean": float(means[step]),
            "median": float(quantiles[2, step]),
            "p5": float(quantiles[0, step]),
            "p25": float(quantiles[1, step]),
            "p75": float(quantiles[3, step]),
            "p95": float(quantiles[4, step]),
        }
        for step in range(request.horizon + 1)
    ]
    events = {
        "above_initial": terminal > initial_price,
        "below_initial": terminal < initial_price,
        "equal_initial": terminal == initial_price,
        "above_threshold": terminal > threshold,
        "below_threshold": terminal < threshold,
        "within_interval": (
            (terminal >= float(request.interval_low)) & (terminal <= float(request.interval_high))
        )
        if request.interval_low is not None
        else None,
    }
    probabilities = [
        {
            "event": event,
            "count": int(np.count_nonzero(mask)) if mask is not None else None,
            "probability": float(np.count_nonzero(mask) / request.replicas)
            if mask is not None
            else None,
        }
        for event, mask in events.items()
    ]
    histogram, _, _, _ = distribution(terminal, None)
    summary = describe(terminal, "price")
    assumptions = (
        "Rendimientos logarítmicos normales e independientes con media y desviación constantes. "
        "Modelo discreto r = μ + σZ y P siguiente = P × exp(r); μ es media logarítmica, "
        "sin ajuste de deriva de un movimiento browniano geométrico continuo."
        if method == "monte_carlo"
        else "Remuestreo independiente con reemplazo de rendimientos logarítmicos históricos. "
        "Conserva su distribución empírica, pero pierde dependencia temporal "
        "y agrupamiento de volatilidad."
    )
    low = f"{quantiles[0, -1]:.2f}".replace(".", ",")
    high = f"{quantiles[4, -1]:.2f}".replace(".", ",")
    return {
        "method": method,
        "paths": paths[: request.display_paths].tolist(),
        "displayed_paths": min(request.display_paths, request.replicas),
        "total_paths": request.replicas,
        "bands": bands,
        "terminal_values": terminal.tolist(),
        "terminal_summary": summary,
        "histogram": histogram,
        "probabilities": probabilities,
        "interpretation": (
            f"En {request.replicas} réplicas y {request.horizon} pasos, los percentiles 5 y 95 "
            f"del precio terminal son {low} y {high} COP/USD. Describen el rango percentilar "
            "central nominal del 90 % de estos escenarios; los empates y la interpolación "
            "pueden alterar la fracción exacta contenida. No son una garantía de cobertura futura "
            "ni un intervalo de confianza de parámetros."
        ),
        "assumptions": assumptions,
    }


def run_experiment(
    records: list[Record], request: SimulationRequest, today: date, replay_of: str | None = None
) -> tuple[SimulationOut, bytes, list[Record]]:
    selected, logs, training = prepare_training(records, request, today)
    initial = float(
        request.initial_price if request.initial_price is not None else selected[-1].value
    )
    threshold = float(request.threshold) if request.threshold is not None else initial
    methods = ["monte_carlo", "bootstrap"] if request.method == "both" else [request.method]
    matrices, results = {}, []
    try:
        with np.errstate(over="raise", under="raise", invalid="raise", divide="raise"):
            for method in methods:
                paths = simulate_paths(logs, request, method, initial)
                matrices[method] = paths
                results.append(summarize_paths(paths, request, method, initial, threshold))
    except (FloatingPointError, OverflowError) as exc:
        raise SimulationError(
            "Escenario fuera del rango numérico representable; "
            "reduzca el horizonte o revise el entrenamiento"
        ) from exc
    archive = io.BytesIO()
    np.savez_compressed(archive, **matrices)
    warnings = [
        "Escenarios simulados bajo supuestos del modelo; no son predicciones garantizadas "
        "ni recomendaciones de inversión.",
        "Un paso es una transición del modelo, sin equivalencia automática "
        "a un día calendario o de mercado.",
        "Bandas marginales por paso: no son trayectorias individuales "
        "ni intervalos de confianza de parámetros.",
    ]
    if training["gap_count"]:
        warnings.append(
            f"Se excluyeron {training['gap_count']} transiciones por huecos del histórico, "
            "sin interpolar precios."
        )
    if request.training_end < request.cutoff_date:
        warnings.append(
            "El entrenamiento termina antes del corte; el precio inicial automático "
            "procede del último registro de entrenamiento."
        )
    if training["last_date"] < str(request.training_end):
        warnings.append(
            "La copia local no cubre el final del entrenamiento; "
            "se utiliza su último registro disponible."
        )
    if request.replicas < 100:
        warnings.append(
            "Pocas réplicas: los percentiles y probabilidades empíricos pueden ser inestables; "
            "una réplica no permite desviación muestral."
        )
    if training["return_count"] < 30:
        warnings.append(
            "La calibración usa menos de 30 rendimientos; "
            "los parámetros pueden ser poco representativos."
        )
    if training["sigma"] == 0:
        warnings.append(
            "Volatilidad histórica nula: con estos datos los escenarios "
            "no presentan dispersión aleatoria."
        )
    numeric = digest(
        {
            "request": request.model_dump(mode="json"),
            "training": {key: value for key, value in training.items() if key != "history"},
            "methods": results,
        }
    )
    result = SimulationOut.model_validate(
        {
            "id": str(uuid.uuid4()),
            "replay_of": replay_of,
            "request": request,
            "initial_price": initial,
            "initial_price_origin": "configured"
            if request.initial_price is not None
            else "last_training_record",
            "threshold": threshold,
            "training": training,
            "methods": results,
            "created_at": now_bogota().isoformat(),
            "model_version": MODEL_VERSION,
            "numpy_version": np.__version__,
            "python_version": platform.python_version(),
            "machine": platform.machine(),
            "bit_generator": type(np.random.default_rng(request.seed).bit_generator).__name__,
            "source": SOURCE_NAME,
            "numeric_fingerprint": numeric,
            "convention": (
                "Entrenamiento con registros originales que intersectan la ventana y comienzan "
                "a más tardar en su fecha final, la cual no supera el corte. Un rendimiento por "
                "par de vigencias contiguas; se conservan precios iguales y se excluyen huecos. "
                "Media y desviación logarítmicas estimadas con ddof=1 para la desviación. "
                "Cada método reinicia su generador con la misma semilla; "
                "esto no empareja trayectorias. Todas las réplicas se usan para "
                "distribuciones, percentiles lineales y probabilidades "
                "terminales. Solo las primeras trayectorias indicadas se dibujan. Se conservan las "
                "matrices completas y una instantánea inmutable del entrenamiento en SQLite. "
                "La reproducción exacta requiere el mismo entorno numérico y versión del algoritmo."
            ),
            "warnings": warnings,
        }
    )
    return result, archive.getvalue(), selected


def save_experiment(
    db: Database, result: SimulationOut, archive: bytes, records: list[Record]
) -> None:
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO simulation_experiments VALUES(?,?,?,?,?,?)",
            (
                result.id,
                result.created_at,
                result.request.model_dump_json(),
                canonical_json([json.loads(record.raw_json) for record in records]),
                result.model_dump_json(),
                archive,
            ),
        )


def create_experiment(db: Database, request: SimulationRequest) -> SimulationOut:
    if request.cutoff_date > now_bogota().date():
        raise SimulationError("La fecha de corte no puede ser posterior a hoy en America/Bogota")
    where, params = where_filter(
        HistoryFilter(start=request.training_start, end=request.training_end)
    )
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT raw_json FROM records" + where + " ORDER BY valid_from", params
        ).fetchall()
    result, archive, records = run_experiment(
        [normalize(json.loads(row["raw_json"])) for row in rows], request, now_bogota().date()
    )
    save_experiment(db, result, archive, records)
    return result


def get_experiment(db: Database, experiment_id: str) -> SimulationOut | None:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT result_json FROM simulation_experiments WHERE id=?", (experiment_id,)
        ).fetchone()
    return SimulationOut.model_validate_json(row["result_json"]) if row else None


def replay_experiment(db: Database, experiment_id: str) -> SimulationOut | None:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT snapshot_json,result_json,request_json FROM simulation_experiments WHERE id=?",
            (experiment_id,),
        ).fetchone()
    if row is None:
        return None
    original = SimulationOut.model_validate_json(row["result_json"])
    if (
        original.model_version != MODEL_VERSION
        or original.numpy_version != np.__version__
        or original.python_version != platform.python_version()
        or original.machine != platform.machine()
    ):
        raise SimulationError(
            "El entorno numérico o el algoritmo cambió; no se garantiza reproducción exacta"
        )
    records = [normalize(raw) for raw in json.loads(row["snapshot_json"])]
    result, archive, selected = run_experiment(
        records,
        SimulationRequest.model_validate_json(row["request_json"]),
        now_bogota().date(),
        experiment_id,
    )
    if result.numeric_fingerprint != original.numeric_fingerprint:
        raise SimulationError(
            "La reproducción no coincide con la huella numérica del experimento original"
        )
    save_experiment(db, result, archive, selected)
    return result
