import { useState } from "react";
import { request } from "./api";
import { money, number, shortDate, timestamp } from "./format";
import BacktestChart from "./BacktestChart";
import ExportButton from "./ExportButton";
import type { Backtest, DataStatus, Latest } from "./types";

const names = { monte_carlo: "Montecarlo", bootstrap: "Bootstrap" };
const decimal = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 6 });
const pct = (value: number | null) =>
  value === null ? "—" : `${decimal.format(value * 100)} %`;
const pValue = (value: number | null) =>
  value === null
    ? "—"
    : value > 0 && value < 0.000001
      ? value.toExponential(3)
      : decimal.format(value);
const decisions = {
  reject: "Rechazar H0",
  do_not_reject: "No rechazar H0",
  not_applicable: "No aplicable",
};

export default function BacktestPage({
  latest,
  status,
}: {
  latest: Latest;
  status: DataStatus;
}) {
  const previousYear =
    Number((latest.record?.valid_from || latest.today).slice(0, 4)) - 1;
  const [form, setForm] = useState({
    training_start: `${previousYear}-01-01`,
    cutoff_date: `${previousYear}-12-31`,
    method: "both",
    horizon: "30",
    replicas: "1000",
    seed: "2026",
    uniform_count: "1000",
    alpha: "0.05",
  });
  const [result, setResult] = useState<Backtest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(1);
  const update = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const invalid =
    !form.training_start || !form.cutoff_date
      ? "Complete las fechas de entrenamiento y corte."
      : form.training_start > form.cutoff_date
        ? "El inicio del entrenamiento no puede superar el corte."
        : form.cutoff_date > latest.today
          ? "El corte no puede ser posterior a hoy."
          : !Number.isInteger(Number(form.horizon)) ||
              Number(form.horizon) < 1 ||
              Number(form.horizon) > 365
            ? "El horizonte debe estar entre 1 y 365 pasos."
            : !Number.isInteger(Number(form.replicas)) ||
                Number(form.replicas) < 1 ||
                Number(form.replicas) > 50000
              ? "Indique entre 1 y 50.000 réplicas enteras."
              : !form.seed ||
                  !Number.isInteger(Number(form.seed)) ||
                  Number(form.seed) < 0 ||
                  Number(form.seed) > 4294967295
                ? "Indique una semilla entera entre 0 y 4.294.967.295."
                : Number(form.replicas) *
                      (Number(form.horizon) + 1) *
                      (form.method === "both" ? 2 : 1) >
                    2_000_000
                  ? "La solicitud supera el límite de 2.000.000 de celdas."
                  : "";
  async function run() {
    setBusy(true);
    setError("");
    try {
      const next = await request<Backtest>("/backtests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          horizon: Number(form.horizon),
          replicas: Number(form.replicas),
          seed: Number(form.seed),
          uniform_count: Number(form.uniform_count),
          alpha: Number(form.alpha),
        }),
      });
      setResult(next);
      setForm(
        Object.fromEntries(
          Object.entries(next.request).map(([key, value]) => [
            key,
            String(value),
          ]),
        ) as typeof form,
      );
      setIndex(0);
      setPage(1);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No fue posible realizar la validación",
      );
    } finally {
      setBusy(false);
    }
  }
  const model = result?.methods[index];
  const dirty =
    result &&
    Object.entries(result.request).some(
      ([key, value]) => String(value) !== form[key as keyof typeof form],
    );
  return (
    <div className="backtest-page">
      <section className="simulation-notice">
        <strong>Evaluación histórica fuera del entrenamiento</strong>
        <p>
          Seleccione un corte pasado con datos posteriores disponibles. El
          sistema calibra hasta el corte y evalúa las siguientes vigencias sin
          incorporarlas al entrenamiento.
        </p>
      </section>
      {!status.total && (
        <div className="empty-state panel">
          <h2>No hay histórico local para validar</h2>
          <p>
            Abra Calidad de datos y sincronice la fuente oficial antes de
            ejecutar el contraste retrospectivo.
          </p>
        </div>
      )}
      <form
        className="panel simulation-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) void run();
        }}
      >
        <div className="section-heading">
          <div>
            <h2>Configurar validación retrospectiva</h2>
            <p>
              El precio inicial es la TRM oficial vigente en el corte. La
              referencia sencilla mantiene ese precio constante.
            </p>
          </div>
        </div>
        <fieldset className="simulation-fields" disabled={busy}>
          <legend className="sr-only">Parámetros de validación</legend>
          <div className="simulation-input-grid">
            <label>
              Inicio del entrenamiento de validación
              <input
                type="date"
                value={form.training_start}
                onChange={(event) =>
                  update("training_start", event.target.value)
                }
              />
            </label>
            <label>
              Corte retrospectivo
              <input
                type="date"
                max={latest.today}
                value={form.cutoff_date}
                onChange={(event) => update("cutoff_date", event.target.value)}
              />
            </label>
            <label>
              Modelos a evaluar
              <select
                value={form.method}
                onChange={(event) => update("method", event.target.value)}
              >
                <option value="both">Montecarlo y bootstrap</option>
                <option value="monte_carlo">Montecarlo</option>
                <option value="bootstrap">Bootstrap</option>
              </select>
            </label>
            <label>
              Pasos a evaluar
              <input
                type="number"
                min="1"
                max="365"
                step="1"
                value={form.horizon}
                onChange={(event) => update("horizon", event.target.value)}
              />
            </label>
            <label>
              Réplicas por modelo
              <input
                type="number"
                min="1"
                max="50000"
                step="1"
                value={form.replicas}
                onChange={(event) => update("replicas", event.target.value)}
              />
            </label>
            <label>
              Semilla de validación
              <input
                type="number"
                min="0"
                max="4294967295"
                step="1"
                value={form.seed}
                onChange={(event) => update("seed", event.target.value)}
              />
            </label>
            <label>
              Uniformes de diagnóstico
              <select
                value={form.uniform_count}
                onChange={(event) =>
                  update("uniform_count", event.target.value)
                }
              >
                {[250, 1000, 5000, 10000].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Significancia de diagnósticos
              <select
                value={form.alpha}
                onChange={(event) => update("alpha", event.target.value)}
              >
                <option value="0.01">1 %</option>
                <option value="0.05">5 %</option>
                <option value="0.1">10 %</option>
              </select>
            </label>
          </div>
        </fieldset>
        <div className="simulation-actions">
          <button
            className="primary"
            type="submit"
            disabled={busy || Boolean(invalid) || !status.total}
          >
            Ejecutar validación retrospectiva
          </button>
          <span>
            Un paso por nuevo registro de vigencia; no por día calendario.
          </span>
        </div>
        {dirty && (
          <p className="comparison-draft">
            Parámetros modificados: ejecute la validación para aplicarlos. Los
            resultados visibles conservan su corte consultado.
          </p>
        )}
        {invalid && (
          <p className="comparison-validation" role="alert">
            {invalid}
          </p>
        )}
      </form>
      {busy && (
        <div className="loading panel" role="status">
          <span className="spinner" />
          Calibrando y contrastando con observaciones posteriores…
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {result && model && (
        <>
          <section className="panel analysis-interpretation">
            <span className="small-label">
              {result.status === "complete"
                ? "HORIZONTE EVALUADO COMPLETO"
                : "VALIDACIÓN INSUFICIENTE"}
            </span>
            <h2>Resultado retrospectivo</h2>
            <p>{result.interpretation}</p>
            <p className="analysis-provenance">
              Corte {shortDate(result.request.cutoff_date)} ·{" "}
              {result.evaluated_steps} de {result.request.horizon} pasos ·{" "}
              {result.request.replicas} réplicas · semilla {result.request.seed}
            </p>
            <ExportButton
              path={`/exports/backtest/${result.id}`}
              filename="SIMTRM_validacion.xlsx"
              label="Excel de la validación"
            />
          </section>
          <aside
            className="analysis-warnings"
            aria-label="Limitaciones retrospectivas"
          >
            <ul>
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </aside>
          <section className="panel table-panel">
            <div className="section-heading">
              <div>
                <h2>Errores frente a persistencia</h2>
                <p>
                  Predicción puntual: media simulada. Métricas sobre{" "}
                  {result.evaluated_steps} observaciones efectivamente
                  evaluadas.
                </p>
              </div>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Resultados de la tabla"
            >
              <table>
                <caption className="sr-only">
                  Errores y cobertura de modelos y referencia
                </caption>
                <thead>
                  <tr>
                    <th>Modelo</th>
                    <th className="numeric">MAE · COP/USD</th>
                    <th className="numeric">RMSE · COP/USD</th>
                    <th className="numeric">MAPE</th>
                    <th className="numeric">Cobertura P5–P95</th>
                    <th className="numeric">Error terminal · COP/USD</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: "Persistencia P0", metrics: result.baseline },
                    ...result.methods.map((method) => ({
                      label: names[method.method],
                      metrics: method.metrics,
                    })),
                  ].map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td className="numeric">{money(row.metrics.mae)}</td>
                      <td className="numeric">{money(row.metrics.rmse)}</td>
                      <td className="numeric">{pct(row.metrics.mape)}</td>
                      <td className="numeric">{pct(row.metrics.coverage)}</td>
                      <td className="numeric">
                        {money(row.metrics.terminal_absolute_error)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="analysis-table-note convention">
              MAE es error absoluto medio; RMSE penaliza errores grandes; MAPE
              divide cada error absoluto por la TRM real. Una cobertura alta en
              esta ventana no demuestra calibración perfecta. El error terminal
              solo se calcula si el horizonte está completo.
            </p>
          </section>
          <div
            className="simulation-method-tabs"
            aria-label="Modelo retrospectivo"
          >
            {result.methods.map((method, methodIndex) => (
              <button
                key={method.method}
                aria-pressed={index === methodIndex}
                onClick={() => {
                  setIndex(methodIndex);
                  setPage(1);
                }}
              >
                {names[method.method]}
              </button>
            ))}
          </div>
          {result.evaluated_steps > 0 && (
            <section className="panel chart-panel">
              <div className="section-heading">
                <div>
                  <h2>Datos posteriores y escenarios del corte</h2>
                  <p>
                    Fechas reales de observaciones no utilizadas para calibrar.
                  </p>
                </div>
              </div>
              <BacktestChart
                key={`${result.id}-${index}`}
                result={result}
                index={index}
              />
            </section>
          )}
          <section className="panel table-panel">
            <div className="section-heading">
              <div>
                <h2>Errores por paso</h2>
                <p>
                  Comparación con cada observación oficial posterior al corte.
                </p>
              </div>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Resultados de la tabla"
            >
              <table>
                <caption className="sr-only">
                  Valores reales y errores de la media simulada por paso
                </caption>
                <thead>
                  <tr>
                    <th>Paso</th>
                    <th>Fecha real</th>
                    <th className="numeric">TRM real</th>
                    <th className="numeric">Media simulada</th>
                    <th className="numeric">P5</th>
                    <th className="numeric">P95</th>
                    <th className="numeric">Error absoluto</th>
                    <th>En banda</th>
                  </tr>
                </thead>
                <tbody>
                  {model.points
                    .slice((page - 1) * 20, page * 20)
                    .map((point) => (
                      <tr key={point.step}>
                        <td>{point.step}</td>
                        <td>{shortDate(point.date)}</td>
                        <td className="numeric">{money(point.actual)}</td>
                        <td className="numeric">
                          {money(point.predicted_mean)}
                        </td>
                        <td className="numeric">{money(point.p5)}</td>
                        <td className="numeric">{money(point.p95)}</td>
                        <td className="numeric">
                          {money(point.absolute_error)}
                        </td>
                        <td>{point.covered ? "Sí" : "No"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                Página {page} de{" "}
                {Math.max(1, Math.ceil(model.points.length / 20))}
              </span>
              <div>
                <button
                  disabled={page === 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Anterior validación
                </button>
                <button
                  disabled={page * 20 >= model.points.length}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Siguiente validación
                </button>
              </div>
            </div>
          </section>
          <section className="panel table-panel">
            <div className="section-heading">
              <div>
                <h2>Diagnóstico del generador y del entrenamiento</h2>
                <p>
                  No rechazar una hipótesis no demuestra que sea cierta. Estos
                  diagnósticos no sustituyen el contraste retrospectivo.
                </p>
              </div>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Resultados de la tabla"
            >
              <table>
                <caption className="sr-only">
                  Pruebas de uniformidad, series y normalidad
                </caption>
                <thead>
                  <tr>
                    <th>Prueba</th>
                    <th className="numeric">Estadístico</th>
                    <th className="numeric">Valor p</th>
                    <th>Decisión</th>
                    <th>Alcance</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...result.generator_diagnostics.tests,
                    result.model_diagnostics.normality,
                  ].map((test) => (
                    <tr key={test.name}>
                      <td>{test.name}</td>
                      <td className="numeric">
                        {test.statistic === null
                          ? "—"
                          : decimal.format(test.statistic)}
                      </td>
                      <td className="numeric">{pValue(test.p_value)}</td>
                      <td>{decisions[test.decision]}</td>
                      <td className="diagnostic-detail">{test.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="diagnostic-summary">
              <p>
                Uniformes: {number.format(result.generator_diagnostics.count)} ·
                media {decimal.format(result.generator_diagnostics.mean)}{" "}
                (teórica 0,5) · varianza muestral{" "}
                {decimal.format(result.generator_diagnostics.sample_variance)}{" "}
                (teórica 1/12).
              </p>
              <p>
                D+ = {decimal.format(result.generator_diagnostics.d_plus)} · D−
                = {decimal.format(result.generator_diagnostics.d_minus)} · pares
                de series {result.generator_diagnostics.series_pairs} · esperado
                por celda{" "}
                {decimal.format(
                  result.generator_diagnostics.series_expected_frequency,
                )}
                .
              </p>
              <p>
                Entrenamiento: correlación de rezago 1{" "}
                {result.model_diagnostics.lag_one_correlation === null
                  ? "no calculable"
                  : decimal.format(
                      result.model_diagnostics.lag_one_correlation,
                    )}{" "}
                en {result.model_diagnostics.correlation_pairs} pares ·{" "}
                {result.model_diagnostics.outlier_count} extremos de Tukey
                conservados.
              </p>
              <p>{result.generator_diagnostics.convention}</p>
              <p>{result.model_diagnostics.convention}</p>
            </div>
          </section>
          <details className="panel analysis-audit">
            <summary>Metodología e instantáneas de validación</summary>
            <p>{result.convention}</p>
            <p>
              Identificador de validación: <code>{result.id}</code>
              <br />
              Experimento de simulación asociado:{" "}
              <code>{result.experiment_id}</code>
              <br />
              Versión {result.model_version} · SciPy {result.scipy_version} ·{" "}
              {timestamp(result.created_at)}
            </p>
            <p>
              Huella del entrenamiento{" "}
              <code>{result.training_fingerprint}</code>
            </p>
            <p>
              Huella de evaluación <code>{result.evaluation_fingerprint}</code>
            </p>
          </details>
        </>
      )}
    </div>
  );
}
