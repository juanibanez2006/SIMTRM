import { useEffect, useRef, useState } from "react";
import { request, queryString } from "./api";
import { money, number, shortDate, timestamp } from "./format";
import HistoryChart from "./HistoryChart";
import StatisticsPage from "./StatisticsPage";
import ComparisonPage from "./ComparisonPage";
import SimulationPage from "./SimulationPage";
import BacktestPage from "./BacktestPage";
import ExportsPage from "./ExportsPage";
import ExportButton from "./ExportButton";
import useLocalData from "./useLocalData";
import { quickPeriod, selectedBounds } from "./periodFilters";
import type { Filters, History, Series } from "./types";

const blankFilters: Filters = { year: "", month: "", start: "", end: "" };
type Page =
  | "home"
  | "history"
  | "statistics"
  | "comparison"
  | "simulation"
  | "backtest"
  | "exports"
  | "source"
  | "method";
const navigation: { id: Page; icon: string; title: string }[] = [
  { id: "home", icon: "◫", title: "Vista general" },
  { id: "history", icon: "↗", title: "Histórico de TRM" },
  { id: "comparison", icon: "⇄", title: "Comparar periodos" },
  { id: "statistics", icon: "σ", title: "Análisis estadístico" },
  { id: "simulation", icon: "⤨", title: "Simulador" },
  { id: "backtest", icon: "✓", title: "Validación retrospectiva" },
  { id: "exports", icon: "↓", title: "Exportaciones" },
  { id: "source", icon: "▤", title: "Calidad de datos" },
  { id: "method", icon: "ⓘ", title: "Metodología y fuentes" },
];
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

function pageFromHash(): Page {
  const candidate = window.location.hash.slice(1);
  return navigation.some((item) => item.id === candidate)
    ? (candidate as Page)
    : "home";
}

function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {retry && <button onClick={retry}>Reintentar</button>}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef(page);
  const [filters, setFilters] = useState<Filters>(blankFilters);
  const [tablePage, setTablePage] = useState(1);
  const [sort, setSort] = useState("date");
  const [direction, setDirection] = useState("desc");
  const [tableResult, setTableResult] = useState<{
    key: string;
    data: History | null;
    error: string;
  } | null>(null);
  const [seriesResult, setSeriesResult] = useState<{
    key: string;
    filter: string;
    data: Series | null;
    error: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const { status, latest, years, metadataError, revision, today } =
    useLocalData(refresh);
  const dataRefresh = `${refresh}|${revision}|${today}`;
  const [syncing, setSyncing] = useState(false);
  const [syncMode, setSyncMode] = useState("incremental");
  const [adminToken, setAdminToken] = useState("");
  const [sharedPeriod, setSharedPeriod] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [syncError, setSyncError] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const filterQuery = queryString({ ...filters });
  const invalidRange = Boolean(
    filters.start && filters.end && filters.start > filters.end,
  );
  const tableQuery = queryString({
    ...filters,
    page: tablePage,
    page_size: 20,
    sort,
    direction,
  });
  const queryKey = `${tableQuery}|${dataRefresh}`;
  const seriesKey = `${filterQuery}|${dataRefresh}`;
  const tableLoading = !invalidRange && tableResult?.key !== queryKey;
  const loading = !invalidRange && seriesResult?.key !== seriesKey;
  const history = tableResult?.key === queryKey ? tableResult.data : null;
  const series =
    seriesResult?.filter === filterQuery ? seriesResult.data : null;
  const error = seriesResult?.key === seriesKey ? seriesResult.error : "";
  const tableError = tableResult?.key === queryKey ? tableResult.error : "";
  const historicalPage = page === "home" || page === "history";
  const hasMetadata = status !== null;

  function navigate(next: Page) {
    if (next === page) return;
    window.history.pushState(null, "", `#${next}`);
    setPage(next);
  }

  useEffect(() => {
    const updatePage = () => setPage(pageFromHash());
    window.addEventListener("hashchange", updatePage);
    return () => window.removeEventListener("hashchange", updatePage);
  }, []);

  useEffect(() => {
    document.title = `SIMTRM · ${navigation.find((item) => item.id === page)?.title}`;
    if (previousPage.current !== page) {
      heading.current?.focus();
      heading.current?.scrollIntoView?.({ block: "start" });
      previousPage.current = page;
    }
  }, [page]);

  useEffect(() => {
    if (invalidRange || !historicalPage || !hasMetadata) return;
    const controller = new AbortController();
    request<Series>(`/trm/series?${filterQuery}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          setSeriesResult({
            key: seriesKey,
            filter: filterQuery,
            data,
            error: "",
          });
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted)
          setSeriesResult((previous) => ({
            key: seriesKey,
            filter: filterQuery,
            data: previous?.filter === filterQuery ? previous.data : null,
            error: err.message,
          }));
      });
    return () => controller.abort();
  }, [filterQuery, seriesKey, invalidRange, historicalPage, hasMetadata]);

  useEffect(() => {
    if (invalidRange || !historicalPage || !hasMetadata) return;
    const controller = new AbortController();
    request<History>(`/trm/history?${tableQuery}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          setTableResult({ key: queryKey, data, error: "" });
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted)
          setTableResult({ key: queryKey, data: null, error: err.message });
      });
    return () => controller.abort();
  }, [tableQuery, queryKey, invalidRange, historicalPage, hasMetadata]);

  function updateFilter(key: keyof Filters, value: string) {
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === "year" ? { month: "" } : {}),
    }));
    setTablePage(1);
  }

  async function synchronize() {
    setSyncing(true);
    setSyncError("");
    setSyncMessage("");
    try {
      await request("/data/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { "X-Admin-Token": adminToken } : {}),
        },
        body: JSON.stringify({ mode: syncMode }),
      });
      setSyncMessage(
        "Consulta completada. Puede revisar los registros disponibles.",
      );
    } catch (err) {
      setSyncError(
        err instanceof Error ? err.message : "No fue posible actualizar la información",
      );
    } finally {
      setSyncing(false);
      setRefresh((current) => current + 1);
    }
  }

  const currentRecord = latest?.record;
  const hasResults = !invalidRange && series && series.count > 0;
  const periodLabel = filters.year
    ? `Año ${filters.year}${filters.month ? ` · ${monthNames[Number(filters.month) - 1]}` : ""}`
    : "Todo el histórico";
  const latestLabel =
    latest?.state === "current"
      ? "Vigente hoy"
      : latest?.state === "stale"
        ? "Último dato · desactualizado"
        : latest?.state === "future"
          ? "Vigencia futura"
          : "Sin datos oficiales";
  const sourceFailure = status?.state === "source_error";
  const lastDate =
    status?.last?.valid_to && status.last.valid_to < today
      ? status.last.valid_to
      : today;

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main");
          main?.focus();
          main?.scrollIntoView?.({ block: "start" });
        }}
      >
        Ir al contenido
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("home");
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            S<span>↗</span>
          </span>
          <span>
            SIMTRM<small>OBSERVATORIO USD / COP</small>
          </span>
        </a>
        <p className="nav-label">ESPACIO DE ANÁLISIS</p>
        <nav aria-label="Navegación principal">
          {navigation.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "active" : ""}
              onClick={() => navigate(item.id)}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="small-label">PROYECTO ACADÉMICO</span>
          <p>
            Del dato oficial
            <br />
            al análisis reproducible.
          </p>
          <span className="phase-tag">Análisis · Simulación · Validación</span>
        </div>
        <div className="institution">
          Universidad Piloto de Colombia
          <small>Seccional Alto Magdalena · 2026-II</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            SIMTRM{" "}
            <span className="breadcrumb">
              / {navigation.find((item) => item.id === page)?.title}
            </span>
          </span>
          <span className="local-badge">
            <i />
            TRM · USD/COP
          </span>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">TASA REPRESENTATIVA DEL MERCADO</p>
              <h1 ref={heading} tabIndex={-1}>
                {page === "home"
                  ? "El dólar, en perspectiva."
                  : navigation.find((item) => item.id === page)?.title}
              </h1>
              <p className="subtitle">
                Sistema de Análisis y Simulación de la Tasa Representativa del
                Mercado.
              </p>
            </div>
            <span className="currency-pair">
              USD <span>→</span> COP
            </span>
          </div>
          {metadataError && (
            <ErrorBox
              message={
                status?.total
                  ? `${metadataError} Se muestran los últimos datos disponibles con las fechas de vigencia indicadas.`
                  : metadataError
              }
              retry={() => setRefresh((current) => current + 1)}
            />
          )}

          {status && (
            <aside
              className="panel update-strip"
              aria-label="Estado de actualización"
            >
              {status.last && (
                <p>
                  <strong>Último registro publicado:</strong>{" "}
                  {money(status.last.value)} COP/USD ·{" "}
                  {shortDate(status.last.valid_from)}
                  {status.last.extended
                    ? ` al ${shortDate(status.last.valid_to)}`
                    : ""}
                  {status.last.valid_from > today ? " · Vigencia futura" : ""}.
                </p>
              )}
              <p>
                <strong>Última actualización comprobada:</strong>{" "}
                {timestamp(status.last_success?.finished_at)}
              </p>
              <p>
                <strong>Última comprobación de la fuente:</strong>{" "}
                {status.last_attempt
                  ? `${timestamp(status.last_attempt.finished_at || status.last_attempt.started_at)} · ${{ success: "Validada", failed: "No completada", running: "En curso" }[status.last_attempt.status] || status.last_attempt.status}`
                  : "Sin comprobaciones registradas"}
              </p>
              <p>
                La TRM corresponde a un periodo de vigencia. La fecha de la
                comprobación indica cuándo se consultó la fuente oficial.
              </p>
              {sourceFailure && (
                <p className="update-warning" role="status">
                  No fue posible consultar información nueva.{" "}
                  {status.total && status.last
                    ? `Se muestran los últimos datos disponibles, con vigencia hasta el ${shortDate(status.last.valid_to)}.`
                    : "Todavía no hay registros disponibles. Intente actualizar la información más tarde."}
                </p>
              )}
            </aside>
          )}

          {page === "home" && (
            <details className="panel demo-guide">
              <summary>Guía de consulta y análisis</summary>
              <ol>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("source")}
                  >
                    Consultar procedencia, cobertura y última actualización.
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("history")}
                  >
                    Seleccionar un año y consultar su gráfico y registros.
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("statistics")}
                  >
                    Examinar precios, rendimientos y volatilidad del periodo.
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("comparison")}
                  >
                    Comparar dos periodos en COP o base 100.
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("simulation")}
                  >
                    Explorar escenarios Montecarlo y bootstrap.
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("backtest")}
                  >
                    Contrastar escenarios con datos posteriores al corte.
                  </button>
                </li>
                <li>
                  Descargar resultados en Excel y consultar los supuestos
                  en{" "}
                  <button
                    className="text-button"
                    onClick={() => navigate("method")}
                  >
                    Metodología y fuentes
                  </button>
                  .
                </li>
              </ol>
              <p>
                Guarde el identificador de cada experimento para volver a
                consultar sus parámetros, datos de entrenamiento y resultados.
              </p>
            </details>
          )}

          {(historicalPage || page === "statistics") && (
            <>
              <div className="source-strip">
                <span>
                  <i className={sourceFailure ? "dot amber" : "dot"} />
                  {sourceFailure
                    ? "Última comprobación no completada · datos disponibles"
                    : status?.total
                      ? "Superintendencia Financiera · Datos Abiertos Colombia"
                      : "Sin registros disponibles · consulte la fuente"}
                </span>
                <button
                  className="text-button"
                  onClick={() => navigate("source")}
                >
                  Ver procedencia <span aria-hidden="true">↗</span>
                </button>
              </div>

              {page === "home" && (
                <section
                  className="overview-grid"
                  aria-label="Última TRM disponible"
                >
                  <article className="latest-card">
                    <div className="card-top">
                      <span>
                        TRM{" "}
                        {latest?.state === "current"
                          ? "vigente"
                          : "más reciente disponible"}
                      </span>
                      <span
                        className={`badge ${latest?.state !== "current" ? "muted" : ""}`}
                      >
                        {latestLabel}
                      </span>
                    </div>
                    <div className="price">
                      <span>$</span>
                      {money(currentRecord?.value)}
                      <small>COP / USD</small>
                    </div>
                    <p className="validity">
                      Vigencia: {shortDate(currentRecord?.valid_from)}
                      {currentRecord?.extended && (
                        <> al {shortDate(currentRecord.valid_to)}</>
                      )}
                    </p>
                    <div className="change">
                      <strong>
                        {latest?.delta == null
                          ? "—"
                          : `${Number(latest.delta) > 0 ? "+" : ""}${money(latest.delta)} COP`}
                      </strong>
                      <span>
                        {latest?.variation_pct == null
                          ? ""
                          : `(${Number(latest.variation_pct) > 0 ? "+" : ""}${money(latest.variation_pct)} %)`}
                      </span>
                      <small>
                        frente al registro anterior
                        {latest?.previous
                          ? ` · ${shortDate(latest.previous.valid_from)}`
                          : ""}
                      </small>
                    </div>
                  </article>
                  <article className="context-card">
                    <span className="small-label">
                      UNA LECTURA DEL INDICADOR
                    </span>
                    <h2>
                      ¿Cuántos pesos cuesta
                      <br />
                      un dólar?
                    </h2>
                    <p>
                      Un aumento en USD/COP indica depreciación del peso. Una
                      reducción indica apreciación frente al dólar.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => navigate("method")}
                    >
                      Conocer la metodología <span aria-hidden="true">→</span>
                    </button>
                  </article>
                </section>
              )}

              <section
                className="panel filter-panel"
                aria-label="Filtros de consulta"
              >
                <div className="filter-title">
                  <span aria-hidden="true">⌁</span>
                  <strong>Explorar periodo</strong>
                </div>
                <div
                  className="quick-periods"
                  role="group"
                  aria-label="Periodos rápidos de consulta"
                >
                  {[
                    [1, "1 mes"],
                    [3, "3 meses"],
                    [6, "6 meses"],
                    [12, "1 año"],
                    [60, "5 años"],
                    [null, "Todo el histórico"],
                  ].map(([months, label]) => (
                    <button
                      key={String(label)}
                      type="button"
                      aria-pressed={
                        JSON.stringify(filters) ===
                        JSON.stringify(
                          quickPeriod(months as number | null, lastDate),
                        )
                      }
                      onClick={() => {
                        setFilters(
                          quickPeriod(months as number | null, lastDate),
                        );
                        setTablePage(1);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="filters">
                  <label>
                    Año
                    <select
                      value={filters.year}
                      onChange={(e) => updateFilter("year", e.target.value)}
                    >
                      <option value="">Todos los años</option>
                      {years.map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Mes
                    <select
                      disabled={!filters.year}
                      value={filters.month}
                      onChange={(e) => updateFilter("month", e.target.value)}
                    >
                      <option value="">Todos los meses</option>
                      {monthNames.map((month, index) => (
                        <option key={month} value={index + 1}>
                          {month}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Desde
                    <input
                      type="date"
                      value={filters.start}
                      onChange={(e) => updateFilter("start", e.target.value)}
                    />
                  </label>
                  <label>
                    Hasta
                    <input
                      type="date"
                      value={filters.end}
                      onChange={(e) => updateFilter("end", e.target.value)}
                    />
                  </label>
                  <button
                    className="reset-button"
                    onClick={() => {
                      setFilters(blankFilters);
                      setTablePage(1);
                    }}
                  >
                    Restablecer
                  </button>
                </div>
                <p className="period-continuity">
                  El periodo se conserva entre Histórico y Estadística. Los
                  accesos rápidos terminan en la última vigencia disponible
                  hasta hoy.
                </p>
                {hasResults && status?.first && (
                  <div className="period-actions">
                    <button
                      type="button"
                      onClick={() => navigate("statistics")}
                    >
                      Analizar este periodo
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSharedPeriod(
                          selectedBounds(
                            filters,
                            status.first!.valid_from,
                            lastDate,
                          ),
                        );
                        navigate("comparison");
                      }}
                    >
                      Usar como periodo A
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSharedPeriod(
                          selectedBounds(
                            filters,
                            status.first!.valid_from,
                            lastDate,
                          ),
                        );
                        navigate("simulation");
                      }}
                    >
                      Simular con este periodo
                    </button>
                  </div>
                )}
              </section>

              {historicalPage && (
                <div className="module-export">
                  <ExportButton
                    path={`/exports/history?${filterQuery}`}
                    filename="SIMTRM_historico.xlsx"
                    label="Excel del histórico seleccionado"
                    disabled={!hasResults}
                  />
                </div>
              )}
              {invalidRange && (
                <ErrorBox message="La fecha inicial debe ser anterior o igual a la final." />
              )}
              {page === "statistics" && !invalidRange && hasMetadata && (
                <StatisticsPage
                  periodQuery={filterQuery}
                  refresh={dataRefresh}
                />
              )}
              {historicalPage && error && (
                <ErrorBox
                  message={error}
                  retry={() => setRefresh((current) => current + 1)}
                />
              )}
              {historicalPage && !invalidRange && loading && !series && (
                <div className="loading panel" role="status">
                  <span className="spinner" />
                  Consultando registros…
                </div>
              )}
              {historicalPage && !invalidRange && loading && series && (
                <p className="period-continuity" role="status">
                  Actualizando el periodo seleccionado. Se conservan los últimos
                  resultados hasta completar la consulta.
                </p>
              )}
              {historicalPage &&
                !invalidRange &&
                !loading &&
                !error &&
                !series?.count && (
                  <div className="empty-state panel">
                    <span aria-hidden="true">↗</span>
                    <h2>
                      {status?.total
                        ? "No hay registros en este periodo"
                        : "El análisis comienza con datos reales"}
                    </h2>
                    <p>
                      {status?.total
                        ? "Pruebe con otro año o restablezca los filtros."
                        : "Descargue y valide el histórico oficial desde Calidad de datos."}
                    </p>
                    {!status?.total && (
                      <button
                        className="primary"
                        onClick={() => navigate("source")}
                      >
                        Preparar datos oficiales
                      </button>
                    )}
                  </div>
                )}

              {historicalPage && hasResults && (
                <>
                  <section
                    className="metric-grid"
                    aria-label="Indicadores del periodo"
                  >
                    {[
                      ["Promedio del periodo", money(series.mean), "COP / USD"],
                      ["Máximo observado", money(series.maximum), "COP / USD"],
                      ["Mínimo observado", money(series.minimum), "COP / USD"],
                      [
                        "Registros de vigencia",
                        number.format(series.count),
                        "sin repetir días de vigencia",
                      ],
                    ].map(([label, value, unit]) => (
                      <article className="metric" key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                        <small>{unit}</small>
                      </article>
                    ))}
                  </section>
                  <section className="panel chart-panel">
                    <div className="section-heading">
                      <div>
                        <h2>Evolución histórica de la TRM</h2>
                        <p>
                          {periodLabel} · {number.format(series.count)}{" "}
                          registros oficiales
                        </p>
                      </div>
                      <span className="chart-legend">
                        <i />
                        USD/COP
                      </span>
                    </div>
                    <HistoryChart
                      series={series}
                      periodKey={filterQuery || "all"}
                    />
                    <div className="chart-footnote">
                      <span>
                        El periodo de cálculo y exportación se conserva al
                        explorar el gráfico.
                      </span>
                      <span>Fuente: SFC / Datos Abiertos</span>
                    </div>
                    <p className="convention">
                      {series.convention} Los tramos extendidos conservan su
                      valor; los huecos no se interpolan.
                    </p>
                  </section>
                  <section className="panel table-panel">
                    <div className="section-heading">
                      <div>
                        <h2>Registros históricos</h2>
                        <p>
                          Vigencias originales, conservadas desde la fuente.
                        </p>
                      </div>
                      <div className="table-sort">
                        <label className="sr-only" htmlFor="sort">
                          Ordenar registros
                        </label>
                        <select
                          id="sort"
                          value={sort}
                          onChange={(e) => {
                            setSort(e.target.value);
                            setTablePage(1);
                          }}
                        >
                          <option value="date">Por fecha</option>
                          <option value="value">Por valor</option>
                        </select>
                        <button
                          aria-label={
                            direction === "desc"
                              ? "Cambiar a orden ascendente"
                              : "Cambiar a orden descendente"
                          }
                          onClick={() => {
                            setDirection((value) =>
                              value === "desc" ? "asc" : "desc",
                            );
                            setTablePage(1);
                          }}
                        >
                          {direction === "desc" ? "↓" : "↑"}
                        </button>
                      </div>
                    </div>
                    {tableError && (
                      <ErrorBox
                        message={tableError}
                        retry={() => setRefresh((current) => current + 1)}
                      />
                    )}
                    {tableLoading && (
                      <p className="analysis-table-note" role="status">
                        Consultando página de registros…
                      </p>
                    )}
                    <div
                      className="table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label="Tabla histórica desplazable"
                      aria-busy={tableLoading}
                    >
                      <table>
                        <caption className="sr-only">
                          TRM oficial del periodo seleccionado
                        </caption>
                        <thead>
                          <tr>
                            <th>Vigente desde</th>
                            <th>Vigente hasta</th>
                            <th className="numeric">TRM · COP/USD</th>
                            <th>Tipo de vigencia</th>
                            <th>Fuente</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history?.items.map((record) => (
                            <tr key={record.id}>
                              <td>{shortDate(record.valid_from)}</td>
                              <td>{shortDate(record.valid_to)}</td>
                              <td className="numeric value-cell">
                                {money(record.value)}
                              </td>
                              <td>
                                <span
                                  className={`table-badge ${record.extended ? "extended" : ""}`}
                                >
                                  {record.extended ? "Extendida" : "Un día"}
                                </span>
                              </td>
                              <td>
                                <a
                                  href={status?.source_url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  SFC <span aria-hidden="true">↗</span>
                                </a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {history && (
                      <div className="pagination">
                        <span>
                          {number.format(history.total)} registros · Página{" "}
                          {history.page} de {history.pages || 1}
                        </span>
                        <div>
                          <button
                            disabled={history.page <= 1}
                            onClick={() => setTablePage((value) => value - 1)}
                          >
                            ← Anterior
                          </button>
                          <button
                            disabled={history.page >= history.pages}
                            onClick={() => setTablePage((value) => value + 1)}
                          >
                            Siguiente →
                          </button>
                        </div>
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}

          {page === "comparison" &&
            (status ? (
              <ComparisonPage
                years={years}
                refresh={dataRefresh}
                initialPeriod={sharedPeriod}
              />
            ) : (
              !metadataError && (
                <div className="loading panel" role="status">
                  Consultando años disponibles…
                </div>
              )
            ))}

          {page === "simulation" &&
            (status && latest ? (
              <SimulationPage
                latest={latest}
                status={status}
                initialPeriod={sharedPeriod}
                prepareData={() => navigate("source")}
              />
            ) : (
              !metadataError && (
                <div className="loading panel" role="status">
                  Consultando datos del simulador…
                </div>
              )
            ))}

          {page === "backtest" &&
            (status && latest ? (
              <BacktestPage latest={latest} status={status} />
            ) : (
              !metadataError && (
                <div className="loading panel" role="status">
                  Consultando datos para validación…
                </div>
              )
            ))}
          {page === "exports" && <ExportsPage navigate={navigate} />}

          {page === "source" && (
            <>
              <section className="panel audit-panel">
                <div className="section-heading">
                  <div>
                    <h2>Procedencia y cobertura de la información</h2>
                    <p>
                      Serie oficial de la Superintendencia Financiera de
                      Colombia, publicada en Datos Abiertos Colombia. Consulte
                      su cobertura, vigencias y resultados de actualización.
                    </p>
                  </div>
                  <span className="outline-tag">32sa-8pi3</span>
                </div>
                <dl className="audit-grid">
                  <div>
                    <dt>Registros disponibles</dt>
                    <dd>{status ? number.format(status.total) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Primera vigencia</dt>
                    <dd>{shortDate(status?.first?.valid_from)}</dd>
                  </div>
                  <div>
                    <dt>Última vigencia</dt>
                    <dd>{shortDate(status?.last?.valid_to)}</dd>
                  </div>
                  <div>
                    <dt>Última actualización comprobada</dt>
                    <dd>{timestamp(status?.last_success?.finished_at)}</dd>
                  </div>
                  <div>
                    <dt>Actualización periódica</dt>
                    <dd>
                      {status?.auto_sync_enabled
                        ? `Cada ${status.auto_sync_interval_hours} horas`
                        : "Desactivada"}
                    </dd>
                  </div>
                  <div>
                    <dt>Próxima comprobación prevista</dt>
                    <dd>
                      {status?.next_auto_check_at
                        ? timestamp(status.next_auto_check_at)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Registros previstos / recibidos en la última actualización</dt>
                    <dd>
                      {status?.last_success
                        ? `${status.last_success.expected} / ${status.last_success.received}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Registros informados por la fuente</dt>
                    <dd>{status?.last_success?.audit.remote_total ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Resultado de la última comprobación</dt>
                    <dd>
                      {status?.last_attempt
                        ? {
                            success: "Validado",
                            failed: "Fallido",
                            running: "En curso",
                          }[status.last_attempt.status] ||
                          status.last_attempt.status
                        : "Sin comprobaciones registradas"}
                    </dd>
                  </div>
                  {[
                    "extended",
                    "gaps",
                    "overlaps",
                    "future_starts",
                    "extreme_changes",
                  ].map((key, index) => (
                    <div key={key}>
                      <dt>
                        {
                          [
                            "Vigencias extendidas",
                            "Huecos de cobertura",
                            "Solapamientos",
                            "Vigencias futuras",
                            "Cambios mayores al 10 %",
                          ][index]
                        }
                      </dt>
                      <dd>{status?.last_success?.audit[key] ?? "—"}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>Registros no aceptados / inconsistencias</dt>
                    <dd>
                      {status?.last_attempt
                        ? `${status.last_attempt.audit.rejected ?? 0} / ${status.last_attempt.audit.conflicts ?? 0}`
                        : "—"}
                    </dd>
                  </div>
                </dl>
                <p className="convention">
                  Fecha y hora en America/Bogota. Los valores extremos se
                  señalan y se conservan. Las vigencias futuras se identifican
                  sin declararlas vigentes hoy.
                </p>
                {status?.last_attempt?.error && (
                  <ErrorBox message="No fue posible completar la consulta de nuevas publicaciones. Intente actualizar la información más tarde." />
                )}
              </section>
              <section className="panel sync-panel">
                <div>
                  <p className="eyebrow">NUEVAS PUBLICACIONES</p>
                  <h2>Actualizar información</h2>
                  <p>
                    Consulte las nuevas publicaciones de Datos Abiertos Colombia.
                    Si la consulta no se completa, se conservan los registros
                    disponibles.
                  </p>
                </div>
                <div className="sync-controls">
                  <label>
                    Alcance de la actualización
                    <select
                      value={syncMode}
                      disabled={syncing}
                      onChange={(e) => setSyncMode(e.target.value)}
                    >
                      <option value="incremental">
                        Registros recientes
                      </option>
                      <option value="full">Histórico completo</option>
                    </select>
                  </label>
                  <button
                    className="primary"
                    disabled={syncing}
                    onClick={() => void synchronize()}
                  >
                    {syncing
                      ? "Consultando información…"
                      : "Comprobar nuevas publicaciones ↻"}
                  </button>
                </div>
                <details>
                  <summary>Autorización de actualización</summary>
                  <label>
                    Clave de actualización (si se requiere)
                    <input
                      type="password"
                      autoComplete="off"
                      value={adminToken}
                      onChange={(e) => setAdminToken(e.target.value)}
                    />
                  </label>
                </details>
                {syncing && (
                  <p role="status">
                    Consultando y verificando los registros oficiales. Puede
                    tardar unos minutos.
                  </p>
                )}
                {syncError && <ErrorBox message={syncError} />}
                {syncMessage && (
                  <p className="success-message" role="status">
                    {syncMessage}
                  </p>
                )}
              </section>
              <section className="panel audit-panel">
                <h2>Procedencia oficial</h2>
                <p>
                  {status?.source ||
                    "Superintendencia Financiera de Colombia · Datos Abiertos Colombia"}
                </p>
                <a
                  className="external-link"
                  href="https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3"
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir conjunto oficial de TRM ↗
                </a>
                <p>
                  Cada registro incluye el valor certificado y sus fechas de
                  vigencia. Las correcciones publicadas por la fuente se
                  incorporan conservando las versiones anteriores.
                </p>
              </section>
            </>
          )}

          {page === "method" && (
            <section className="panel methodology">
              <p className="eyebrow">METODOLOGÍA Y FUENTES</p>
              <h2>Conceptos y criterios del análisis</h2>
              <p>
                Proyecto de Simulación · Ingeniería de Sistemas · Universidad
                Piloto de Colombia, Seccional Alto Magdalena · 2026-II. Docente:
                Carlos David Moncada Beltrán.
              </p>
              <p>
                <strong>Autores:</strong> Wilfer Duvan Ruiz Romero, Maria Jose
                Castro Ortiz y Juan Camilo Ibañez Gaitan.
              </p>
              <p>
                La TRM expresa pesos colombianos por un dólar estadounidense
                (COP/USD). La Superintendencia Financiera de Colombia calcula y
                certifica este indicador; el Banco de la República facilita
                también su consulta y divulgación.
              </p>
              <h3>Vigencias y observaciones</h3>
              <p>
                Cada fila conserva el valor y las fechas inicial y final de la
                fuente. Una vigencia puede abarcar fines de semana y festivos:
                eso no representa datos faltantes. Dos vigencias consecutivas
                con el mismo precio se conservan como registros diferentes.
              </p>
              <h3>Filtros y promedios</h3>
              <p>
                Se incluyen los registros cuya vigencia intersecta el intervalo
                seleccionado. La media, el máximo y el mínimo se calculan sobre
                todos esos registros, sin ponderarlos por días calendario. La
                tabla se pagina; los cálculos y el gráfico usan el conjunto
                filtrado completo.
              </p>
              <h3>Variación entre registros</h3>
              <div className="formula">
                Δ = P actual − P anterior
                <br />
                Variación (%) = (P actual / P anterior − 1) × 100
              </div>
              <p>
                La tarjeta de última TRM usa el registro más reciente con inicio
                de vigencia no posterior a hoy. Solo se muestra «Vigente hoy» si
                la fecha actual está dentro de su vigencia. Su variación se
                compara con el registro original anterior y no depende del
                filtro del gráfico.
              </p>
              <h3>Calidad y disponibilidad de la información</h3>
              <p>
                Antes de incorporar información se comprueban valores,
                cobertura y vigencias. Si la fuente no está disponible, puede
                consultar los registros obtenidos en la última actualización
                satisfactoria, cuya fecha se muestra en la aplicación.
              </p>
              <p>
                La consulta de registros recientes también revisa publicaciones
                anteriores que pueden haber sido corregidas. Para contrastar
                correcciones más antiguas, seleccione Histórico completo en
                Calidad de datos.
              </p>
              <h3>Alcance e interpretación</h3>
              <p>
                Los análisis describen el comportamiento de la TRM en los
                periodos seleccionados. Las simulaciones representan escenarios
                condicionados a una muestra y a supuestos estadísticos; no son
                predicciones garantizadas ni recomendaciones de inversión.
              </p>
              <h3>Rendimientos, dispersión y distribuciones</h3>
              <p>
                Los rendimientos simples y logarítmicos se calculan entre pares
                de registros seleccionados con vigencias contiguas, sin traer
                observaciones fuera del filtro. Las transiciones a través de
                huecos se excluyen explícitamente. Los precios iguales producen
                rendimientos cero y se conservan. Los registros con inicio de
                vigencia posterior al corte de hoy se excluyen del análisis.
              </p>
              <div className="formula">
                Rₜ = Pₜ / Pₜ₋₁ − 1<br />
                rₜ = ln(Pₜ / Pₜ₋₁)
                <br />
                s² = Σ(xᵢ − x̄)² / (n − 1) · σ = s(rₜ)
              </div>
              <p>
                La varianza poblacional divide entre n; la muestral, entre n − 1
                y requiere al menos dos datos. Los percentiles usan
                interpolación lineal con índice h = (n − 1)p. El histograma usa
                clases de igual amplitud (Sturges o cantidad seleccionada). La
                distribución acumulada empírica cuenta observaciones menores o
                iguales a x; las repeticiones aportan toda su frecuencia.
              </p>
              <p>
                La volatilidad se calcula sobre rendimientos logarítmicos por
                transición de vigencia. No se anualiza con √252 porque la
                duración calendario de las observaciones varía. La volatilidad
                móvil usa ventanas de rendimientos contiguos y reinicia la
                ventana ante huecos. Las cercas de Tukey (1,5 veces el rango
                intercuartílico) señalan valores extremos, sin excluirlos.
              </p>
              <h3>Comparación de periodos y base 100</h3>
              <p>
                Se seleccionan dos años, meses o rangos independientes. El
                índice base 100 se obtiene como (P / primer precio válido de
                cada selección) × 100. Los indicadores siguen calculándose sobre
                todos los precios originales, sin ponderación por duración ni
                recorte a las posiciones compartidas.
              </p>
              <p>
                La alineación por número de observación compara posiciones de
                registro, no días equivalentes. Por días calendario, el cero es
                la fecha inicial solicitada y se respetan los años bisiestos y
                las vigencias extendidas. Las posiciones sin inicio de registro
                quedan vacías; no se rellenan ni interpolan. Una celda vacía no
                prueba una falta de cobertura, ya que puede existir una vigencia
                extendida.
              </p>
              <p>
                Las diferencias se expresan como B − A. Las diferencias de
                rendimientos y volatilidad se muestran en puntos porcentuales.
                La variación entre el último y el primer precio coincide con el
                rendimiento acumulado si la cadena observada es continua; ante
                huecos, este último no se calcula. Las comparaciones son
                descriptivas y no prueban causalidad ni significancia
                estadística.
              </p>
              <h3>Simulación Montecarlo y bootstrap</h3>
              <p>
                El experimento define entrenamiento, fecha de corte, precio
                inicial, réplicas, pasos y semilla. La calibración utiliza solo
                registros que intersectan la ventana y comienzan hasta el final
                del entrenamiento, que no supera el corte. Se requieren dos
                rendimientos válidos como mínimo. No se convierten fines de
                semana ni festivos en observaciones independientes.
              </p>
              <div className="formula">
                Montecarlo: r simulado = μ + σZ, Z ~ N(0,1)
                <br />
                Bootstrap: remuestreo con reemplazo de r históricos
                <br />P siguiente = P × exp(r)
              </div>
              <p>
                Montecarlo estima μ como la media de los rendimientos
                logarítmicos y σ como su desviación muestral (divisor n − 1), y
                supone innovaciones normales independientes con parámetros
                constantes. Es un modelo discreto logarítmico: no se añade el
                ajuste de deriva propio de una calibración continua de
                movimiento browniano geométrico. Bootstrap no impone normalidad,
                pero su remuestreo independiente pierde dependencias temporales
                y agrupamiento de volatilidad.
              </p>
              <p>
                El horizonte se expresa en pasos del modelo, sin atribuirles
                fechas calendario futuras. Las curvas de media y mediana son
                resúmenes por paso; las bandas P5–P95 son percentiles marginales
                y no intervalos de confianza de parámetros ni garantías de
                cobertura futura. Las probabilidades cuentan eventos del precio
                terminal sobre todas las réplicas.
              </p>
              <p>
                Cada experimento conserva sus datos de entrenamiento, parámetros
                y resultados para su consulta y reproducción, incluso si la
                fuente se revisa. La reproducción exacta requiere la misma
                semilla, muestra, método y condiciones de cálculo.
              </p>
              <h3>Validación retrospectiva y diagnósticos</h3>
              <p>
                Se calibra hasta el corte inclusive y se evalúan los primeros
                registros nuevos posteriores, sin repetir días de vigencia
                extendida. La evaluación se detiene ante huecos. MAE es la media
                del error absoluto; RMSE es la raíz de la media del error al
                cuadrado; MAPE es la media del error absoluto dividido por la
                TRM real. La predicción puntual es la media de las réplicas y se
                compara con mantener constante el precio inicial. Sin datos
                suficientes, se identifica el resultado parcial y no se calcula
                error terminal del horizonte.
              </p>
              <p>
                La cobertura empírica cuenta observaciones reales dentro de
                P5–P95 y no es cobertura simultánea ni prueba de calibración
                perfecta. Una sola ventana no permite establecer superioridad
                general; conviene repetir otros cortes. Las muestras de
                entrenamiento y evaluación quedan guardadas y separadas.
              </p>
              <p>
                El diagnóstico del generador usa uniformes separados de las
                innovaciones del modelo. K-S utiliza D+ = max(i/n − U(i)) y D− =
                max(U(i) − (i−1)/n). Chi-cuadrado considera diez clases y la
                prueba de series usa 25 celdas de pares no solapados con
                esperados de al menos cinco. No rechazar H0 no demuestra
                uniformidad o independencia perfectas y un generador correcto
                puede ser rechazado ocasionalmente.
              </p>
              <p>
                La normalidad del entrenamiento se evalúa con D’Agostino–Pearson
                cuando hay al menos veinte rendimientos no constantes,
                considerando que su interpretación supone independencia. La
                correlación de rezago uno es descriptiva y no cruza huecos. No
                se usa K-S clásico para una normal ajustada con los mismos
                datos.
              </p>
              <h3>Libros Excel</h3>
              <p>
                Los archivos Excel contienen los resultados calculados, sus
                datos, filtros, recuentos, fuente y parámetros. Las fórmulas no
                se recalculan al editar el archivo. La paginación de
                pantalla no limita la descarga. Las simulaciones pueden incluir
                todas las matrices guardadas, no solo las trayectorias
                dibujadas. Si se solicita omitirlas, el libro lo declara. Las
                celdas vacías indican resultados no disponibles.
              </p>
              <div className="reference-links">
                <a
                  href="https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3"
                  target="_blank"
                  rel="noreferrer"
                >
                  Datos Abiertos Colombia ↗
                </a>
                <a
                  href="https://www.banrep.gov.co/es/como-consultar-datos-historicos-tasa-representativa-mercado-trm-nuevo-portal-estadisticas"
                  target="_blank"
                  rel="noreferrer"
                >
                  Consulta histórica del Banco de la República ↗
                </a>
              </div>
            </section>
          )}
          <footer>
            <span>SIMTRM · Información oficial, análisis con contexto.</span>
            <span>
              Última comprobación satisfactoria:{" "}
              {timestamp(status?.last_success?.finished_at)}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
