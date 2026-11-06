import json
import math
from collections import deque
from datetime import date, timedelta
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from app.config import SOURCE_NAME, now_bogota
from app.db import Database
from app.queries import where_filter
from app.records import DataError, Record, audit_records, digest, normalize
from app.schemas import StatisticsQuery

Variable = Literal["price", "simple_return", "log_return"]
PERCENTILES = [5, 25, 50, 75, 95]
MODEL_VERSION = "descriptive-1.0.0"


def describe(values: NDArray[np.float64], variable: Variable) -> dict:
    """Describe the full selected sample; monetary storage remains decimal elsewhere."""
    if values.ndim != 1 or not np.all(np.isfinite(values)):
        raise ValueError("La muestra debe ser un vector de valores finitos")
    count = len(values)
    result = dict.fromkeys(
        [
            "mean",
            "median",
            "minimum",
            "maximum",
            "range",
            "population_variance",
            "sample_variance",
            "sample_std",
            "q1",
            "q3",
            "iqr",
            "coefficient_variation_pct",
        ]
    )
    result.update(count=count, percentiles={})
    if not count:
        return result
    quantiles = np.percentile(values, PERCENTILES, method="linear")
    mean = float(np.mean(values))
    std = float(np.std(values, ddof=1)) if count >= 2 else None
    result.update(
        mean=mean,
        median=float(quantiles[2]),
        minimum=float(np.min(values)),
        maximum=float(np.max(values)),
        range=float(np.ptp(values)),
        population_variance=float(np.var(values, ddof=0)),
        sample_variance=float(np.var(values, ddof=1)) if count >= 2 else None,
        sample_std=std,
        q1=float(quantiles[1]),
        q3=float(quantiles[3]),
        iqr=float(quantiles[3] - quantiles[1]),
        # CV is meaningful here only for positive price levels on a ratio scale.
        coefficient_variation_pct=std / mean * 100
        if variable == "price" and mean > 0 and std is not None
        else None,
        percentiles={
            f"p{percentile}": float(value)
            for percentile, value in zip(PERCENTILES, quantiles, strict=True)
        },
    )
    return result


def distribution(
    values: NDArray[np.float64], bins: int | None
) -> tuple[list, list, dict | None, str]:
    count = len(values)
    if not count:
        return [], [], None, "Sin observaciones"
    constant = float(np.ptp(values)) == 0
    bin_count = bins or min(80, math.ceil(math.log2(count)) + 1)
    if constant:
        half_width = max(abs(float(values[0])) * 0.005, 0.000001)
        edges = np.array([values[0] - half_width, values[0] + half_width])
        method = "Muestra constante: una clase con límites ampliados solo para visualizar"
    else:
        edges = np.histogram_bin_edges(values, bins=bin_count)
        method = f"{bin_count} clases de igual amplitud" + (
            " · regla de Sturges" if bins is None else " · selección manual"
        )
    frequencies, edges = np.histogram(values, bins=edges)
    cumulative = np.cumsum(frequencies)
    histogram = [
        {
            "lower": float(edges[index]),
            "upper": float(edges[index + 1]),
            "right_closed": index == len(frequencies) - 1,
            "frequency": int(frequency),
            "relative_frequency": float(frequency / count),
            "cumulative_frequency": int(cumulative[index]),
            "cumulative_probability": float(cumulative[index] / count),
        }
        for index, frequency in enumerate(frequencies)
    ]
    unique, counts = np.unique(values, return_counts=True)
    cumulative_counts = np.cumsum(counts)
    ecdf = [
        {"value": float(value), "probability": float(total / count), "cumulative_count": int(total)}
        for value, total in zip(unique, cumulative_counts, strict=True)
    ]
    q1, q3 = np.quantile(values, [0.25, 0.75], method="linear")
    iqr = q3 - q1
    lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    inside = values[(values >= lower) & (values <= upper)]
    outliers = values[(values < lower) | (values > upper)]
    boxplot = {
        "lower_fence": float(lower),
        "upper_fence": float(upper),
        "whisker_low": float(np.min(inside)),
        "whisker_high": float(np.max(inside)),
        "outliers": outliers.tolist(),
        "outlier_count": len(outliers),
    }
    return histogram, ecdf, boxplot, method


def compute_returns(records: list[Record], rolling_window: int) -> tuple[list, list]:
    returns, rolling = [], []
    window: deque[float] = deque(maxlen=rolling_window)
    for previous, current in zip(records, records[1:], strict=False):
        gap = current.valid_from != previous.valid_to + timedelta(days=1)
        simple = log_return = absolute = None
        if gap:
            window.clear()
        else:
            # Decimal ratios first, then float only for statistical calculations.
            ratio = current.value / previous.value
            simple = float(ratio - 1)
            log_return = math.log1p(simple) if abs(simple) < 0.5 else math.log(float(ratio))
            absolute = float(current.value - previous.value)
            window.append(log_return)
        returns.append(
            {
                "from_date": previous.valid_from.isoformat(),
                "date": current.valid_from.isoformat(),
                "elapsed_calendar_days": (current.valid_from - previous.valid_from).days,
                "simple_return": simple,
                "log_return": log_return,
                "absolute_change": absolute,
                "excluded_gap": gap,
            }
        )
        rolling.append(
            {
                "date": current.valid_from.isoformat(),
                "value": float(np.std(list(window), ddof=1))
                if len(window) == rolling_window
                else None,
            }
        )
    return returns, rolling


def select_past_records(records: list[Record], today: date) -> tuple[list[Record], int]:
    records = sorted(records, key=lambda row: row.valid_from)
    for row in records:
        if not row.value.is_finite() or row.value <= 0:
            raise DataError("La muestra local contiene precios inválidos")
    audit_records(records, today)
    excluded_future = sum(row.valid_from > today for row in records)
    records = [row for row in records if row.valid_from <= today]
    return records, excluded_future


def analyze_records(records: list[Record], query: StatisticsQuery, today: date) -> dict:
    records, excluded_future = select_past_records(records, today)
    returns, rolling = compute_returns(records, query.rolling_window)
    log_returns = np.array(
        [row["log_return"] for row in returns if not row["excluded_gap"]], dtype=np.float64
    )
    if query.variable == "price":
        points = []
        for index, row in enumerate(records):
            if index and returns[index - 1]["excluded_gap"]:
                points.append({"date": row.valid_from.isoformat(), "value": None})
            points.append({"date": row.valid_from.isoformat(), "value": float(row.value)})
    else:
        points = [{"date": row["date"], "value": row[query.variable]} for row in returns]
    values = np.array(
        [row["value"] for row in points if row["value"] is not None], dtype=np.float64
    )
    summary = describe(values, query.variable)
    histogram, ecdf, boxplot, histogram_method = distribution(values, query.bins)
    gaps = sum(row["excluded_gap"] for row in returns)
    warnings = []
    if len(values) < 2:
        warnings.append(
            "Se requieren al menos dos observaciones para varianza y desviación muestrales."
        )
    if len(log_returns) < 2:
        warnings.append(
            "Se requieren al menos dos rendimientos válidos para estimar volatilidad histórica."
        )
    if not any(point["value"] is not None for point in rolling):
        warnings.append(
            f"La ventana móvil requiere {query.rolling_window} rendimientos contiguos; "
            "puede no haber valores calculables."
        )
    if gaps:
        warnings.append(
            f"Se excluyeron {gaps} transiciones por huecos de cobertura. "
            "No se interpolaron precios; la ventana móvil se reinicia tras cada hueco."
        )
    if excluded_future:
        warnings.append(
            f"Se excluyeron {excluded_future} registros con inicio de vigencia "
            "posterior a la fecha de corte."
        )
    variable_name = {
        "price": "nivel de TRM",
        "simple_return": "rendimiento simple",
        "log_return": "rendimiento logarítmico",
    }[query.variable]
    unit = "COP/USD" if query.variable == "price" else "fraction"
    if len(values):
        scale = 1 if unit == "COP/USD" else 100
        display_unit = "COP/USD" if unit == "COP/USD" else "% por transición de vigencia"
        mean = f"{summary['mean'] * scale:.6f}".replace(".", ",")
        std = (
            f"{summary['sample_std'] * scale:.6f}".replace(".", ",")
            if summary["sample_std"] is not None
            else None
        )
        interpretation = (
            f"La variable {variable_name} reúne {len(values)} observaciones "
            f"con media {mean} {display_unit}. "
        )
        interpretation += (
            f"Su desviación estándar muestral es {std} {display_unit}. "
            if std is not None
            else "No hay muestra suficiente para estimar la desviación estándar muestral. "
        )
        interpretation += (
            "Estas medidas describen la muestra seleccionada; no garantizan rangos futuros "
            "ni validan independencia o normalidad."
        )
    else:
        interpretation = (
            f"No hay observaciones de {variable_name} calculables en el periodo seleccionado."
        )
    return {
        "variable": query.variable,
        "unit": unit,
        "summary": summary,
        "histogram": histogram,
        "histogram_method": histogram_method,
        "ecdf": ecdf,
        "boxplot": boxplot,
        "points": points,
        "returns": returns,
        "volatility": {
            "log_return_count": len(log_returns),
            "historical": float(np.std(log_returns, ddof=1)) if len(log_returns) >= 2 else None,
            "annualized": None,
            "rolling_window": query.rolling_window,
            "points": rolling,
            "convention": (
                "Desviación muestral de rendimientos logarítmicos por transición de vigencia "
                "(ddof=1). No anualizada; duración calendario variable. "
                "La ventana móvil usa solo transiciones contiguas."
            ),
        },
        "record_count": len(records),
        "extended_records": sum(row.valid_to > row.valid_from for row in records),
        "excluded_gap_pairs": gaps,
        "excluded_future_records": excluded_future,
        "first_date": str(records[0].valid_from) if records else None,
        "last_date": str(min(records[-1].valid_to, today)) if records else None,
        "dataset_fingerprint": digest([row.fingerprint for row in records]),
        "source": SOURCE_NAME,
        "calculated_at": now_bogota().isoformat(),
        "cutoff_date": today,
        "model_version": MODEL_VERSION,
        "numpy_version": np.__version__,
        "filters": query.model_dump(include={"year", "month", "start", "end"}),
        "convention": (
            "Registros originales cuya vigencia intersecta el periodo, sin repetir días "
            "ni eliminar precios iguales. Los rendimientos usan solo pares seleccionados "
            "con vigencias contiguas, sin buscar observaciones externas al periodo. "
            "Percentiles lineales (h=(n−1)p). Varianza poblacional: divisor n; "
            "muestral: divisor n−1. CV solo para niveles positivos de TRM."
        ),
        "interpretation": interpretation,
        "warnings": warnings,
    }


def statistics_for_period(db: Database, query: StatisticsQuery) -> dict:
    where, params = where_filter(query)
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT raw_json FROM records" + where + " ORDER BY valid_from", params
        ).fetchall()
    return analyze_records(
        [normalize(json.loads(row["raw_json"])) for row in rows], query, now_bogota().date()
    )
