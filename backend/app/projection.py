"""Projection and rolling-origin evaluation in official validity transitions."""

import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from app import trm_calendar
from app.backtesting import evaluation_metrics
from app.config import now_bogota
from app.db import Database
from app.queries import record_out
from app.records import Record, canonical_json, normalize
from app.schemas import (
    ProjectionOut,
    ProjectionRequest,
    RollingOut,
    RollingRequest,
    SeriesPoint,
    SimulationRequest,
)
from app.simulation import SimulationError, run_experiment
from app.statistics import select_past_records

CONVENTION = (
    "Un paso corresponde a una nueva vigencia contigua de TRM, incluso si el precio no cambia. "
    "Una vigencia de varios días aporta un solo precio. El horizonte cuenta transiciones "
    "desde la vigencia inicial; no días calendario ni días hábiles. Las fechas futuras "
    "se asignan con el calendario previsto de vigencias, conservado en el resultado. Mediana de "
    "todas las réplicas, que minimiza el error absoluto esperado y reduce la influencia "
    "de la cola derecha. P5–P95 es un intervalo predictivo nominal del modelo del 90 %, "
    "condicionado a los parámetros estimados; no incluye incertidumbre de calibración "
    "ni garantiza cobertura real."
)


def load_records(db: Database, today: date) -> list[Record]:
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT raw_json FROM records WHERE valid_from <= ? ORDER BY valid_from",
            (str(today),),
        ).fetchall()
    records, _ = select_past_records([normalize(json.loads(r[0])) for r in rows], today)
    return records


def project(
    records: list[Record],
    settings: ProjectionRequest,
    cutoff: date,
    horizon: int,
    official_initial=None,
    anchor_previous=None,
):
    # Select only past observations BEFORE taking the fixed-size training window.
    past = [r for r in records if r.valid_from <= cutoff]
    if settings.training_end and settings.training_end > cutoff:
        raise SimulationError("El entrenamiento no puede terminar después del corte")
    if settings.training_start:
        training = [
            r
            for r in past
            if r.valid_to >= settings.training_start and r.valid_from <= settings.training_end
        ]
        required = 31
    else:
        training = past[-settings.training_records :]
        required = settings.training_records
    if len(training) < required:
        raise SimulationError(
            f"Se requieren {required} vigencias de entrenamiento; "
            f"solo hay {len(training)} disponibles antes del corte"
        )
    if not past or not past[-1].valid_from <= cutoff <= past[-1].valid_to:
        raise SimulationError(
            "La copia local no contiene una TRM vigente en el corte; actualice datos"
        )
    if any(
        b.valid_from != a.valid_to + timedelta(days=1)
        for a, b in zip(training, training[1:], strict=False)
    ):
        raise SimulationError(
            "El entrenamiento contiene huecos de cobertura; revise Datos oficiales"
        )
    initial_return = None
    if settings.method == "arima":
        if official_initial is not None:
            previous = anchor_previous if anchor_previous is not None else past[-1].value
            initial_return = float(np.log(float(official_initial / previous)))
        elif len(past) >= 2 and past[-1].valid_from == past[-2].valid_to + timedelta(days=1):
            initial_return = float(np.log(float(past[-1].value / past[-2].value)))
        else:
            raise SimulationError("ARIMA requiere el rendimiento contiguo conocido en el corte")
    request = SimulationRequest(
        training_start=settings.training_start or training[0].valid_from,
        training_end=min(settings.training_end or cutoff, cutoff),
        cutoff_date=cutoff,
        method=settings.method,
        horizon=horizon,
        replicas=settings.replicas,
        seed=settings.seed,
        display_paths=10,
        initial_price=official_initial if official_initial is not None else past[-1].value,
        initial_return=initial_return,
        volatility_scale=settings.volatility_scale,
        threshold=settings.threshold,
        interval_low=settings.interval_low,
        interval_high=settings.interval_high,
    )
    return run_experiment(training, request, cutoff)


def insert_experiment(connection, experiment, archive, training):
    connection.execute(
        "INSERT INTO simulation_experiments VALUES(?,?,?,?,?,?)",
        (
            experiment.id,
            experiment.created_at,
            experiment.request.model_dump_json(),
            canonical_json([json.loads(r.raw_json) for r in training]),
            experiment.model_dump_json(),
            archive,
        ),
    )


def create_projection(db: Database, request: ProjectionRequest) -> ProjectionOut:
    now = now_bogota()
    if now.tzinfo is None:
        now = now.replace(tzinfo=ZoneInfo("America/Bogota"))
    today = now.date()
    # One read snapshot supplies calibration and already-published anchors, even
    # when the synchronization worker replaces the live series concurrently.
    with db.connect() as connection:
        snapshot = connection.execute(
            "SELECT * FROM records WHERE valid_from <= ? ORDER BY valid_from",
            (str(max(today, request.target_date or today)),),
        ).fetchall()
    records, _ = select_past_records(
        [normalize(json.loads(r["raw_json"])) for r in snapshot if r["valid_from"] <= str(today)],
        today,
    )
    schedule, published, base = [], [], records[-1] if records else None
    anchor_previous = None
    if request.target_date:
        if request.target_date <= today:
            raise SimulationError("Seleccione una fecha posterior a hoy en America/Bogota")
        if not records or records[-1].valid_to < today:
            raise SimulationError(
                "No hay una TRM vigente en el corte; actualice los datos oficiales"
            )
        # Already-published next-day certificates are known anchors, not unknown outcomes.
        # They never enter calibration of returns ending before the daily cutoff.
        rows = [r for r in snapshot if str(today) < r["valid_from"] <= str(request.target_date)]
        previous = records[-1]
        for row in rows:
            obtained = datetime.fromisoformat(row["obtained_at"])
            if obtained.tzinfo is None:
                obtained = obtained.replace(tzinfo=ZoneInfo("America/Bogota"))
            candidate = normalize(json.loads(row["raw_json"]))
            if obtained > now or candidate.valid_from != previous.valid_to + timedelta(days=1):
                break
            published.append(record_out(row))
            anchor_previous = previous.value
            previous = candidate
        base = previous
        schedule = trm_calendar.future_validities(base.valid_to, request.target_date, today)
        request = request.model_copy(update={"horizon": len(schedule)})
    experiment, archive, training = project(
        records,
        request,
        today,
        request.horizon,
        base.value if published else None,
        anchor_previous,
    )
    if request.training_start:
        request = request.model_copy(update={"training_records": len(training)})
    anchor_reference = None
    if records[-1].fingerprint != training[-1].fingerprint:
        anchor_reference = record_out(
            next(r for r in snapshot if r["valid_from"] == str(records[-1].valid_from))
        )
    terminal = experiment.methods[0].bands[-1]
    points = []
    if request.target_date:
        intervals = [(max(today, base.valid_from), base.valid_from, base.valid_to)] + [
            (v.start, v.start, v.end) for v in schedule
        ]
        for step, (reference, start, end) in enumerate(intervals):
            band = experiment.methods[0].bands[step]
            points.append(
                dict(
                    step=step,
                    date=reference,
                    valid_from=start,
                    valid_to=end,
                    median=band.median,
                    p5=band.p5,
                    p95=band.p95,
                    change=band.median - experiment.initial_price,
                    relative_change=band.median / experiment.initial_price - 1,
                    requested=start <= request.target_date <= end,
                )
            )
    validation, evaluations, snapshots = None, [], []
    validation_status = "No ejecutada en este experimento por transiciones"
    if request.target_date:
        try:
            validation, evaluations, snapshots = evaluate_records(
                records,
                RollingRequest(
                    settings=request.model_copy(
                        update={
                            "training_start": None,
                            "training_end": None,
                            "training_records": len(training),
                        }
                    ),
                    unit="calendar_days",
                    horizons=[7, 30, 90],
                    folds=6,
                ),
                today,
            )
            validation_status = "Evaluación retrospectiva guardada con el experimento"
        except SimulationError as exc:
            validation_status = f"Evaluación no disponible: {exc}"
    result = ProjectionOut(
        id=experiment.id,
        request=request,
        as_of=today,
        valid_from=base.valid_from,
        valid_to=base.valid_to,
        estimate=terminal.median,
        lower=terminal.p5,
        upper=terminal.p95,
        change=terminal.median - experiment.initial_price,
        relative_change=terminal.median / experiment.initial_price - 1,
        experiment=experiment,
        convention=CONVENTION,
        model_version="projection-2.0.0" if request.target_date else "projection-1.0.0",
        target_date=request.target_date,
        projected_from=points[-1]["valid_from"] if points else None,
        projected_to=points[-1]["valid_to"] if points else None,
        points=points,
        history=[
            dict(
                date=r.valid_from,
                valid_to=r.valid_to,
                value=str(r.value),
                extended=r.valid_from != r.valid_to,
            )
            for r in training
        ],
        published_references=published,
        anchor_reference=anchor_reference,
        calendar_version=trm_calendar.VERSION if points else None,
        calendar_convention=trm_calendar.CONVENTION if points else "",
        calendar_sources=trm_calendar.SOURCES if points else [],
        validation=validation,
        validation_status=validation_status,
    )
    result.history.extend(
        [
            SeriesPoint(
                date=p["valid_from"],
                valid_to=p["valid_to"],
                value=p["value"],
                extended=p["extended"],
            )
            for p in ([anchor_reference] if anchor_reference else []) + published
        ]
    )
    with db.connect() as connection:
        insert_experiment(connection, experiment, archive, training)
        if validation:
            save_evaluation(connection, validation, evaluations, snapshots)
        connection.execute(
            "INSERT INTO projections VALUES(?,?)", (result.id, result.model_dump_json())
        )
    return result


def create_rolling(db: Database, request: RollingRequest) -> RollingOut:
    today = now_bogota().date()
    records = load_records(db, today)
    result, experiments, snapshots = evaluate_records(records, request, today)
    with db.connect() as connection:
        save_evaluation(connection, result, experiments, snapshots)
    return result


def save_evaluation(connection, result, experiments, snapshots):
    for values in experiments:
        insert_experiment(connection, *values)
    connection.execute(
        "INSERT INTO rolling_evaluations VALUES(?,?,?)",
        (
            result.id,
            result.model_dump_json(),
            canonical_json(snapshots),
        ),
    )


def evaluate_records(records, request: RollingRequest, today: date):
    maximum = max(request.horizons)
    if request.last_cutoff and request.last_cutoff > today:
        raise SimulationError("El corte de validación no puede estar en el futuro")
    if request.settings.training_start:
        raise SimulationError("La validación móvil utiliza un número de vigencias, no fechas fijas")
    # Most recent eligible origins, separated by the largest horizon. Selection uses
    # only dates/counts, never errors or the direction of future prices.
    if request.unit == "transitions":
        candidates = [
            i
            for i in range(len(records) - maximum)
            if not request.last_cutoff or records[i].valid_to <= request.last_cutoff
        ]
        last = candidates[-1] if candidates else -1
        origins = list(range(last, request.settings.training_records - 2, -maximum))[
            : request.folds
        ]
    else:
        origins, latest_cutoff = [], today - timedelta(days=maximum)
        if request.last_cutoff:
            latest_cutoff = min(latest_cutoff, request.last_cutoff)
        for index in range(len(records) - 1, request.settings.training_records - 2, -1):
            if records[index].valid_to <= latest_cutoff:
                origins.append(index)
                latest_cutoff = records[index].valid_to - timedelta(days=maximum)
                if len(origins) == request.folds:
                    break
    if len(origins) < 2:
        raise SimulationError(
            "No hay histórico suficiente para dos cortes completos con esta ventana"
        )
    cases, experiments, snapshots = [], [], []
    skipped = 0
    for index in reversed(origins):
        cutoff = records[index].valid_to
        # Discard origins with incomplete coverage, without replacing them by favorable cuts.
        last_index = index + maximum
        if request.unit == "calendar_days":
            target = cutoff + timedelta(days=maximum)
            last_index = next(
                (
                    i
                    for i in range(index + 1, len(records))
                    if records[i].valid_from <= target <= records[i].valid_to
                ),
                None,
            )
            if last_index is None:
                skipped += 1
                continue
        chain = records[index - request.settings.training_records + 1 : last_index + 1]
        if any(
            b.valid_from != a.valid_to + timedelta(days=1)
            for a, b in zip(chain, chain[1:], strict=False)
        ):
            skipped += 1
            continue
        for horizon in sorted(request.horizons):
            steps, target, expected = (
                horizon,
                records[index + horizon].valid_from if request.unit == "transitions" else None,
                None,
            )
            if request.unit == "calendar_days":
                target = cutoff + timedelta(days=horizon)
                schedule = trm_calendar.future_validities(records[index].valid_to, target, cutoff)
                steps = len(schedule)
                expected = schedule[-1]
                actual_index = next(
                    i
                    for i in range(index + 1, last_index + 1)
                    if records[i].valid_from <= target <= records[i].valid_to
                )
            else:
                actual_index = index + horizon
            experiment, archive, training = project(records, request.settings, cutoff, steps)
            actual = records[actual_index]
            band = experiment.methods[0].bands[-1]
            cases.append(
                dict(
                    cutoff=cutoff,
                    target=target,
                    horizon=horizon,
                    experiment_id=experiment.id,
                    initial=experiment.initial_price,
                    actual=float(actual.value),
                    predicted=band.median,
                    lower=band.p5,
                    upper=band.p95,
                    model=request.settings.method,
                    absolute_error=abs(band.median - float(actual.value)),
                    relative_error=abs(band.median / float(actual.value) - 1),
                    target_valid_from=actual.valid_from,
                    target_valid_to=actual.valid_to,
                    simulated_steps=steps,
                    calendar_matches=(
                        expected.start == actual.valid_from and expected.end == actual.valid_to
                    )
                    if expected
                    else None,
                )
            )
            experiments.append((experiment, archive, training))
            snapshots.append(
                [json.loads(r.raw_json) for r in records[index + 1 : actual_index + 1]]
            )
    if len({case["cutoff"] for case in cases}) < 2:
        raise SimulationError(
            "Menos de dos cortes evaluables sin huecos; revise cobertura o ventana"
        )
    summaries = []
    for horizon in sorted(request.horizons):
        sample = [c for c in cases if c["horizon"] == horizon]
        actual = np.array([c["actual"] for c in sample])
        predicted = np.array([c["predicted"] for c in sample])
        coverage = float(np.mean([c["lower"] <= c["actual"] <= c["upper"] for c in sample]))
        summaries.append(
            dict(
                horizon=horizon,
                count=len(sample),
                model=evaluation_metrics(actual, predicted, False, coverage),
                baseline=evaluation_metrics(
                    actual, np.array([c["initial"] for c in sample]), False
                ),
                mean_width=float(np.mean([c["upper"] - c["lower"] for c in sample])),
            )
        )
    result = RollingOut(
        id=str(uuid.uuid4()),
        request=request,
        created_at=now_bogota().isoformat(),
        cases=cases,
        summaries=summaries,
        skipped=skipped,
        convention=CONVENTION + " Ventana móvil del mismo tamaño que la proyección. "
        "Horizontes en "
        f"{'días calendario' if request.unit == 'calendar_days' else 'transiciones'}. "
        "Cortes separados por el mayor horizonte solicitado. MAE y RMSE calculados "
        "sobre los valores terminales de cada corte, por horizonte. Cada corte "
        "reestima parámetros exclusivamente con sus vigencias previas. "
        "La referencia mantiene la TRM inicial constante.",
        warnings=[
            "La evaluación usa la versión actual del histórico; puede incluir revisiones "
            "publicadas después de los cortes. No es una reconstrucción "
            "de publicaciones en tiempo real.",
            "Ventanas de entrenamiento pueden solaparse; "
            "los errores no constituyen muestras independientes.",
            "Una menor MAE o RMSE en estos cortes no demuestra superioridad futura. "
            "No se seleccionan parámetros automáticamente a partir de estos errores.",
            f"Cortes evaluados: {len(origins) - skipped} de {request.folds} solicitados; "
            f"omitidos por huecos: {skipped}.",
            "En la evaluación por fecha, el calendario previsto se obtiene antes de consultar "
            "la observación objetivo. Las diferencias con las vigencias oficiales se declaran; "
            "no se ajusta el número de pasos con información posterior al corte.",
        ],
    )
    return result, experiments, snapshots
