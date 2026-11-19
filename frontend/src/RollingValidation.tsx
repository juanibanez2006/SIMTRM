import { useState } from "react";
import { request } from "./api";
import ValidationResults from "./ValidationResults";
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
  const [horizons, setHorizons] = useState(
    initialSettings
      ? [...new Set([7, 30, 90])].sort((a, b) => a - b).join(",")
      : "7,30,90",
  );
  const [folds, setFolds] = useState(6);
  const [result, setResult] = useState<RollingEvaluation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [id, setId] = useState("");
  const [cutoff, setCutoff] = useState("");
  const parsedHorizons = horizons.split(",").map((s) => Number(s.trim()));
  const dirty =
    result &&
    (Object.entries(result.request.settings).some(
      ([key, value]) => settings[key as keyof ProjectionSettings] !== value,
    ) ||
      String(result.request.horizons) !== String(parsedHorizons) ||
      folds !== result.request.folds || cutoff !== (result.request.last_cutoff ?? ""));
  async function run(recover = false) {
    setBusy(true);
    setError("");
    try {
      const next = await request<RollingEvaluation>(
        recover ? `/validations/rolling/${id}` : "/validations/rolling",
        recover
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                settings,
                unit: "calendar_days",
                horizons: parsedHorizons,
                folds,
                last_cutoff: cutoff || null,
              }),
            },
      );
      setResult(next);
      setId(next.id);
      setSettings(next.request.settings);
      setHorizons(next.request.horizons.join(","));
      setFolds(next.request.folds);
      setCutoff(next.request.last_cutoff ?? "");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No fue posible evaluar las proyecciones",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rolling-validation">
      <form
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
              Horizontes en días calendario (separados por coma)
              <input
                required
                value={horizons}
                onChange={(e) => setHorizons(e.target.value)}
              />
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
            Horizontes entre 1 y 365 días calendario. Los cortes más recientes
            se separan por el mayor horizonte solicitado; no se seleccionan
            según el error obtenido.
          </p>
          <button
            type="submit"
            className="primary"
            disabled={busy || !available}
          >
            {busy ? "Evaluando…" : "Evaluar varios cortes"}
          </button>
        </div>
      </form>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {dirty && (
        <p role="status" className="comparison-draft">
          Parámetros modificados. Los resultados conservan la configuración
          indicada en su evaluación.
        </p>
      )}
      {result && <ValidationResults result={result} />}
      <details className="panel analysis-audit">
        <summary>Recuperar evaluación guardada</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(true);
          }}
        >
          <label>
            Identificador de evaluación
            <input
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <button disabled={busy}>Consultar evaluación</button>
        </form>
      </details>
    </section>
  );
}
