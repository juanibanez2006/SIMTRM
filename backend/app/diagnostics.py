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


def generator_diagnostics(seed: int, count: int, alpha: float) -> dict:
    uniforms = np.random.default_rng(seed).random(count)
    ordered = np.sort(uniforms)
    ranks = np.arange(1, count + 1)
    d_plus = float(np.max(ranks / count - ordered))
    d_minus = float(np.max(ordered - (ranks - 1) / count))
    ks = stats.kstest(uniforms, "uniform", method="auto")
    frequencies, _ = np.histogram(uniforms, bins=np.linspace(0, 1, 11))
    chi = stats.chisquare(frequencies)
    pairs = uniforms[: count // 2 * 2].reshape(-1, 2)
    series, _, _ = np.histogram2d(pairs[:, 0], pairs[:, 1], bins=np.linspace(0, 1, 6))
    series_test = stats.chisquare(series.ravel())
    return {
        "seed": seed,
        "count": count,
        "mean": float(np.mean(uniforms)),
        "sample_variance": float(np.var(uniforms, ddof=1)),
        "expected_mean": 0.5,
        "expected_variance": 1 / 12,
        "d_plus": d_plus,
        "d_minus": d_minus,
        "uniforms": uniforms.tolist(),
        "frequencies": frequencies.tolist(),
        "expected_frequency": count / 10,
        "series_frequencies": series.astype(int).ravel().tolist(),
        "series_pairs": len(pairs),
        "series_expected_frequency": len(pairs) / 25,
        "tests": [
            diagnostic(
                "Kolmogorov–Smirnov U(0,1)",
                "Distribución uniforme continua completamente especificada",
                max(d_plus, d_minus),
                ks.pvalue,
                alpha,
                "D+ = max(i/n − U(i)); D− = max(U(i) − (i−1)/n). "
                "Se usan los uniformes originales ordenados.",
            ),
            diagnostic(
                "Chi-cuadrado de uniformidad",
                "Diez intervalos de igual probabilidad",
                chi.statistic,
                chi.pvalue,
                alpha,
                "10 clases; esperados n/10, al menos 25 por clase; 9 grados de libertad.",
            ),
            diagnostic(
                "Chi-cuadrado de series",
                "Pares no solapados uniformes en el cuadrado unidad",
                series_test.statistic,
                series_test.pvalue,
                alpha,
                "25 celdas de igual probabilidad, 24 grados de libertad. Esperados ≥ 5; "
                "considera uniformidad conjunta e independencia de pares.",
            ),
        ],
        "convention": (
            "Muestra diagnóstica U[0,1) de un generador separado, reiniciado con la semilla. "
            "No consume las innovaciones de las simulaciones ni representa TRM oficial. "
            "No rechazar H0 no demuestra uniformidad o independencia perfectas. Con alpha=5 % "
            "puede rechazarse un generador correcto por error tipo I. "
            "No valida el modelo financiero."
        ),
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
