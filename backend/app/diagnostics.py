import numpy as np
from scipy import stats

from app.records import Record
from app.statistics import compute_returns


def diagnostic(name: str, hypothesis: str, statistic, p_value, alpha: float, detail: str) -> dict:
    available = (
        statistic is not None
        and p_value is not None
        and np.isfinite(statistic)
        and np.isfinite(p_value)
    )
    return {
        "name": name,
        "hypothesis": hypothesis,
        "statistic": float(statistic) if available else None,
        "p_value": float(p_value) if available else None,
        "alpha": alpha,
        "decision": ("reject" if p_value < alpha else "do_not_reject")
        if available
        else "not_applicable",
        "detail": detail,
    }


def model_diagnostics(records: list[Record], alpha: float) -> dict:
    points, _ = compute_returns(records, rolling_window=2)
    logs = np.array([row["log_return"] for row in points if not row["excluded_gap"]], dtype=float)
    statistic = p_value = None
    detail = "Se requieren al menos 20 rendimientos no constantes para esta evaluación asintótica."
    if len(logs) >= 20 and np.ptp(logs) > 0:
        test = stats.normaltest(logs)
        statistic, p_value = test.statistic, test.pvalue
        detail = (
            "Prueba ómnibus basada en asimetría y curtosis. Supone observaciones "
            "independientes; la dependencia temporal puede afectar su interpretación."
        )
        if not np.isfinite(statistic) or not np.isfinite(p_value):
            detail = "No se obtuvo un diagnóstico finito de normalidad para esta muestra."
    pairs = [
        (a["log_return"], b["log_return"])
        for a, b in zip(points, points[1:], strict=False)
        if not a["excluded_gap"] and not b["excluded_gap"]
    ]
    correlation = None
    if len(pairs) >= 2:
        first, second = np.array(pairs).T
        if np.ptp(first) > 0 and np.ptp(second) > 0:
            correlation = float(np.corrcoef(first, second)[0, 1])
    outliers = 0
    if len(logs):
        q1, q3 = np.quantile(logs, [0.25, 0.75], method="linear")
        iqr = q3 - q1
        outliers = int(np.count_nonzero((logs < q1 - 1.5 * iqr) | (logs > q3 + 1.5 * iqr)))
    return {
        "return_count": len(logs),
        "normality": diagnostic(
            "D’Agostino–Pearson",
            "Los rendimientos de entrenamiento proceden de una distribución normal",
            statistic,
            p_value,
            alpha,
            detail,
        ),
        "lag_one_correlation": correlation,
        "correlation_pairs": len(pairs),
        "outlier_count": outliers,
        "convention": (
            "Diagnóstico solo del entrenamiento. La correlación de rezago 1 es descriptiva "
            "y no cruza huecos; no prueba independencia general. Los extremos de Tukey "
            "se conservan. No se aplica K-S clásico a una normal ajustada con la misma "
            "muestra. Un valor p alto no demuestra que el modelo sea correcto."
        ),
    }
