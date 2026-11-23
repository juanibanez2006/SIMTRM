from datetime import date

import numpy as np
import pytest

from app.schemas import SimulationRequest
from app.simulation import SimulationError, fit_arima, simulate_paths


def configuration(**overrides):
    return SimulationRequest(
        training_start=date(2020, 1, 1),
        training_end=date(2021, 1, 1),
        cutoff_date=date(2021, 1, 1),
        method="arima",
        replicas=1000,
        horizon=5,
        **overrides,
    )


def test_arima_conditional_least_squares_and_recursive_simulation():
    rng = np.random.default_rng(42)
    returns = [0.001]
    for shock in rng.normal(0, 0.003, 1000):
        returns.append(0.0002 + 0.6 * returns[-1] + shock)
    returns = np.array(returns)
    fit = fit_arima(returns)
    x = np.column_stack((np.ones(len(returns) - 1), returns[:-1]))
    coefficients = np.linalg.solve(x.T @ x, x.T @ returns[1:])
    assert fit["intercept"] == pytest.approx(coefficients[0])
    assert fit["phi"] == pytest.approx(coefficients[1])
    residual = returns[1:] - x @ coefficients
    assert fit["innovation_sigma"] == pytest.approx(
        np.sqrt((residual @ residual) / (len(residual) - 2))
    )
    request = configuration(volatility_scale=0)
    paths = simulate_paths(returns, request, "arima", 4000)
    expected, last = [4000], returns[-1]
    for _ in range(5):
        last = fit["intercept"] + fit["phi"] * last
        expected.append(expected[-1] * np.exp(last))
    np.testing.assert_allclose(paths, np.tile(expected, (1000, 1)))
    np.testing.assert_array_equal(paths, simulate_paths(returns, request, "arima", 4000))


@pytest.mark.parametrize("method", ["bootstrap", "monte_carlo"])
def test_volatility_scenarios_scale_shocks_and_preserve_mean_log_drift(method):
    returns = np.array([-0.02, -0.01, 0.01, 0.03] * 20)
    base = configuration(volatility_scale=1)
    stressed = configuration(volatility_scale=2)
    p1 = simulate_paths(returns, base, method, 4000)
    p2 = simulate_paths(returns, stressed, method, 4000)
    r1, r2 = np.diff(np.log(p1)), np.diff(np.log(p2))
    np.testing.assert_allclose(r2 - returns.mean(), 2 * (r1 - returns.mean()), atol=1e-14)
    p0 = simulate_paths(returns, configuration(volatility_scale=0), method, 4000)
    np.testing.assert_allclose(np.diff(np.log(p0)), returns.mean())


def test_arima_rejects_insufficient_constant_and_explosive_returns():
    for returns in [np.zeros(29), np.ones(40), np.array([1.05**i for i in range(40)])]:
        with pytest.raises(SimulationError):
            fit_arima(returns)


@pytest.mark.parametrize("method", ["monte_carlo", "bootstrap", "arima"])
def test_terminal_log_distribution_matches_independent_model_moments(method):
    """Check full stochastic runs against analytic moments, not a copied RNG sequence."""
    from scipy.stats import norm

    returns = np.array([-0.018, 0.009, 0.025, -0.011, 0.003, -0.004] * 40)
    request = SimulationRequest(
        training_start=date(2020, 1, 1),
        training_end=date(2021, 1, 1),
        cutoff_date=date(2021, 1, 1),
        method=method,
        replicas=50000,
        horizon=5,
        seed=8142,
        volatility_scale=1.5,
    )
    if method == "arima":
        fit = fit_arima(returns)
        last, expected_mean = returns[-1], 0.0
        for _ in range(request.horizon):
            last = fit["intercept"] + fit["phi"] * last
            expected_mean += last
        weights = [sum(fit["phi"] ** j for j in range(k + 1)) for k in range(5)]
        expected_variance = (fit["innovation_sigma"] * 1.5) ** 2 * sum(w*w for w in weights)
    else:
        expected_mean = 5 * returns.mean()
        # Bootstrap samples the empirical population; the normal model uses sample variance.
        expected_variance = 5 * returns.var(ddof=1 if method == "monte_carlo" else 0) * 1.5**2
    paths = simulate_paths(returns, request, method, 4000)
    terminal_logs = np.log(paths[:, -1] / paths[:, 0])
    mean_error = 6 * np.sqrt(expected_variance / request.replicas)
    variance_error = 6 * expected_variance * np.sqrt(2 / (request.replicas - 1))
    assert abs(terminal_logs.mean() - expected_mean) < mean_error
    assert abs(terminal_logs.var(ddof=1) - expected_variance) < variance_error
    if method != "bootstrap":
        # Normal innovations imply a normal cumulative log return, hence a lognormal price.
        probability = norm.sf(0, loc=expected_mean, scale=np.sqrt(expected_variance))
        tolerance = 6 * np.sqrt(probability * (1-probability) / request.replicas)
        assert abs(np.mean(paths[:, -1] > 4000) - probability) < tolerance
