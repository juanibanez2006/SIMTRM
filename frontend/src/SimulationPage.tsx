import { useState } from "react";
import { request } from "./api";
import { money, number, shortDate, timestamp } from "./format";
import SimulationChart from "./SimulationChart";
import ExportButton from "./ExportButton";
import MethodNote from "./MethodNote";
import type {
  DataStatus,
  Latest,
  Simulation,
  SimulationMethod,
  SimulationRequest,
} from "./types";

const methodNames = {
  monte_carlo: "Montecarlo paramétrico",
  bootstrap: "Bootstrap histórico",
};
type FormState = { [Key in keyof SimulationRequest]: string };
function initialForm(latest: Latest): FormState {
  const last = latest.record?.valid_from || latest.today;
  return {
    training_start: `${last.slice(0, 4)}-01-01`,
    training_end: last < latest.today ? last : latest.today,
    cutoff_date: latest.today,
    method: "both",
    horizon: "30",
    replicas: "1000",
    seed: "2026",
    initial_price: "",
    threshold: "",
    interval_low: "",
    interval_high: "",
    display_paths: "20",
  };
}
function requestFromForm(form: FormState): SimulationRequest {
  return {
    training_start: form.training_start,
    training_end: form.training_end,
    cutoff_date: form.cutoff_date,
    method: form.method as SimulationRequest["method"],
    horizon: Number(form.horizon),
    replicas: Number(form.replicas),
    seed: Number(form.seed),
    initial_price: form.initial_price || null,
    threshold: form.threshold || null,
    interval_low: form.interval_low || null,
    interval_high: form.interval_high || null,
    display_paths: Number(form.display_paths),
  };
}
function validation(form: FormState, today: string): string {
  if (!form.training_start || !form.training_end || !form.cutoff_date)
    return "Complete las fechas de entrenamiento y corte.";
  if (form.training_start > form.training_end)
    return "El intervalo de entrenamiento tiene fechas invertidas.";
  if (form.training_end > form.cutoff_date)
    return "El entrenamiento no puede terminar después del corte.";
  if (form.cutoff_date > today) return "El corte no puede ser posterior a hoy.";
  if (
    !form.horizon ||
    !Number.isInteger(Number(form.horizon)) ||
    Number(form.horizon) < 1 ||
    Number(form.horizon) > 365
  )
    return "El horizonte debe ser un entero entre 1 y 365 pasos.";
  if (
    !form.replicas ||
    !Number.isInteger(Number(form.replicas)) ||
    Number(form.replicas) < 1 ||
    Number(form.replicas) > 50000
  )
    return "Las réplicas deben ser un entero entre 1 y 50.000.";
  if (
    !form.seed ||
    !Number.isInteger(Number(form.seed)) ||
    Number(form.seed) < 0 ||
    Number(form.seed) > 4294967295
  )
    return "La semilla debe ser un entero entre 0 y 4.294.967.295.";
  const methods = form.method === "both" ? 2 : 1;
  if (Number(form.replicas) * (Number(form.horizon) + 1) * methods > 2_000_000)
    return "El experimento supera 2.000.000 de valores simulados; reduzca réplicas u horizonte.";
  for (const key of [
    "initial_price",
    "threshold",
    "interval_low",
    "interval_high",
  ] as const) {
    if (
      form[key] &&
      (!Number.isFinite(Number(form[key])) ||
        Number(form[key]) <= 0 ||
        Number(form[key]) > 1e9 ||
        !/^\d+(\.\d{1,2})?$/.test(form[key]))
    )
      return "Los precios deben ser positivos, con máximo dos decimales y hasta 1.000.000.000 COP/USD.";
  }
  if (Boolean(form.interval_low) !== Boolean(form.interval_high))
    return "Indique ambos límites del intervalo de interés.";
  if (
    form.interval_low &&
    Number(form.interval_low) > Number(form.interval_high)
  )
    return "El intervalo de interés tiene límites invertidos.";
  return "";
}
const percent = (value: number | null) =>
  value === null
    ? "—"
    : `${new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 }).format(value * 100)} %`;

export default function SimulationPage({
  latest,
  status,
  prepareData,
  initialPeriod,
}: {
  latest: Latest;
  status: DataStatus;
  prepareData: () => void;
  initialPeriod?: { start: string; end: string } | null;
}) {
  const [form, setForm] = useState(() => ({
    ...initialForm(latest),
    ...(initialPeriod
      ? {
          training_start: initialPeriod.start,
          training_end: initialPeriod.end,
          cutoff_date: initialPeriod.end,
        }
      : {}),
  }));
  const [experiment, setExperiment] = useState<Simulation | null>(null);
  const [active, setActive] = useState<SimulationMethod>("monte_carlo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savedId, setSavedId] = useState("");
  const [bandPage, setBandPage] = useState(1);
  const invalid = validation(form, latest.today);
  const draft = requestFromForm(form);
  const dirty =
    experiment && JSON.stringify(draft) !== JSON.stringify(experiment.request);
  const update = (key: keyof FormState, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const result =
    experiment?.methods.find((method) => method.method === active) ||
    experiment?.methods[0];
  async function run(action: "create" | "replay" | "load") {
    if (
      action === "load" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        savedId.trim(),
      )
    ) {
      setError("Indique un identificador UUID de experimento válido.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const path =
        action === "create"
          ? "/simulations"
          : action === "replay"
            ? `/simulations/${experiment!.id}/replay`
            : `/simulations/${savedId.trim()}`;
      const next = await request<Simulation>(
        path,
        action === "load"
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              ...(action === "create" ? { body: JSON.stringify(draft) } : {}),
            },
      );
      setExperiment(next);
      setSavedId(next.id);
      setActive(next.methods[0].method);
      setBandPage(1);
      setForm(
        Object.fromEntries(
          Object.entries(next.request).map(([key, value]) => [
            key,
            value === null ? "" : String(value),
          ]),
        ) as FormState,
      );
      setMessage(
        action === "replay"
          ? "El experimento se reprodujo con los mismos resultados."
          : action === "load"
            ? "Experimento recuperado."
            : "Experimento completado y guardado.",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No fue posible ejecutar el experimento",
      );
    } finally {
      setBusy(false);
    }
  }
  const eventLabel = (event: string) =>
    ({
      above_initial: `Terminar por encima del precio inicial (${money(experiment?.initial_price)})`,
      below_initial: "Terminar por debajo del precio inicial",
      equal_initial: "Terminar exactamente en el precio inicial",
      above_threshold: `Terminar por encima de ${money(experiment?.threshold)} COP/USD`,
      below_threshold: `Terminar por debajo de ${money(experiment?.threshold)} COP/USD`,
      within_interval: `Terminar en el intervalo inclusivo [${money(experiment?.request.interval_low)}, ${money(experiment?.request.interval_high)}]`,
    })[event] || event;

  return (
    <div className="simulation-page">
      {initialPeriod && (
        <p className="period-continuity">
          Entrenamiento inicializado desde el histórico; corte al final del
          periodo. Revise los parámetros y pulse Ejecutar simulación. El zoom
          visual no cambia estos datos.
        </p>
      )}
      <MethodNote title="Datos, fórmulas y supuestos de Montecarlo y bootstrap">
        <p>
          El entrenamiento utiliza rendimientos logarítmicos r = ln(Pᵢ/Pᵢ₋₁)
          hasta el corte, sin datos posteriores. Montecarlo genera r = μ + σZ,
          con μ como media muestral, σ con divisor n − 1 y Z normal estándar.
          Cada trayectoria es P₀ × exp(Σr).
        </p>
        <p>
          Bootstrap remuestrea los rendimientos observados con reemplazo. Ambos
          métodos suponen independencia y parámetros/distribución estables; el
          bootstrap simple no conserva agrupamiento temporal de volatilidad.
        </p>
        <p>
          Los percentiles usan todas las réplicas. Una probabilidad se estima
          como casos que cumplen el evento / réplicas. La semilla, instantánea y
          versión permiten reproducir el experimento; no garantizan resultados
          futuros. Un paso no equivale automáticamente a un día calendario.
        </p>
      </MethodNote>
      <section className="simulation-notice">
        <strong>Laboratorio de escenarios probabilísticos</strong>
        <p>
          Los escenarios dependen de la muestra y los supuestos. No son
          predicciones garantizadas ni recomendaciones de inversión.
        </p>
      </section>
      {status.state === "source_error" && (
        <p className="analysis-warnings">
          La última consulta de nuevas publicaciones no pudo completarse. Los
          escenarios utilizarán los registros disponibles para el periodo de
          entrenamiento seleccionado.
        </p>
      )}
      {!status.total && (
        <div className="empty-state panel">
          <h2>Primero se necesitan datos oficiales</h2>
          <p>Consulte las publicaciones oficiales desde Calidad de datos para calibrar los métodos.</p>
          <button className="primary" onClick={prepareData}>
            Preparar datos del simulador
          </button>
        </div>
      )}
      <form
        className="panel simulation-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid && status.total) void run("create");
        }}
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">CALIBRAR · SIMULAR · REPRODUCIR</p>
            <h2>Configurar experimento</h2>
            <p>
              La fecha de corte limita la información disponible. El
              entrenamiento puede terminar antes del corte.
            </p>
          </div>
        </div>
        <fieldset disabled={busy} className="simulation-fields">
          <legend className="sr-only">Parámetros del experimento</legend>
          <div className="simulation-input-grid">
            <label>
              Inicio del entrenamiento
              <input
                type="date"
                value={form.training_start}
                onChange={(event) =>
                  update("training_start", event.target.value)
                }
              />
            </label>
            <label>
              Fin del entrenamiento
              <input
                type="date"
                value={form.training_end}
                onChange={(event) => update("training_end", event.target.value)}
              />
            </label>
            <label>
              Fecha de corte
              <input
                type="date"
                value={form.cutoff_date}
                max={latest.today}
                onChange={(event) => update("cutoff_date", event.target.value)}
              />
            </label>
            <label>
              Método de simulación
              <select
                value={form.method}
                onChange={(event) => update("method", event.target.value)}
              >
                <option value="both">Comparar ambos métodos</option>
                <option value="monte_carlo">Montecarlo paramétrico</option>
                <option value="bootstrap">Bootstrap histórico</option>
              </select>
            </label>
            <label>
              Horizonte en pasos
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
              Número de réplicas
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
              Semilla aleatoria
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
              Precio inicial opcional · COP/USD
              <input
                type="number"
                min="0.01"
                max="1000000000"
                step="0.01"
                placeholder="Último precio del entrenamiento"
                value={form.initial_price}
                onChange={(event) =>
                  update("initial_price", event.target.value)
                }
              />
            </label>
            <label>
              Umbral terminal opcional · COP/USD
              <input
                type="number"
                min="0.01"
                max="1000000000"
                step="0.01"
                placeholder="Igual al precio inicial"
                value={form.threshold}
                onChange={(event) => update("threshold", event.target.value)}
              />
            </label>
            <label>
              Límite inferior del intervalo · COP/USD
              <input
                type="number"
                min="0.01"
                max="1000000000"
                step="0.01"
                value={form.interval_low}
                onChange={(event) => update("interval_low", event.target.value)}
              />
            </label>
            <label>
              Límite superior del intervalo · COP/USD
              <input
                type="number"
                min="0.01"
                max="1000000000"
                step="0.01"
                value={form.interval_high}
                onChange={(event) =>
                  update("interval_high", event.target.value)
                }
              />
            </label>
            <label>
              Trayectorias a dibujar
              <select
                value={form.display_paths}
                onChange={(event) =>
                  update("display_paths", event.target.value)
                }
              >
                {!["10", "20", "50"].includes(form.display_paths) && (
                  <option value={form.display_paths}>
                    Hasta {form.display_paths}
                  </option>
                )}
                <option value="10">Hasta 10</option>
                <option value="20">Hasta 20</option>
                <option value="50">Hasta 50</option>
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
            Ejecutar simulación
          </button>
          <span>Hasta 2.000.000 de valores simulados entre los métodos seleccionados.</span>
        </div>
        {invalid && (
          <p className="comparison-validation" role="alert">
            {invalid}
          </p>
        )}
        {dirty && !invalid && (
          <p className="comparison-draft">
            Parámetros modificados: ejecute de nuevo para aplicarlos. El
            resultado visible conserva su propia configuración.
          </p>
        )}
      </form>
      <section className="panel simulation-saved">
        <label>
          Identificador de experimento guardado
          <input
            value={savedId}
            onChange={(event) => setSavedId(event.target.value)}
            placeholder="UUID del experimento"
          />
        </label>
        <button disabled={busy} onClick={() => void run("load")}>
          Abrir experimento
        </button>
        {experiment && (
          <button disabled={busy} onClick={() => void run("replay")}>
            Reproducir experimento
          </button>
        )}
      </section>
      {busy && (
        <div className="loading panel" role="status">
          <span className="spinner" />
          Calculando escenarios…
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {message && (
        <p className="success-message simulation-message" role="status">
          {message}
        </p>
      )}
      {experiment && result && (
        <>
          <div className="module-export">
            <ExportButton
              path="/exports/simulation"
              body={{ experiment_id: experiment.id, include_paths: true }}
              filename="SIMTRM_simulacion.xlsx"
              label="Excel del experimento completo"
              disabled={busy}
            />
          </div>
          <section className="panel analysis-interpretation">
            <span className="small-label">
              ESCENARIOS SIMULADOS · {methodNames[result.method]}
            </span>
            <h2>Resultado del experimento</h2>
            <p>{result.interpretation}</p>
            <div className="analysis-provenance">
              Entrenamiento: {shortDate(experiment.training.first_date)} a{" "}
              {shortDate(experiment.training.last_date)} · Corte:{" "}
              {shortDate(experiment.request.cutoff_date)} ·{" "}
              {number.format(experiment.training.record_count)} precios /{" "}
              {number.format(experiment.training.return_count)} rendimientos
            </div>
          </section>
          <aside
            className="analysis-warnings"
            aria-label="Supuestos y limitaciones de la simulación"
          >
            <ul>
              {experiment.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p>{result.assumptions}</p>
          </aside>
          <div
            className="simulation-method-tabs"
            aria-label="Resultados por método"
          >
            {experiment.methods.map((method) => (
              <button
                key={method.method}
                aria-pressed={result.method === method.method}
                onClick={() => {
                  setActive(method.method);
                  setBandPage(1);
                }}
              >
                {methodNames[method.method]}
              </button>
            ))}
          </div>
          <section
            className="metric-grid"
            aria-label="Resumen terminal simulado"
          >
            {[
              ["Media terminal simulada", money(result.terminal_summary.mean)],
              [
                "Mediana terminal simulada",
                money(result.terminal_summary.median),
              ],
              [
                "Percentil 5 terminal",
                money(result.terminal_summary.percentiles.p5),
              ],
              [
                "Percentil 95 terminal",
                money(result.terminal_summary.percentiles.p95),
              ],
            ].map(([label, value]) => (
              <article className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>COP/USD · escenarios del modelo</small>
              </article>
            ))}
          </section>
          <section className="panel chart-panel">
            <div className="section-heading">
              <div>
                <h2>Trayectorias y bandas marginales</h2>
                <p>
                  Se dibujan {result.displayed_paths} de{" "}
                  {number.format(result.total_paths)} trayectorias. Todos los
                  percentiles y medias usan las{" "}
                  {number.format(result.total_paths)} réplicas completas.
                </p>
              </div>
            </div>
            <SimulationChart
              key={`${experiment.id}-${result.method}-paths`}
              experiment={experiment}
              result={result}
              kind="paths"
            />
            <p className="analysis-table-note convention">
              Paso 0: {money(experiment.initial_price)} COP/USD (
              {experiment.initial_price_origin === "configured"
                ? "precio configurado para el escenario"
                : `último registro de entrenamiento, ${shortDate(experiment.training.initial_record_date)}`}
              ). La curva de medias y las bandas resumen distribuciones por
              paso; no son trayectorias individuales.
            </p>
          </section>
          <div className="analysis-chart-grid">
            <section className="panel chart-panel">
              <div className="section-heading">
                <div>
                  <h2>Distribución de precios terminales</h2>
                  <p>
                    {number.format(result.total_paths)} valores finales
                    simulados · horizonte {experiment.request.horizon} pasos
                  </p>
                </div>
              </div>
              <SimulationChart
                key={`${experiment.id}-${result.method}-terminal`}
                experiment={experiment}
                result={result}
                kind="terminal"
              />
              <p className="analysis-table-note convention">
                Mínimo: {money(result.terminal_summary.minimum)} · Máximo:{" "}
                {money(result.terminal_summary.maximum)} · Desviación muestral:{" "}
                {money(result.terminal_summary.sample_std)} COP/USD.
              </p>
            </section>
            <section className="panel simulation-probabilities">
              <div className="section-heading">
                <div>
                  <h2>Probabilidades terminales empíricas</h2>
                  <p>
                    Conteo del evento / número de réplicas. Aplican al paso
                    final, no al máximo alcanzado durante la trayectoria.
                  </p>
                </div>
              </div>
              <table>
                <caption className="sr-only">
                  Probabilidades estimadas bajo el modelo seleccionado
                </caption>
                <thead>
                  <tr>
                    <th>Evento</th>
                    <th className="numeric">Conteo / N</th>
                    <th className="numeric">Probabilidad</th>
                  </tr>
                </thead>
                <tbody>
                  {result.probabilities.map((row) => (
                    <tr key={row.event}>
                      <td>
                        {row.event === "within_interval" &&
                        experiment.request.interval_low === null
                          ? "Intervalo de interés no configurado"
                          : eventLabel(row.event)}
                      </td>
                      <td className="numeric">
                        {row.count === null
                          ? "—"
                          : `${row.count} / ${result.total_paths}`}
                      </td>
                      <td className="numeric">{percent(row.probability)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <section className="panel table-panel">
            <div className="section-heading">
              <div>
                <h2>Comparación de métodos del experimento</h2>
                <p>
                  Mismos datos, precio inicial, horizonte, réplicas y semilla;
                  cada método tiene sus propios supuestos. Una media mayor no
                  demuestra superioridad.
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
                  Resultados terminales por método de simulación
                </caption>
                <thead>
                  <tr>
                    <th>Método</th>
                    <th className="numeric">Media</th>
                    <th className="numeric">Mediana</th>
                    <th className="numeric">Desviación</th>
                    <th className="numeric">P5</th>
                    <th className="numeric">P95</th>
                    <th className="numeric">P(final &gt; inicial)</th>
                  </tr>
                </thead>
                <tbody>
                  {experiment.methods.map((method) => (
                    <tr key={method.method}>
                      <td>{methodNames[method.method]}</td>
                      <td className="numeric">
                        {money(method.terminal_summary.mean)}
                      </td>
                      <td className="numeric">
                        {money(method.terminal_summary.median)}
                      </td>
                      <td className="numeric">
                        {money(method.terminal_summary.sample_std)}
                      </td>
                      <td className="numeric">
                        {money(method.terminal_summary.percentiles.p5)}
                      </td>
                      <td className="numeric">
                        {money(method.terminal_summary.percentiles.p95)}
                      </td>
                      <td className="numeric">
                        {percent(
                          method.probabilities.find(
                            (row) => row.event === "above_initial",
                          )!.probability,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel table-panel">
            <div className="section-heading">
              <div>
                <h2>Resumen por paso</h2>
                <p>
                  Bandas percentilares marginales calculadas sobre todas las
                  réplicas.
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
                  Media, mediana y percentiles por paso simulado
                </caption>
                <thead>
                  <tr>
                    <th>Paso</th>
                    <th className="numeric">Media</th>
                    <th className="numeric">Mediana</th>
                    <th className="numeric">P5</th>
                    <th className="numeric">P25</th>
                    <th className="numeric">P75</th>
                    <th className="numeric">P95</th>
                  </tr>
                </thead>
                <tbody>
                  {result.bands
                    .slice((bandPage - 1) * 20, bandPage * 20)
                    .map((row) => (
                      <tr key={row.step}>
                        <td>{row.step}</td>
                        {[
                          row.mean,
                          row.median,
                          row.p5,
                          row.p25,
                          row.p75,
                          row.p95,
                        ].map((value, index) => (
                          <td className="numeric" key={index}>
                            {money(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                Página {bandPage} de {Math.ceil(result.bands.length / 20)}
              </span>
              <div>
                <button
                  disabled={bandPage === 1}
                  onClick={() => setBandPage((value) => value - 1)}
                >
                  Anterior simulación
                </button>
                <button
                  disabled={bandPage * 20 >= result.bands.length}
                  onClick={() => setBandPage((value) => value + 1)}
                >
                  Siguiente simulación
                </button>
              </div>
            </div>
          </section>
          <section className="panel chart-panel">
            <div className="section-heading">
              <div>
                <h2>Referencia histórica del entrenamiento</h2>
                <p>
                  Datos reales · últimas {experiment.training.history.length} de{" "}
                  {experiment.training.record_count} observaciones. Las
                  estadísticas utilizan la muestra completa.
                </p>
              </div>
            </div>
            <SimulationChart
              key={`${experiment.id}-history`}
              experiment={experiment}
              result={result}
              kind="history"
            />
          </section>
          <details className="panel analysis-audit">
            <summary>Calibración y reproducción del experimento</summary>
            <p>
              El entrenamiento usa únicamente los registros del periodo
              seleccionado hasta el corte. Los rendimientos se calculan entre
              vigencias contiguas, incluyendo los precios iguales y excluyendo
              los huecos. La desviación muestral utiliza el divisor n − 1.
              Todas las réplicas intervienen en los percentiles y probabilidades;
              el gráfico muestra solo las trayectorias indicadas. Para reproducir
              el resultado se conservan la muestra y los parámetros originales;
              también se requieren las mismas condiciones de cálculo.
            </p>
            <dl className="audit-grid">
              <div>
                <dt>Media logarítmica μ por paso</dt>
                <dd>{percent(experiment.training.mu)}</dd>
              </div>
              <div>
                <dt>Desviación logarítmica σ por paso</dt>
                <dd>{percent(experiment.training.sigma)}</dd>
              </div>
              <div>
                <dt>Semilla · horizonte · réplicas</dt>
                <dd>
                  {experiment.request.seed} · {experiment.request.horizon} ·{" "}
                  {experiment.request.replicas}
                </dd>
              </div>
              <div>
                <dt>Ejecución</dt>
                <dd>{timestamp(experiment.created_at)}</dd>
              </div>
            </dl>
            <div className="formula">
              Montecarlo: r = μ + σZ, Z ~ N(0,1)
              <br />
              Bootstrap: r* se toma con reemplazo del histórico
              <br />P siguiente = P × exp(r) · P(evento terminal) = conteo / N
            </div>
            <p>
              Fuente: {experiment.source}
              <br />
              Identificador: {experiment.id}
              {experiment.replay_of && (
                <>
                  <br />
                  Reproduce: {experiment.replay_of}
                </>
              )}
            </p>
          </details>
        </>
      )}
    </div>
  );
}
