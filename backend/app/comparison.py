import json
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

import numpy as np

from app.config import SOURCE_NAME, now_bogota
from app.db import Database
from app.queries import where_filter
from app.records import Record, digest, normalize
from app.schemas import ComparisonQuery, HistoryFilter
from app.statistics import compute_returns, describe, select_past_records

MODEL_VERSION = "comparison-1.0.0"
Alignment = Literal["observation", "elapsed_days"]
METRICS = {
    "count": "count",
    "mean": "COP/USD",
    "median": "COP/USD",
    "minimum": "COP/USD",
    "maximum": "COP/USD",
    "sample_std": "COP/USD",
    "initial_value": "COP/USD",
    "final_value": "COP/USD",
    "absolute_change": "COP/USD",
    "relative_change": "fraction",
    "cumulative_return": "fraction",
    "volatility": "fraction",
}
RELATIVE_DIFFERENCE_METRICS = {
    "mean",
    "median",
    "minimum",
    "maximum",
    "sample_std",
    "initial_value",
    "final_value",
}


def summarize_period(
    records: list[Record],
    start: date,
    end: date,
    alignment: Alignment,
    today: date,
) -> dict:
    records = [row for row in records if row.valid_to >= start and row.valid_from <= end]
    records, excluded_future = select_past_records(records, today)
    values = np.array([float(row.value) for row in records], dtype=np.float64)
    summary = describe(values, "price")
    returns, _ = compute_returns(records, rolling_window=2)
    logs = [row["log_return"] for row in returns if not row["excluded_gap"]]
    gaps = sum(row["excluded_gap"] for row in returns)
    enough = len(records) >= 2
    absolute = float(records[-1].value - records[0].value) if enough else None
    relative = float(records[-1].value / records[0].value - 1) if enough else None
    points = []
    for index, record in enumerate(records):
        effective = max(start, record.valid_from)
        points.append(
            {
                "position": index + 1 if alignment == "observation" else (effective - start).days,
                "date": str(record.valid_from),
                "valid_to": str(record.valid_to),
                "effective_date": str(effective),
                "effective_until": str(min(end, record.valid_to, today)),
                "value": format(record.value, "f"),
                "normalized": float(record.value / records[0].value * Decimal(100)),
                "gap_before": bool(
                    index and record.valid_from != records[index - 1].valid_to + timedelta(days=1)
                ),
            }
        )
    warnings = []
    if not records:
        warnings.append("No hay datos oficiales en el periodo hasta la fecha de corte.")
    elif not enough:
        warnings.append(
            "Un solo registro: no se calculan cambios entre extremos ni desviación muestral."
        )
    if len(logs) < 2:
        warnings.append("Se necesitan al menos dos rendimientos válidos para estimar volatilidad.")
    if end > today:
        warnings.append(
            "El periodo solicitado termina después del corte; "
            "solo se usa información disponible hasta hoy."
        )
    if records and (
        points[0]["effective_date"] > str(start)
        or points[-1]["effective_until"] < str(min(end, today))
    ):
        warnings.append(
            "La fuente cubre parcialmente los límites solicitados; no se completan observaciones."
        )
    if gaps:
        warnings.append(
            f"Hay {gaps} huecos internos: se conserva el cambio entre extremos, "
            "pero no se calcula rendimiento acumulado de una cadena incompleta."
        )
    if excluded_future:
        warnings.append(f"Se excluyeron {excluded_future} registros con vigencia inicial futura.")
    return {
        "requested_start": str(start),
        "requested_end": str(end),
        "observed_start": points[0]["effective_date"] if points else None,
        "observed_end": points[-1]["effective_until"] if points else None,
        "return_count": len(logs),
        "gap_count": gaps,
        "excluded_future_records": excluded_future,
        "metrics": {
            **{
                key: summary[key]
                for key in ("count", "mean", "median", "minimum", "maximum", "sample_std")
            },
            "initial_value": float(records[0].value) if records else None,
            "final_value": float(records[-1].value) if records else None,
            "absolute_change": absolute,
            "relative_change": relative,
            "cumulative_return": relative if not gaps else None,
            "volatility": float(np.std(logs, ddof=1)) if len(logs) >= 2 else None,
        },
        "points": points,
        "dataset_fingerprint": digest([row.fingerprint for row in records]),
        "warnings": warnings,
    }


def compare_records(
    a_records: list[Record],
    b_records: list[Record],
    query: ComparisonQuery,
    today: date,
) -> dict:
    a = summarize_period(a_records, query.a_start, query.a_end, query.alignment, today)
    b = summarize_period(b_records, query.b_start, query.b_end, query.alignment, today)
    differences = []
    for metric, unit in METRICS.items():
        left, right = a["metrics"][metric], b["metrics"][metric]
        delta = right - left if left is not None and right is not None else None
        relative = (
            (right / left - 1)
            if (delta is not None and left > 0 and metric in RELATIVE_DIFFERENCE_METRICS)
            else None
        )
        differences.append(
            {
                "metric": metric,
                "unit": unit,
                "a": left,
                "b": right,
                "delta": delta,
                "relative_delta": relative,
            }
        )
    a_positions = {point["position"]: point for point in a["points"]}
    b_positions = {point["position"]: point for point in b["points"]}
    rows = [
        {"position": position, "a": a_positions.get(position), "b": b_positions.get(position)}
        for position in sorted(a_positions.keys() | b_positions.keys())
    ]
    warnings = []
    if a["metrics"]["count"] != b["metrics"]["count"]:
        warnings.append(
            "Los periodos tienen distinta cantidad de registros. Se comparan sus muestras "
            "completas; no se recortan a la longitud más corta."
        )
    if query.a_start <= query.b_end and query.b_start <= query.a_end:
        warnings.append(
            "Los intervalos solicitados se solapan: pueden compartir observaciones "
            "y no deben interpretarse como muestras independientes."
        )
    if a["metrics"]["count"] and b["metrics"]["count"]:
        delta = b["metrics"]["mean"] - a["metrics"]["mean"]
        a_mean = f"{a['metrics']['mean']:.6f}".replace(".", ",")
        b_mean = f"{b['metrics']['mean']:.6f}".replace(".", ",")
        delta_text = f"{delta:.6f}".replace(".", ",")
        interpretation = (
            f"La media del periodo A es {a_mean} COP/USD y la del periodo B "
            f"es {b_mean} COP/USD. La diferencia B − A es {delta_text} COP/USD. "
            "Estos resultados describen los registros seleccionados, sin atribuir causas "
            "económicas ni demostrar diferencias estadísticamente significativas."
        )
    else:
        interpretation = (
            "La comparación de indicadores requiere al menos un dato en cada periodo. "
            "Los valores ausentes no se sustituyen por cero."
        )
    return {
        "alignment": query.alignment,
        "a": a,
        "b": b,
        "differences": differences,
        "rows": rows,
        "paired_positions": len(a_positions.keys() & b_positions.keys()),
        "source": SOURCE_NAME,
        "cutoff_date": str(today),
        "calculated_at": now_bogota().isoformat(),
        "model_version": MODEL_VERSION,
        "dataset_fingerprint": digest(
            {"a": a["dataset_fingerprint"], "b": b["dataset_fingerprint"]}
        ),
        "convention": (
            "Registros originales cuyas vigencias intersectan cada selección; "
            "sin ponderar por días. "
            "Base 100: índice = (P / primer valor válido del periodo) × 100. "
            "Alineación por observación: posiciones 1, 2, …; "
            "no representa el mismo día calendario. "
            "Por días transcurridos: posición 0 = inicio solicitado; se recortan visualmente "
            "las vigencias a sus límites. Se respetan los días bisiestos. No se interpolan, "
            "rellenan ni fuerzan coincidencias de posiciones ausentes. "
            "La tabla une inicios de registro: una celda ausente no equivale a falta de cobertura. "
            "Las estadísticas usan todos los datos de cada periodo, "
            "con independencia de la alineación. "
            "Variación relativa: último / primero − 1; coincide con el rendimiento acumulado "
            "si hay al menos dos registros y cobertura interna continua. "
            "Volatilidad: desviación muestral de rendimientos logarítmicos entre vigencias "
            "contiguas (ddof=1), sin anualizar. Diferencias siempre B − A; diferencias de "
            "rendimientos o volatilidad expresadas como puntos porcentuales en la interfaz."
        ),
        "interpretation": interpretation,
        "warnings": warnings,
    }


def comparison_for_periods(db: Database, query: ComparisonQuery) -> dict:
    samples = []
    # Read both periods from the same SQLite snapshot during concurrent synchronization.
    with db.connect() as connection:
        connection.execute("BEGIN")
        for start, end in [(query.a_start, query.a_end), (query.b_start, query.b_end)]:
            where, params = where_filter(HistoryFilter(start=start, end=end))
            rows = connection.execute(
                "SELECT raw_json FROM records" + where + " ORDER BY valid_from", params
            ).fetchall()
            samples.append([normalize(json.loads(row["raw_json"])) for row in rows])
    return compare_records(samples[0], samples[1], query, now_bogota().date())
