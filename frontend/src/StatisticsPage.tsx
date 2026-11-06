import { useEffect, useState } from "react";
import { request, queryString } from "./api";
import { number, shortDate, timestamp } from "./format";
import StatisticsChart from "./StatisticsChart";
import ExportButton from "./ExportButton";
import MethodNote from "./MethodNote";
import { plotTitles } from "./statisticsPlots";
import type { AnalysisVariable, Statistics } from "./types";

const variableNames: Record<AnalysisVariable, string> = {
  price: "Nivel de TRM",
  simple_return: "Rendimiento simple",
  log_return: "Rendimiento logarítmico",
};
const decimal = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 6 });
const percent = (value: number | null) =>
  value === null ? "—" : `${decimal.format(value * 100)} %`;

export default function StatisticsPage({
  periodQuery,
  refresh,
}: {
  periodQuery: string;
  refresh: number | string;
}) {
  const [variable, setVariable] = useState<AnalysisVariable>("price");
  const [bins, setBins] = useState("");
  const [window, setWindow] = useState("20");
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{
    key: string;
    data: Statistics | null;
    error: string;
  } | null>(null);
  const query = `${periodQuery}${periodQuery ? "&" : ""}${queryString({ variable, bins, rolling_window: window })}`;
  const key = `${query}|${refresh}|${retry}`;
  const stats = response?.key === key ? response.data : null;
  const error = response?.key === key ? response.error : "";
  const loading = response?.key !== key;

  useEffect(() => {
    const controller = new AbortController();
    request<Statistics>(`/trm/statistics?${query}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setResponse({ key, data, error: "" });
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted)
          setResponse({ key, data: null, error: err.message });
      });
    return () => controller.abort();
  }, [query, key]);

  const value = (x: number | null | undefined) =>
    x == null
      ? "—"
      : stats?.unit === "fraction"
        ? percent(x)
        : decimal.format(x);
  const unit = stats?.unit === "COP/USD" ? "COP/USD" : "% por transición";
  const variance = (x: number | null) =>
    x === null
      ? "—"
      : decimal.format(x * (stats?.unit === "fraction" ? 10_000 : 1));

  return (
    <div className="statistics-page">
      <section
        className="panel analysis-controls"
        aria-label="Configuración del análisis"
      >
        <div>
          <p className="eyebrow">DESCRIBIR ANTES DE MODELAR</p>
          <h2>Configurar el análisis</h2>
        </div>
        <div className="filters">
          <label>
            Variable de análisis
            <select
              value={variable}
              onChange={(event) =>
                setVariable(event.target.value as AnalysisVariable)
              }
            >
              {Object.entries(variableNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Clases del histograma
            <select
              value={bins}
              onChange={(event) => setBins(event.target.value)}
            >
              <option value="">Automáticas · Sturges</option>
              {[5, 10, 15, 20, 30, 50, 80].map((count) => (
                <option key={count} value={count}>
                  {count} clases
                </option>
              ))}
            </select>
          </label>
          <label>
            Ventana de volatilidad móvil
            <select
              value={window}
              onChange={(event) => setWindow(event.target.value)}
            >
              {[2, 5, 10, 20, 30, 60, 120, 252].map((size) => (
                <option key={size} value={size}>
                  {size} rendimientos contiguos
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="convention">
          Se utilizan todos los registros filtrados. Los rendimientos y la
          volatilidad se expresan por transición de vigencia, sin repetir fines
          de semana o festivos.
        </p>
      </section>
      {loading && (
        <div className="loading panel" role="status">
          <span className="spinner" />
          Calculando estadísticas locales…
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          <span>{error}</span>
          <button onClick={() => setRetry((current) => current + 1)}>
            Reintentar análisis
          </button>
        </div>
      )}
      {stats && (
        <>
          <div className="module-export">
            <ExportButton
              path={`/exports/statistics?${query}`}
              filename="SIMTRM_estadisticas.xlsx"
              label="Excel del análisis estadístico"
            />
          </div>
          <section className="panel analysis-interpretation">
            <span className="small-label">
              {variableNames[stats.variable]} · DATOS HISTÓRICOS
            </span>
            <h2>Lectura de la muestra seleccionada</h2>
            <p>{stats.interpretation}</p>
            <div className="analysis-provenance">
              {number.format(stats.record_count)} registros de vigencia ·{" "}
              {number.format(stats.volatility.log_return_count)} rendimientos
              válidos · {shortDate(stats.first_date)} a{" "}
              {shortDate(stats.last_date)}
            </div>
          </section>
          {stats.warnings.length > 0 && (
            <aside
              className="analysis-warnings"
              aria-label="Limitaciones de la muestra"
            >
              <strong>Alcance del cálculo</strong>
              <ul>
                {stats.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </aside>
          )}
          {stats.summary.count === 0 ? (
            <div className="empty-state panel">
              <h2>No hay observaciones calculables</h2>
              <p>
                Amplíe el periodo o seleccione niveles de TRM. Un solo precio no
                produce un rendimiento.
              </p>
            </div>
          ) : (
            <>
              <MethodNote title="Cómo se calculan estas medidas y qué significan">
                <p>
                  Muestra utilizada: {number.format(stats.record_count)} precios
                  y {number.format(stats.volatility.log_return_count)}{" "}
                  rendimientos logarítmicos válidos del periodo seleccionado.
                  Los días repetidos por vigencia no se cuentan como
                  observaciones independientes.
                </p>
                <p>
                  Media: Σx/n. Varianza poblacional: Σ(x − media)²/n. Varianza
                  muestral: Σ(x − media)²/(n − 1); su raíz es la desviación
                  muestral. La media describe el centro y la desviación la
                  dispersión de la variable elegida, sin afirmar causalidad ni
                  comportamiento futuro.
                </p>
                <p>
                  Rendimiento simple: Pᵢ/Pᵢ₋₁ − 1. Logarítmico: ln(Pᵢ/Pᵢ₋₁). La
                  volatilidad es la desviación muestral de rendimientos
                  logarítmicos contiguos; no se anualiza. Una vigencia extendida
                  no genera rendimientos adicionales; los huecos reinician la
                  ventana móvil.
                </p>
                <p>
                  Percentiles: posiciones con interpolación lineal h = (n − 1)p.
                  Describen esta muestra y no son intervalos de confianza. Todos
                  los cálculos usan el conjunto filtrado completo,
                  independientemente del zoom visual o de la página de la tabla.
                </p>
              </MethodNote>
              <section className="metric-grid" aria-label="Resumen estadístico">
                {[
                  [
                    "Observaciones analizadas",
                    number.format(stats.summary.count),
                    variableNames[stats.variable],
                  ],
                  ["Media aritmética", value(stats.summary.mean), unit],
                  ["Mediana", value(stats.summary.median), unit],
                  [
                    "Desviación estándar muestral",
                    value(stats.summary.sample_std),
                    `${unit} · ddof = 1`,
                  ],
                ].map(([label, result, suffix]) => (
                  <article className="metric" key={label}>
                    <span>{label}</span>
                    <strong>{result}</strong>
                    <small>{suffix}</small>
                  </article>
                ))}
              </section>
              <div className="analysis-chart-grid">
                {(["histogram", "ecdf", "series", "boxplot"] as const).map(
                  (kind) => (
                    <section className="panel chart-panel" key={kind}>
                      <div className="section-heading">
                        <div>
                          <h2>{plotTitles[kind]}</h2>
                          <p>
                            {kind === "histogram"
                              ? stats.histogram_method
                              : kind === "boxplot"
                                ? `Cercas: Q1 − 1,5 RIC y Q3 + 1,5 RIC · ${stats.boxplot?.outlier_count ?? 0} valores señalados, conservados`
                                : kind === "ecdf"
                                  ? "F(x) = número de observaciones ≤ x / n"
                                  : `${variableNames[stats.variable]} · ${unit}`}
                          </p>
                        </div>
                      </div>
                      <StatisticsChart stats={stats} kind={kind} />
                    </section>
                  ),
                )}
              </div>
              <section className="panel table-panel">
                <div className="section-heading">
                  <div>
                    <h2>Medidas descriptivas y percentiles</h2>
                    <p>
                      Interpolación lineal: h = (n − 1)p. Los percentiles no son
                      intervalos de confianza.
                    </p>
                  </div>
                </div>
                <div className="analysis-summary-grid">
                  <table>
                    <caption className="sr-only">
                      Medidas descriptivas de la variable seleccionada
                    </caption>
                    <thead>
                      <tr>
                        <th>Medida</th>
                        <th className="numeric">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["Mínimo", value(stats.summary.minimum)],
                        ["Máximo", value(stats.summary.maximum)],
                        ["Amplitud", value(stats.summary.range)],
                        [
                          "Varianza poblacional · divisor n",
                          variance(stats.summary.population_variance),
                        ],
                        [
                          "Varianza muestral · divisor n − 1",
                          variance(stats.summary.sample_variance),
                        ],
                        [
                          "Rango intercuartílico (Q3 − Q1)",
                          value(stats.summary.iqr),
                        ],
                        [
                          "Coeficiente de variación",
                          stats.summary.coefficient_variation_pct === null
                            ? "No aplicable"
                            : `${decimal.format(stats.summary.coefficient_variation_pct)} %`,
                        ],
                      ].map(([label, result]) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td className="numeric">{result}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <table>
                    <caption className="sr-only">
                      Percentiles de la variable seleccionada
                    </caption>
                    <thead>
                      <tr>
                        <th>Percentil</th>
                        <th className="numeric">{unit}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(stats.summary.percentiles).map(
                        ([name, result]) => (
                          <tr key={name}>
                            <td>
                              {name.toUpperCase()}
                              {name === "p25"
                                ? " · Q1"
                                : name === "p75"
                                  ? " · Q3"
                                  : name === "p50"
                                    ? " · Mediana"
                                    : ""}
                            </td>
                            <td className="numeric">{value(result)}</td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="convention analysis-table-note">
                  Las medidas de dispersión usan {unit}; las varianzas,{" "}
                  {stats.unit === "COP/USD"
                    ? "(COP/USD)²"
                    : "puntos porcentuales al cuadrado"}
                  . Para rendimientos no se interpreta el CV porque su media
                  puede ser cero o negativa.
                </p>
              </section>
              <section className="panel table-panel">
                <details className="frequency-details">
                  <summary>
                    Tabla de frecuencias · {stats.histogram.length} clases ·{" "}
                    {number.format(stats.summary.count)} observaciones
                  </summary>
                  <p className="convention">
                    Clases [inferior, superior), salvo la última, que incluye el
                    extremo superior.
                  </p>
                  <div
                    className="table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Resultados de la tabla"
                  >
                    <table>
                      <caption className="sr-only">
                        Frecuencias absolutas, relativas y acumuladas
                      </caption>
                      <thead>
                        <tr>
                          <th>Intervalo · {unit}</th>
                          <th className="numeric">Absoluta</th>
                          <th className="numeric">Relativa</th>
                          <th className="numeric">Acumulada</th>
                          <th className="numeric">Relativa acumulada</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.histogram.map((bin, index) => (
                          <tr key={index}>
                            <td>
                              [{value(bin.lower)}; {value(bin.upper)}
                              {bin.right_closed ? "]" : ")"}
                            </td>
                            <td className="numeric">{bin.frequency}</td>
                            <td className="numeric">
                              {percent(bin.relative_frequency)}
                            </td>
                            <td className="numeric">
                              {bin.cumulative_frequency}
                            </td>
                            <td className="numeric">
                              {percent(bin.cumulative_probability)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </section>
            </>
          )}
          <section className="panel chart-panel">
            <div className="section-heading">
              <div>
                <h2>Volatilidad histórica sin anualizar</h2>
                <p>{stats.volatility.convention}</p>
              </div>
              <div className="volatility-value">
                <strong>{percent(stats.volatility.historical)}</strong>
                <small>σ logarítmica por transición</small>
              </div>
            </div>
            {stats.volatility.points.some((point) => point.value !== null) ? (
              <StatisticsChart stats={stats} kind="volatility" />
            ) : (
              <p className="analysis-table-note convention">
                No hay un tramo con {stats.volatility.rolling_window}{" "}
                rendimientos contiguos para dibujar la volatilidad móvil.
              </p>
            )}
            <p className="analysis-table-note convention">
              La desviación de niveles de TRM mide dispersión de precios; la
              volatilidad mide dispersión de rendimientos logarítmicos. La
              dependencia temporal y los cambios de régimen limitan cualquier
              extrapolación.
            </p>
          </section>
          <details className="panel analysis-audit">
            <summary>Procedimiento y trazabilidad del cálculo</summary>
            <p>{stats.convention}</p>
            <div className="formula">
              Rₜ = Pₜ / Pₜ₋₁ − 1 · rₜ = ln(Pₜ / Pₜ₋₁) · Rₜ = exp(rₜ) − 1<br />
              s² = Σ(xᵢ − x̄)² / (n − 1) · σ = s(rₜ)
            </div>
            <p>
              El ajuste n − 1 se usa para la varianza muestral. No demuestra
              independencia de las observaciones ni normalidad de los
              rendimientos. Las cercas del diagrama de caja identifican valores
              extremos estadísticos, sin eliminarlos.
            </p>
            <p>
              Fuente: {stats.source}
              <br />
              Corte: {shortDate(stats.cutoff_date)} · Cálculo:{" "}
              {timestamp(stats.calculated_at)}
              <br />
              Algoritmo: {stats.model_version} · NumPy {stats.numpy_version}
            </p>
            <code>{stats.dataset_fingerprint}</code>
          </details>
        </>
      )}
    </div>
  );
}
