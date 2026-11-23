import { useMemo, useState } from "react";
import { request } from "./api";
import { money, shortDate } from "./format";
import PlotChart from "./PlotChart";
import SimulationChart from "./SimulationChart";
import ExportButton from "./ExportButton";
import ValidationResults from "./ValidationResults";
import SavedExperiments from "./SavedExperiments";
import { projectionPlot } from "./projectionPlot";
import {
  afterDays,
  defaultProjection,
  methodNames,
} from "./projectionSettings";
import type {
  Latest,
  Projection,
  ProjectionSettings,
  TrmRecord,
} from "./types";

const percent = (value: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);

export default function ProjectionPage({
  latest,
  lastPublished,
  firstAvailable,
  revision,
  onValidate,
  prepareData,
}: {
  latest: Latest;
  lastPublished?: TrmRecord | null;
  firstAvailable?: string;
  revision: string;
  onValidate?: (settings: ProjectionSettings) => void;
  prepareData?: () => void;
}) {
  const [settings, setSettings] =
    useState<ProjectionSettings>(defaultProjection);
  const [target, setTarget] = useState(afterDays(latest.today, 30));
  const [saved, setSaved] = useState<{
    result: Projection;
    revision: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("window");
  const [comparisons, setComparisons] = useState<Projection[]>([]);
  const [includePaths, setIncludePaths] = useState(false);
  const result = saved?.result;
  const changed =
    result &&
    (saved.revision !== revision ||
      (result.target_date ? target !== result.target_date : true) ||
      ["method", "training_records", "replicas", "seed", "training_start", "training_end",
        "volatility_scale", "threshold", "interval_low", "interval_high"].some(
        (key) =>
          settings[key as keyof ProjectionSettings] !==
          result.request[key as keyof ProjectionSettings],
      ));
  async function calculate(path = "/projections", recover = false) {
    setBusy(true);
    setError("");
    const submitted = revision;
    try {
      const next = await request<Projection>(
        path,
        recover
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...settings, target_date: target }),
            },
      );
      setSaved({ result: next, revision: recover ? "recovered" : submitted });
      setSettings(next.request);
      setPeriod(current => !recover && current === "all" ? "all" : next.request.training_start ? "dates" : "window");
      if (next.target_date) setTarget(next.target_date);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No fue posible calcular la proyección",
      );
    } finally {
      setBusy(false);
    }
  }
  async function reproduce() {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      const next = await request<Projection>(
        `/projections/${result.id}/replay`,
        { method: "POST" },
      );
      setSaved({ result: next, revision: saved.revision });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No fue posible reproducir el experimento",
      );
    } finally {
      setBusy(false);
    }
  }
  const plot = useMemo(
    () => (result?.points?.length ? projectionPlot(result) : null),
    [result],
  );
  const model = result?.experiment.methods[0];
  const pathsFitWorkbook = !!result && result.request.replicas * (result.request.horizon + 1) <= 400000;
  const probabilityLabels: Record<string, string> = {
    above_threshold: `Superar ${money(result?.experiment.threshold)} COP/USD`,
    below_threshold: `Estar por debajo de ${money(result?.experiment.threshold)} COP/USD`,
    within_interval: `Entre ${money(result?.request.interval_low)} y ${money(result?.request.interval_high)} COP/USD`,
  };
  return (
    <div className="projection-page">
      <section className="panel projection-input">
        <div className="projection-origin">
          <span className="small-label">TRM OFICIAL VIGENTE</span>
          <strong>
            {money(latest.record?.value)} <small>COP/USD</small>
          </strong>
          <p>
            {latest.record
              ? `Vigencia: ${shortDate(latest.record.valid_from)} al ${shortDate(latest.record.valid_to)}`
              : "No hay registros disponibles."}
          </p>
          <span
            className={`badge ${latest.state !== "current" ? "muted" : ""}`}
          >
            {latest.state === "current" ? "Vigente hoy" : "Sin TRM vigente hoy"}
          </span>
          {lastPublished && lastPublished.valid_from > latest.today && (
            <p>
              Última publicación: {money(lastPublished.value)} COP/USD, vigente
              desde {shortDate(lastPublished.valid_from)}. Se usa como
              referencia conocida cuando corresponde.
            </p>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void calculate();
          }}
        >
          <fieldset disabled={busy} className="projection-fields">
            <label>
              Fecha de proyección
              <input
                type="date"
                required
                min={afterDays(latest.today, 1)}
                max={afterDays(latest.today, 365)}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <div className="horizon-shortcuts" aria-label="Horizontes rápidos">
              {[15, 30, 60, 90].map(days => <button type="button" key={days}
                aria-pressed={target === afterDays(latest.today, days)}
                onClick={() => setTarget(afterDays(latest.today, days))}>{days} días</button>)}
            </div>
            <details className="projection-options">
              <summary>Parámetros del modelo</summary>
              <div className="simulation-input-grid">
                <label>
                  Método de proyección
                  <select
                    aria-label="Método de proyección"
                    value={settings.method}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        method: e.target.value as ProjectionSettings["method"],
                      }))
                    }
                  >
                    <option value="bootstrap">Bootstrap</option>
                    <option value="monte_carlo">Montecarlo</option>
                    <option value="arima">ARIMA(1,1,0)</option>
                  </select>
                </label>
                <label>
                  Periodo histórico
                  <select aria-label="Periodo histórico" value={period} onChange={e => {
                    setPeriod(e.target.value);
                    setSettings(s => ({...s,
                      training_start: e.target.value === 'all' ? firstAvailable : null,
                      training_end: e.target.value === 'all' ? latest.today : null}));
                  }}>
                    <option value="window">Últimas vigencias</option>
                    <option value="dates">Rango de fechas</option>
                    <option value="all" disabled={!firstAvailable}>Todo el histórico</option>
                  </select>
                </label>
                {period === "dates" ? <>
                  <label>Entrenamiento desde<input type="date" required
                    max={settings.training_end || latest.today} value={settings.training_start ?? ""}
                    onChange={e => setSettings(s => ({...s, training_start: e.target.value}))} /></label>
                  <label>Entrenamiento hasta<input type="date" required max={latest.today}
                    min={settings.training_start || undefined} value={settings.training_end ?? ""}
                    onChange={e => setSettings(s => ({...s, training_end: e.target.value}))} /></label>
                </> : period === 'all' ? <p>Desde {shortDate(firstAvailable)} hasta {shortDate(latest.today)}. Se usarán únicamente observaciones disponibles.</p> : <label>
                  Vigencias de entrenamiento
                  <input
                    type="number"
                    required
                    min={31}
                    max={20000}
                    step={1}
                    value={settings.training_records}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        training_records: Number(e.target.value),
                      }))
                    }
                  />
                </label>}
                <label>Factor de volatilidad
                  <input type="number" required min={0} max={3} step={0.05}
                    value={settings.volatility_scale ?? 1}
                    onChange={e => setSettings(s => ({...s, volatility_scale: Number(e.target.value)}))} />
                  <small>1 = volatilidad histórica; 1,5 = 50 % más.</small>
                </label>
                <label>
                  Réplicas de proyección
                  <input
                    type="number"
                    required
                    min={100}
                    max={5000}
                    step={1}
                    value={settings.replicas}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        replicas: Number(e.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Semilla de proyección
                  <input
                    type="number"
                    required
                    min={0}
                    max={4294967295}
                    step={1}
                    value={settings.seed}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        seed: Number(e.target.value),
                      }))
                    }
                  />
                </label>
              </div>
            </details>
            <details className="projection-options">
              <summary>Probabilidades para la fecha elegida</summary>
              <div className="simulation-input-grid">
                {([['threshold', 'Umbral COP/USD'], ['interval_low', 'Límite inferior COP/USD'],
                  ['interval_high', 'Límite superior COP/USD']] as const).map(([key, label]) =>
                  <label key={key}>{label}<input type="number"
                    min={key === 'interval_high' ? settings.interval_low || 0.01 : 0.01}
                    max={key === 'interval_low' ? settings.interval_high || 1000000000 : 1000000000}
                    step={0.01} value={settings[key] ?? ""}
                    required={key === 'interval_low' ? !!settings.interval_high : key === 'interval_high' ? !!settings.interval_low : false}
                    onChange={e => setSettings(s => ({...s, [key]: e.target.value || null}))} /></label>)}
              </div>
            </details>
          </fieldset>
          <button
            type="submit"
            className="primary"
            disabled={busy || latest.state !== "current"}
          >
            {busy ? "Calculando y validando…" : "Calcular proyección"}
          </button>
          {latest.state !== "current" && (
            <p role="status">
              Actualice el histórico antes de proyectar.{" "}
              {prepareData && (
                <button
                  type="button"
                  className="text-button"
                  onClick={prepareData}
                >
                  Actualizar datos oficiales
                </button>
              )}
            </p>
          )}
        </form>
      </section>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {changed && (
        <p className="comparison-draft" role="status">
          Resultado guardado con su fecha de corte y parámetros originales.
          Vuelva a calcular para aplicar la configuración actual.
        </p>
      )}
      {result && (
        <>
          <section
            className="projection-result"
            aria-label="Resultado de proyección"
          >
            <span className="small-label">
              PRECIO ESTIMADO{" "}
              {result.target_date
                ? `· ${shortDate(result.target_date)}`
                : `· ${result.request.horizon} TRANSICIONES (EXPERIMENTO ANTERIOR)`}
            </span>
            <h2>
              {money(result.estimate)} <small>COP/USD</small>
            </h2>
            {result.projected_from && (
              <p>
                Vigencia prevista:{" "}
                <strong>
                  {shortDate(result.projected_from)} al{" "}
                  {shortDate(result.projected_to)}
                </strong>
                . Las fechas de ese intervalo comparten la misma estimación.
              </p>
            )}
            <p>
              {methodNames[result.request.method]} · mediana de{" "}
              {result.request.replicas.toLocaleString("es-CO")} escenarios ·{" "}
              {result.request.horizon} transiciones.
            </p>
            <div className="projection-secondary">
              <div>
                <span>Intervalo del modelo · 90 %</span>
                <strong>
                  {money(result.lower)} – {money(result.upper)} COP/USD
                </strong>
              </div>
              <div>
                <span>
                  Variación frente a {money(result.experiment.initial_price)}{" "}
                  COP/USD
                </span>
                <strong>
                  {money(result.change)} COP/USD (
                  {percent(result.relative_change)})
                </strong>
              </div>
            </div>
            <p>
              {result.request.horizon === 0
                ? "La fecha solicitada está cubierta por la vigencia oficial conocida. No se generaron rendimientos adicionales."
                : "Estimación condicionada al histórico; el valor futuro puede quedar fuera del intervalo."}
            </p>
            {result.target_date && (
              <ExportButton
                path={`/exports/projection/${result.id}?include_paths=${includePaths && pathsFitWorkbook}`}
                filename="SIMTRM_proyeccion.xlsx"
                label="Descargar Excel"
              />
            )}
            <label className="inline-check"><input type="checkbox" checked={includePaths && pathsFitWorkbook} disabled={!pathsFitWorkbook}
              onChange={e => setIncludePaths(e.target.checked)} />Incluir trayectorias en Excel</label>
            {!pathsFitWorkbook && <p>La matriz completa está disponible en la descarga separada de trayectorias, optimizada para este tamaño.</p>}
            <p className="analysis-provenance">Corte: {shortDate(result.as_of)} · Entrenamiento: {shortDate(result.experiment.training.first_date)} al {shortDate(result.experiment.training.last_date)}</p>
          </section>
          {plot && (
            <section className="panel chart-panel">
              <div className="section-heading">
                <div>
                  <h2>Histórico y proyección</h2>
                  <p>
                    Azul: registros oficiales conocidos. Naranja y banda:
                    mediana y percentiles del modelo.
                  </p>
                </div>
              </div>
              <PlotChart
                {...plot}
                temporal
                viewKey={result.id}
                label="Histórico oficial y proyección por fecha"
                fallback="No se pudo cargar el gráfico. Consulte la tabla de proyecciones."
              />
            </section>
          )}
          {model && <section className="panel analysis-audit">
            <h2>Distribución al {shortDate(result.target_date)}</h2>
            <dl className="result-statistics">
              <div><dt>Media</dt><dd>{money(model.terminal_summary.mean)}</dd></div>
              <div><dt>Mediana</dt><dd>{money(model.terminal_summary.median)}</dd></div>
              <div><dt>Desviación estándar · COP/USD</dt><dd>{money(model.terminal_summary.sample_std)}</dd></div>
              <div><dt>Volatilidad histórica × factor</dt><dd>{percent(result.experiment.training.sigma * (result.request.volatility_scale ?? 1))}</dd></div>
              <div><dt>Mínimo simulado</dt><dd>{money(model.terminal_summary.minimum)}</dd></div>
              <div><dt>Máximo simulado</dt><dd>{money(model.terminal_summary.maximum)}</dd></div>
            </dl>
            <p>Los extremos son valores observados en las réplicas; no son límites del precio futuro.</p>
            <SimulationChart experiment={result.experiment} result={model} kind="terminal" />
            <h3>Probabilidades estimadas en la fecha objetivo</h3>
            <dl className="probability-results">{model.probabilities.filter(p =>
              p.probability !== null && (p.event === 'within_interval' ||
                (!!result.request.threshold && ['above_threshold', 'below_threshold'].includes(p.event))))
              .map(p => <div key={p.event}><dt>{probabilityLabels[p.event]}</dt>
                <dd>{percent(p.probability!)} <small>({p.count} de {model.total_paths})</small></dd></div>)}</dl>
            {!result.request.threshold && !result.request.interval_low && <p>Defina un umbral o rango y vuelva a calcular para consultar sus probabilidades.</p>}
            <p>Frecuencia de las réplicas al cierre del horizonte; no mide el cruce durante el periodo. Resolución: {percent(1 / model.total_paths)}.</p>
            <button type="button" disabled={comparisons.some(p => p.id === result.id) || comparisons.length >= 4}
              onClick={() => setComparisons(v => [...v, result])}>Añadir a comparación</button>
          </section>}
          {!!result.points?.length && (
            <section className="panel table-panel">
              <div className="section-heading">
                <h2>Proyecciones por vigencia</h2>
              </div>
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Tabla de proyecciones desplazable"
              >
                <table>
                  <caption className="sr-only">
                    Estimaciones en COP/USD · fila seleccionada para{" "}
                    {shortDate(result.target_date)}
                  </caption>
                  <thead>
                    <tr>
                      <th>Vigencia prevista desde</th>
                      <th>Hasta</th>
                      <th>Mediana COP/USD</th>
                      <th>P5 COP/USD</th>
                      <th>P95 COP/USD</th>
                      <th>Variación COP/USD</th>
                      <th>Variación %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.points.map((p) => (
                      <tr
                        key={p.step}
                        className={p.requested ? "requested-projection" : ""}
                        aria-current={p.requested ? "date" : undefined}
                      >
                        <td>
                          {shortDate(p.valid_from)}
                          {p.step === 0 ? " · inicial oficial" : ""}
                          {p.requested ? " · fecha solicitada" : ""}
                        </td>
                        <td>{shortDate(p.valid_to)}</td>
                        <td>{money(p.median)}</td>
                        <td>{money(p.p5)}</td>
                        <td>{money(p.p95)}</td>
                        <td>{money(p.change)}</td>
                        <td>{percent(p.relative_change)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {result.validation ? (
            <details className="projection-validation">
              <summary className="panel analysis-audit">
                Validación histórica de esta configuración
              </summary>
              <ValidationResults result={result.validation} />
            </details>
          ) : (
            <p className="panel analysis-audit">
              {result.validation_status ??
                "Este experimento anterior no conserva una validación asociada."}
            </p>
          )}
          <details className="panel analysis-audit">
            <summary>Metodología y datos del experimento</summary>
            <p>{result.experiment.methods[0].assumptions}</p>
            <p>{result.convention}</p>
            <p>{result.calendar_convention}</p>
            <p>
              Entrenamiento: {shortDate(result.experiment.training.first_date)}{" "}
              al {shortDate(result.experiment.training.last_date)} ·{" "}
              {result.experiment.training.return_count} rendimientos. Media
              logarítmica: {result.experiment.training.mu.toFixed(6)}.
              Desviación muestral: {result.experiment.training.sigma.toFixed(6)}
              . Semilla: {result.request.seed}.
            </p>
            <p>
              Versiones: {result.model_version ?? "projection-1.0.0"} ·{" "}
              {result.calendar_version ?? "sin calendario original"} ·{" "}
              {result.experiment.model_version}. Huella de datos:{" "}
              <code>{result.experiment.training.dataset_fingerprint}</code>.
            </p>
            {result.calendar_sources?.map((link) => (
              <p key={link}>
                <a href={link} target="_blank" rel="noreferrer">
                  {new URL(link).hostname} · fuente del calendario
                </a>
              </p>
            ))}
            <button disabled={busy} onClick={() => void reproduce()}>
              Reproducir proyección guardada
            </button>
            {onValidate && (
              <button onClick={() => onValidate({...result.request,
                training_records: result.experiment.training.record_count})}>
                Configurar otra validación
              </button>
            )}
          </details>
          <details className="panel analysis-audit">
            <summary>Trayectorias y descarga técnica</summary>
            <p>
              Las trayectorias individuales son escenarios, no observaciones
              oficiales. Se guardan todas las réplicas; el gráfico muestra{" "}
              {result.experiment.methods[0].displayed_paths}.
            </p>
            <SimulationChart
              experiment={result.experiment}
              result={result.experiment.methods[0]}
              kind="paths"
            />
            <ExportButton
              path="/exports/simulation"
              filename="SIMTRM_trayectorias.xlsx"
              label="Descargar trayectorias completas"
              body={{ experiment_id: result.id, include_paths: true }}
            />
          </details>
        </>
      )}
      {!!comparisons.length && <section className="panel table-panel">
        <div className="section-heading"><h2>Comparar escenarios</h2>
          <ExportButton path="/exports/scenarios" filename="SIMTRM_escenarios.xlsx"
            label="Excel de la comparación" body={{ids: comparisons.map(p => p.id)}} />
        </div>
        <p className="analysis-table-note">Hasta cuatro proyecciones guardadas. Compare fechas objetivo, periodos de entrenamiento y volatilidad antes de interpretar diferencias.</p>
        <PlotChart label="Comparación de medianas por fecha" temporal
          viewKey={comparisons.map(p => p.id).join(':')}
          fallback="Consulte la tabla comparativa."
          data={comparisons.map((p, i) => ({...projectionPlot(p).data[3],
            name: `${i + 1}. ${methodNames[p.request.method]} · σ × ${p.request.volatility_scale ?? 1}`,
            line: {shape: 'hv'}, hovertemplate: '%{x|%d/%m/%Y}<br>%{y:,.2f} COP/USD<extra>%{fullData.name}</extra>'}))}
          layout={{height: 340, margin: {l: 75, r: 20, t: 55, b: 55},
            legend: {orientation: 'h', y: 1.2}, xaxis: {type: 'date'}, yaxis: {title: {text: 'Mediana COP/USD'}}}} />
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Escenarios comparados">
          <table><thead><tr><th>Escenario</th><th>Fecha objetivo</th><th>Entrenamiento</th><th>Volatilidad ×</th>
            <th>Mediana</th><th>P5–P95</th><th>Acciones</th></tr></thead>
            <tbody>{comparisons.map((p, i) => <tr key={p.id}>
              <td>{i + 1}. {methodNames[p.request.method]}</td><td>{shortDate(p.target_date)}</td>
              <td>{shortDate(p.experiment.training.first_date)} – {shortDate(p.experiment.training.last_date)}</td>
              <td>{p.request.volatility_scale ?? 1}</td><td>{money(p.estimate)}</td>
              <td>{money(p.lower)} – {money(p.upper)}</td><td><button type="button"
                aria-label={`Quitar escenario ${i + 1}`} onClick={() => setComparisons(v => v.filter(x => x.id !== p.id))}>Quitar</button></td>
            </tr>)}</tbody></table>
        </div>
      </section>}
      <SavedExperiments
        revision={result?.id ?? ""}
        onProjection={(id) => calculate(`/projections/${id}`, true)}
      />
    </div>
  );
}
