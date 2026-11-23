import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { timestamp } from "./format";
import ValidationResults from "./ValidationResults";
import EvaluationHistory from "./EvaluationHistory";
import { defaultProjection } from "./projectionSettings";
import type { ProjectionSettings, RollingEvaluation } from "./types";

export default function RollingValidation({
  available,
  initialSettings,
}: {
  available: boolean;
  initialSettings?: ProjectionSettings;
}) {
  const [settings, setSettings] = useState<ProjectionSettings>(
    initialSettings ? {...initialSettings, training_start: null, training_end: null} : defaultProjection,
  );
  const [horizons, setHorizons] = useState("7,30,90");
  const [unit, setUnit] = useState<"calendar_days" | "transitions">("calendar_days");
  const [folds, setFolds] = useState(6);
  const [result, setResult] = useState<RollingEvaluation | null>(null);
  const [operation, setOperation] = useState<"open" | "run" | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const focusedResult = useRef<RollingEvaluation | null>(null);
  useEffect(() => {
    if (result && focusedResult.current !== result) {
      focusedResult.current = result;
      output.current?.focus({ preventScroll: true });
      output.current?.scrollIntoView?.({ block: "start" });
    }
  }, [result]);
  const parsedHorizons = horizons.split(",").map((s) => Number(s.trim()));
  const dirty =
    result &&
    (Object.entries(result.request.settings).some(
      ([key, value]) => settings[key as keyof ProjectionSettings] !== value,
    ) ||
      String(result.request.horizons) !== String(parsedHorizons) ||
      folds !== result.request.folds || cutoff !== (result.request.last_cutoff ?? "") ||
      unit !== (result.request.unit ?? "transitions"));
  function editConfiguration() {
    form.current?.focus({ preventScroll: true });
    form.current?.scrollIntoView?.({ block: "start" });
  }
  function reuse() {
    if (!result) return;
    setSettings({ ...result.request.settings });
    setHorizons(result.request.horizons.join(","));
    setFolds(result.request.folds);
    setCutoff(result.request.last_cutoff ?? "");
    setUnit(result.request.unit ?? "transitions");
    setMessage("Configuración cargada. Puede ajustarla y ejecutar una nueva evaluación.");
    editConfiguration();
  }
  async function recover(id: string) {
    setOperation("open");
    setError("");
    setMessage("");
    try {
      setResult(await request<RollingEvaluation>(`/validations/rolling/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No fue posible abrir la evaluación");
    } finally {
      setOperation(null);
    }
  }
  async function run() {
    setOperation("run");
    setError("");
    setMessage("");
    try {
      const next = await request<RollingEvaluation>(
        "/validations/rolling",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            settings,
            unit,
            horizons: parsedHorizons,
            folds,
            last_cutoff: cutoff || null,
          }),
        },
      );
      setResult(next);
      setSettings(next.request.settings);
      setHorizons(next.request.horizons.join(","));
      setFolds(next.request.folds);
      setCutoff(next.request.last_cutoff ?? "");
      setUnit(next.request.unit ?? "transitions");
      setRevision(n => n + 1);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No fue posible evaluar las proyecciones",
      );
    } finally {
      setOperation(null);
    }
  }
  return (
    <section className="rolling-validation">
      <EvaluationHistory revision={revision} selectedId={result?.id} busy={busy}
        onOpen={recover} onNew={editConfiguration} />
      {operation === "open" && <p role="status">Abriendo evaluación guardada…</p>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {message && <p role="status" className="configuration-message">{message}</p>}
      <form
        ref={form}
        tabIndex={-1}
        aria-label="Configurar evaluación"
        className="panel simulation-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="section-heading">
          <div>
            <h2>Evaluación en varios cortes históricos</h2>
            <p>
              Se calibra antes de cada corte y se compara la mediana proyectada
              con la TRM observada al final de cada horizonte. La referencia
              conserva el valor inicial.
            </p>
          </div>
        </div>
        <fieldset disabled={busy} className="simulation-fields">
          <legend className="sr-only">
            Parámetros de evaluación en varios cortes
          </legend>
          <div className="simulation-input-grid">
            <label>
              Método a evaluar
              <select
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
              Ventana de entrenamiento (vigencias)
              <input
                required
                type="number"
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
            </label>
            <label>
              Horizontes en {unit === "calendar_days" ? "días calendario" : "transiciones"} (separados por coma)
              <input
                required
                value={horizons}
                onChange={(e) => setHorizons(e.target.value)}
              />
            </label>
            <label>Unidad de evaluación
              <select value={unit} onChange={e => setUnit(e.target.value as typeof unit)}>
                <option value="calendar_days">Días calendario</option>
                <option value="transitions">Transiciones entre vigencias</option>
              </select>
            </label>
            <label>
              Cortes solicitados
              <input
                required
                type="number"
                min={2}
                max={12}
                step={1}
                value={folds}
                onChange={(e) => setFolds(Number(e.target.value))}
              />
            </label>
            <label>Último corte histórico (opcional)
              <input type="date" value={cutoff} onChange={e => setCutoff(e.target.value)} />
            </label>
            <label>Factor de volatilidad
              <input type="number" required min={0} max={3} step={0.05}
                value={settings.volatility_scale ?? 1}
                onChange={e => setSettings(s => ({...s, volatility_scale: Number(e.target.value)}))} />
            </label>
            <label>
              Réplicas por corte
              <input
                required
                type="number"
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
              Semilla por corte
              <input
                required
                type="number"
                min={0}
                max={4294967295}
                step={1}
                value={settings.seed}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, seed: Number(e.target.value) }))
                }
              />
            </label>
          </div>
        </fieldset>
        <div className="simulation-actions">
          <p>
            Horizontes entre 1 y 365 {unit === "calendar_days" ? "días calendario" : "transiciones"}. Los cortes más recientes
            se separan por el mayor horizonte solicitado; no se seleccionan
            según el error obtenido.
          </p>
          <button
            type="submit"
            className="primary"
            disabled={busy || !available}
          >
            {operation === "run" ? "Evaluando…" : "Evaluar varios cortes"}
          </button>
        </div>
      </form>
      {dirty && (
        <p role="status" className="comparison-draft">
          Parámetros modificados. Los resultados conservan la configuración
          indicada en su evaluación.
        </p>
      )}
      {result && <div ref={output} tabIndex={-1} className="evaluation-output">
        <div className="panel analysis-audit evaluation-selection">
          <div><h2>Evaluación del {timestamp(result.created_at)}</h2>
            <p>Resultados originales guardados. Usar su configuración prepara una nueva ejecución.</p></div>
          <button type="button" disabled={busy} onClick={reuse}>Usar esta configuración</button>
        </div>
        <ValidationResults key={result.id} result={result} />
      </div>}
    </section>
  );
}
