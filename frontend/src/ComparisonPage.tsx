import { useEffect, useState } from "react";
import { request, queryString } from "./api";
import {
  initialPeriod as defaultPeriod,
  periodBounds,
} from "./comparisonPeriods";
import type { PeriodSelection } from "./comparisonPeriods";
import ComparisonChart from "./ComparisonChart";
import ExportButton from "./ExportButton";
import MethodNote from "./MethodNote";
import { money, number, shortDate, timestamp } from "./format";
import type {
  Comparison,
  ComparisonAlignment,
  ComparisonMetric,
  ComparisonPoint,
  ComparisonScale,
} from "./types";

const metricLabels: Record<ComparisonMetric, string> = {
  count: "Registros de vigencia",
  mean: "Media",
  median: "Mediana",
  minimum: "Mínimo",
  maximum: "Máximo",
  sample_std: "Desviación muestral de niveles",
  initial_value: "Primer valor",
  final_value: "Último valor",
  absolute_change: "Cambio absoluto entre extremos",
  relative_change: "Variación relativa entre extremos",
  cumulative_return: "Rendimiento acumulado",
  volatility: "Volatilidad logarítmica sin anualizar",
};
const decimal = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 6 });
const percent = (value: number | null) =>
  value === null ? "—" : `${decimal.format(value * 100)} %`;
const monthNames = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

function PeriodFields({
  id,
  selection,
  years,
  onChange,
}: {
  id: "A" | "B";
  selection: PeriodSelection;
  years: number[];
  onChange: (selection: PeriodSelection) => void;
}) {
  const update = (field: keyof PeriodSelection, value: string) =>
    onChange({ ...selection, [field]: value });
  return (
    <fieldset className={`comparison-period period-${id.toLowerCase()}`}>
      <legend>
        Periodo {id} · {id === "A" ? "referencia" : "comparación"}
      </legend>
      <label>
        Tipo de periodo {id}
        <select
          value={selection.mode}
          onChange={(event) => update("mode", event.target.value)}
        >
          <option value="year">Año completo</option>
          <option value="month">Mes</option>
          <option value="range">Rango personalizado</option>
        </select>
      </label>
      <div className="filters">
        {selection.mode !== "range" ? (
          <>
            <label>
              Año del periodo {id}
              <select
                value={selection.year}
                onChange={(event) => update("year", event.target.value)}
              >
                <option value="">Seleccione un año</option>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
            {selection.mode === "month" && (
              <label>
                Mes del periodo {id}
                <select
                  value={selection.month}
                  onChange={(event) => update("month", event.target.value)}
                >
                  {monthNames.map((name, index) => (
                    <option key={name} value={index + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        ) : (
          <>
            <label>
              Inicio del periodo {id}
              <input
                type="date"
                value={selection.start}
                onChange={(event) => update("start", event.target.value)}
              />
            </label>
            <label>
              Fin del periodo {id}
              <input
                type="date"
                value={selection.end}
                onChange={(event) => update("end", event.target.value)}
              />
            </label>
          </>
        )}
      </div>
    </fieldset>
  );
}

function parameters(
  a: PeriodSelection,
  b: PeriodSelection,
  alignment: ComparisonAlignment,
) {
  const first = periodBounds(a),
    second = periodBounds(b);
  return {
    a_start: first.start,
    a_end: first.end,
    b_start: second.start,
    b_end: second.end,
    alignment,
  };
}

export default function ComparisonPage({
  years,
  refresh,
  initialPeriod,
}: {
  years: number[];
  refresh: number | string;
  initialPeriod?: { start: string; end: string } | null;
}) {
  const [a, setA] = useState(() =>
    initialPeriod
      ? { mode: "range" as const, year: "", month: "1", ...initialPeriod }
      : defaultPeriod(years[1] ?? years[0]),
  );
  const [b, setB] = useState(() => defaultPeriod(years[0]));
  const [alignment, setAlignment] =
    useState<ComparisonAlignment>("observation");
  const [scale, setScale] = useState<ComparisonScale>("normalized");
  const [submitted, setSubmitted] = useState(() =>
    years.length ? parameters(a, b, alignment) : null,
  );
  const [revision, setRevision] = useState(0);
  const [tablePage, setTablePage] = useState(1);
  const [response, setResponse] = useState<{
    key: string;
    data: Comparison | null;
    error: string;
  } | null>(null);
  const draft = parameters(a, b, alignment);
  const invalid =
    !draft.a_start || !draft.a_end || !draft.b_start || !draft.b_end
      ? "Complete las fechas de ambos periodos."
      : draft.a_start > draft.a_end
        ? "El periodo A tiene las fechas invertidas."
        : draft.b_start > draft.b_end
          ? "El periodo B tiene las fechas invertidas."
          : "";
  const query = submitted ? queryString(submitted) : "";
  const key = `${query}|${refresh}|${revision}`;
  const loading = Boolean(query && response?.key !== key);
  const data = response?.key === key && !invalid ? response.data : null;
  const error = response?.key === key ? response.error : "";
  const dirty = queryString(draft) !== query;

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    request<Comparison>(`/trm/comparison?${query}`, {
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

  function submit() {
    setSubmitted(draft);
    setRevision((value) => value + 1);
    setTablePage(1);
  }
  function reset() {
    const first = defaultPeriod(years[1] ?? years[0]),
      second = defaultPeriod(years[0]);
    setA(first);
    setB(second);
    setAlignment("observation");
    setScale("normalized");
    setTablePage(1);
    setSubmitted(
      years.length ? parameters(first, second, "observation") : null,
    );
    setRevision((value) => value + 1);
  }
  const formatPoint = (point: ComparisonPoint | null) =>
    point
      ? scale === "price"
        ? money(point.value)
        : decimal.format(point.normalized)
      : "—";
  const formatMetric = (value: number | null, unit: string, delta = false) =>
    value === null
      ? "—"
      : unit === "count"
        ? number.format(value)
        : unit === "fraction"
          ? `${decimal.format(value * 100)} ${delta ? "pp" : "%"}`
          : decimal.format(value);

  return (
    <div className="comparison-page">
      {initialPeriod && (
        <p className="period-continuity">
          El periodo A se inicializó desde el histórico. Puede modificar ambos
          intervalos antes de comparar.
        </p>
      )}
      <MethodNote title="Cómo interpretar la comparación y la base 100">
        <p>
          Se analizan todas las vigencias de cada intervalo. El índice es 100 ×
          Pᵢ/P₀, con el primer precio de cada periodo como referencia. La
          diferencia de indicadores es B − A.
        </p>
        <p>
          La alineación por observación compara posiciones, no fechas
          equivalentes. Los rendimientos se calculan solo entre vigencias
          contiguas; el cambio entre extremos no equivale a un rendimiento
          continuo cuando hay huecos.
        </p>
      </MethodNote>
      <form
        className="panel comparison-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) submit();
        }}
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">DOS PERIODOS · UNA CONVENCIÓN EXPLÍCITA</p>
            <h2>Comparar con contexto</h2>
            <p>
              Seleccione dos años, meses o rangos. A es la referencia y las
              diferencias se calculan como B − A.
            </p>
          </div>
        </div>
        <div className="comparison-periods">
          <PeriodFields id="A" selection={a} years={years} onChange={setA} />
          <PeriodFields id="B" selection={b} years={years} onChange={setB} />
        </div>
        <div className="comparison-actions">
          <label>
            Alineación temporal
            <select
              value={alignment}
              onChange={(event) =>
                setAlignment(event.target.value as ComparisonAlignment)
              }
            >
              <option value="observation">Número de observación</option>
              <option value="elapsed_days">
                Días calendario transcurridos
              </option>
            </select>
          </label>
          <button className="primary" type="submit" disabled={Boolean(invalid)}>
            Comparar periodos
          </button>
          <button type="button" className="reset-button" onClick={reset}>
            Restablecer comparación
          </button>
        </div>
        {invalid ? (
          <p className="comparison-validation" role="alert">
            {invalid}
          </p>
        ) : (
          dirty && (
            <p className="comparison-draft" role="status">
              Cambios sin aplicar. Pulse «Comparar periodos»; los resultados
              conservan sus fechas de consulta.
            </p>
          )
        )}
      </form>
      {loading && !invalid && (
        <div className="loading panel" role="status">
          <span className="spinner" />
          Comparando periodos locales…
        </div>
      )}
      {error && !invalid && (
        <div className="error-box" role="alert">
          <span>{error}</span>
          <button onClick={() => setRevision((value) => value + 1)}>
            Reintentar comparación
          </button>
        </div>
      )}
      {data && (
        <>
          <div className="module-export">
            <ExportButton
              path={`/exports/comparison?${query}`}
              filename="SIMTRM_comparacion.xlsx"
              label="Excel de la comparación aplicada"
            />
          </div>
          <section className="panel analysis-interpretation">
            <span className="small-label">
              RESULTADOS HISTÓRICOS · MUESTRAS COMPLETAS
            </span>
            <h2>Lectura comparativa</h2>
            <p>{data.interpretation}</p>
          </section>
          <div className="comparison-periods result-periods">
            {(["a", "b"] as const).map((id) => (
              <section
                className={`panel comparison-period-summary period-${id}`}
                key={id}
              >
                <span className="small-label">PERIODO {id.toUpperCase()}</span>
                <h2>
                  {shortDate(data[id].requested_start)} —{" "}
                  {shortDate(data[id].requested_end)}
                </h2>
                <p>
                  {number.format(data[id].metrics.count)} registros ·{" "}
                  {number.format(data[id].return_count)} rendimientos válidos
                </p>
                <p className="convention">
                  Cobertura observada: {shortDate(data[id].observed_start)} a{" "}
                  {shortDate(data[id].observed_end)}
                </p>
                {data[id].warnings.length > 0 && (
                  <ul className="period-warnings">
                    {data[id].warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          {data.warnings.length > 0 && (
            <aside
              className="analysis-warnings"
              aria-label="Limitaciones de la comparación"
            >
              <ul>
                {data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </aside>
          )}
          {data.a.metrics.count || data.b.metrics.count ? (
            <>
              <section className="panel chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Evolución superpuesta</h2>
                    <p>
                      {data.alignment === "observation"
                        ? "Misma posición de observación; puede corresponder a días distintos."
                        : "Días calendario desde el inicio solicitado de cada periodo; incluye años bisiestos."}
                    </p>
                  </div>
                  <label>
                    Escala del gráfico
                    <select
                      value={scale}
                      onChange={(event) =>
                        setScale(event.target.value as ComparisonScale)
                      }
                    >
                      <option value="normalized">Índice base 100</option>
                      <option value="price">Niveles · COP/USD</option>
                    </select>
                  </label>
                </div>
                <ComparisonChart
                  comparison={data}
                  scale={scale}
                  kind="overlay"
                />
                <p className="convention analysis-table-note">
                  Base 100 = P / primer valor válido de cada periodo × 100.{" "}
                  {data.alignment === "elapsed_days"
                    ? "Los tramos horizontales conservan vigencias extendidas, sin crear observaciones diarias."
                    : "Cada punto corresponde a un registro original de vigencia."}{" "}
                  Los huecos no se conectan. La escala del gráfico no cambia los
                  indicadores calculados sobre los precios originales.
                </p>
              </section>
              <section className="panel table-panel">
                <div className="section-heading">
                  <div>
                    <h2>Indicadores y diferencias</h2>
                    <p>
                      Todos los registros de cada periodo, sin limitarse a las
                      posiciones compartidas.
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
                      Comparación de indicadores, diferencias absolutas y
                      relativas
                    </caption>
                    <thead>
                      <tr>
                        <th>Indicador</th>
                        <th>Unidad</th>
                        <th className="numeric">Periodo A</th>
                        <th className="numeric">Periodo B</th>
                        <th className="numeric">B − A</th>
                        <th className="numeric">Diferencia relativa</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.differences.map((row) => (
                        <tr key={row.metric}>
                          <td>{metricLabels[row.metric]}</td>
                          <td>
                            {row.unit === "fraction"
                              ? "%; diferencias en pp"
                              : row.unit === "count"
                                ? "registros"
                                : "COP/USD"}
                          </td>
                          <td className="numeric">
                            {formatMetric(row.a, row.unit)}
                          </td>
                          <td className="numeric">
                            {formatMetric(row.b, row.unit)}
                          </td>
                          <td className="numeric">
                            {formatMetric(row.delta, row.unit, true)}
                          </td>
                          <td className="numeric">
                            {percent(row.relative_delta)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="convention analysis-table-note">
                  Diferencia relativa = (B / A − 1) × 100, solo para niveles y
                  desviación de precios con A &gt; 0. «—» indica un cálculo no
                  disponible. La volatilidad usa rendimientos logarítmicos
                  contiguos, ddof = 1 y no se anualiza. La variación entre
                  extremos coincide con el rendimiento acumulado únicamente
                  cuando la cadena observada es continua.
                </p>
              </section>
              <section className="panel chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Niveles centrales y extremos</h2>
                    <p>Indicadores de precios originales en COP/USD.</p>
                  </div>
                </div>
                <ComparisonChart comparison={data} scale="price" kind="bars" />
              </section>
              <section className="panel table-panel">
                <div className="section-heading">
                  <div>
                    <h2>Registros alineados</h2>
                    <p>
                      {data.rows.length} posiciones de inicio de registro ·{" "}
                      {data.paired_positions} compartidas ·{" "}
                      {scale === "price" ? "COP/USD" : "índice base 100"}
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
                      Registros originales alineados por{" "}
                      {data.alignment === "observation"
                        ? "observación"
                        : "días transcurridos"}
                    </caption>
                    <thead>
                      <tr>
                        <th>
                          {data.alignment === "observation"
                            ? "Observación"
                            : "Días desde inicio"}
                        </th>
                        <th>Fecha A</th>
                        <th className="numeric">Valor A</th>
                        <th>Fecha B</th>
                        <th className="numeric">Valor B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows
                        .slice((tablePage - 1) * 20, tablePage * 20)
                        .map((row) => (
                          <tr key={row.position}>
                            <td>{row.position}</td>
                            <td>{shortDate(row.a?.effective_date)}</td>
                            <td className="numeric">{formatPoint(row.a)}</td>
                            <td>{shortDate(row.b?.effective_date)}</td>
                            <td className="numeric">{formatPoint(row.b)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>
                    Página {tablePage} de{" "}
                    {Math.max(1, Math.ceil(data.rows.length / 20))}
                  </span>
                  <div>
                    <button
                      disabled={tablePage === 1}
                      onClick={() => setTablePage((value) => value - 1)}
                    >
                      Anterior comparación
                    </button>
                    <button
                      disabled={tablePage * 20 >= data.rows.length}
                      onClick={() => setTablePage((value) => value + 1)}
                    >
                      Siguiente comparación
                    </button>
                  </div>
                </div>
                <p className="convention analysis-table-note">
                  La tabla une inicios de registro. Una celda vacía puede
                  corresponder a una vigencia extendida sin un registro nuevo en
                  esa posición; no implica por sí sola un hueco de cobertura. No
                  se interpolan ni rellenan posiciones. La paginación es solo
                  visual.
                </p>
              </section>
            </>
          ) : (
            <div className="empty-state panel">
              <h2>No hay datos para estos periodos</h2>
              <p>
                Seleccione fechas dentro de la cobertura histórica disponible.
              </p>
            </div>
          )}
          <details className="panel analysis-audit">
            <summary>Metodología y trazabilidad de la comparación</summary>
            <p>{data.convention}</p>
            <p>
              Fuente: {data.source}
              <br />
              Corte: {shortDate(data.cutoff_date)} · Cálculo:{" "}
              {timestamp(data.calculated_at)}
              <br />
              Algoritmo: {data.model_version}
            </p>
            <p>
              Huella del periodo A: <code>{data.a.dataset_fingerprint}</code>
              <br />
              Huella del periodo B: <code>{data.b.dataset_fingerprint}</code>
            </p>
            <code>{data.dataset_fingerprint}</code>
          </details>
        </>
      )}
    </div>
  );
}
