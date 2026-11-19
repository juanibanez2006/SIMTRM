import { useEffect, useState } from "react";
import { request } from "./api";
import { money, shortDate, timestamp } from "./format";
import ExportButton from "./ExportButton";
import SimulationChart from "./SimulationChart";
import ValidationResults from "./ValidationResults";
import { methodNames } from "./projectionSettings";
import type { Backtest, RollingEvaluation, Simulation } from "./types";

type Kind = "projection" | "simulation" | "rolling" | "backtest";
interface Entry {
  id: string;
  kind: Kind;
  created_at: string;
  target_date: string | null;
  method: string | null;
}
const names: Record<Kind, string> = {
  projection: "Proyección",
  simulation: "Simulación técnica",
  rolling: "Evaluación en varios cortes",
  backtest: "Validación individual",
};
export default function SavedExperiments({
  revision,
  onProjection,
}: {
  revision: string;
  onProjection: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [kind, setKind] = useState<Kind>("projection");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [backtest, setBacktest] = useState<Backtest | null>(null);
  const [rolling, setRolling] = useState<RollingEvaluation | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    request<Entry[]>("/experiments", { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setEntries(rows);
          setError("");
        }
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [open, revision]);
  async function recover(selectedKind: Kind, selectedId: string) {
    setBusy(true);
    setError("");
    try {
      setSimulation(null);
      setBacktest(null);
      setRolling(null);
      if (selectedKind === "projection") await onProjection(selectedId);
      else if (selectedKind === "simulation")
        setSimulation(await request<Simulation>(`/simulations/${selectedId}`));
      else if (selectedKind === "backtest")
        setBacktest(await request<Backtest>(`/backtests/${selectedId}`));
      else
        setRolling(
          await request<RollingEvaluation>(
            `/validations/rolling/${selectedId}`,
          ),
        );
      setKind(selectedKind);
      setId(selectedId);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No fue posible recuperar el experimento",
      );
    } finally {
      setBusy(false);
    }
  }
  async function replay() {
    if (!simulation) return;
    setBusy(true);
    setError("");
    try {
      setSimulation(
        await request<Simulation>(`/simulations/${simulation.id}/replay`, {
          method: "POST",
        }),
      );
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
  return (
    <details
      className="panel analysis-audit archive"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Experimentos guardados</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void recover(kind, id);
        }}
      >
        <div className="filters">
          <label>
            Tipo de experimento
            <select
              aria-label="Tipo de experimento"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              {Object.entries(names).map(([key, value]) => (
                <option value={key} key={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Identificador de experimento
            <input
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <button disabled={busy}>Recuperar experimento</button>
        </div>
      </form>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <ul className="archive-list">
        {entries.map((entry) => (
          <li key={`${entry.kind}:${entry.id}`}>
            <span>
              {names[entry.kind]} ·{" "}
              {entry.target_date
                ? shortDate(entry.target_date)
                : timestamp(entry.created_at)}{" "}
              <code>{entry.id}</code>
            </span>
            <button
              disabled={busy}
              onClick={() => void recover(entry.kind, entry.id)}
              aria-label={`Abrir experimento ${entry.id}`}
            >
              Abrir
            </button>
          </li>
        ))}
      </ul>
      {simulation && (
        <section>
          <h2>Simulación guardada</h2>
          <p>
            Corte: {shortDate(simulation.request.cutoff_date)} ·{" "}
            {simulation.request.horizon} transiciones · semilla{" "}
            {simulation.request.seed}. Este experimento conserva su convención
            original, sin asignación posterior de fechas.
          </p>
          <p>
            Identificador: <code>{simulation.id}</code>
          </p>
          <button disabled={busy} onClick={() => void replay()}>
            Reproducir simulación guardada
          </button>
          {simulation.methods.map((model) => (
            <div key={model.method}>
              <h3>
                {methodNames[model.method]}
              </h3>
              <p>
                Mediana terminal: {money(model.bands.at(-1)?.median)} COP/USD.
              </p>
              <SimulationChart
                experiment={simulation}
                result={model}
                kind="paths"
              />
            </div>
          ))}
          <ExportButton
            path="/exports/simulation"
            filename="SIMTRM_simulacion.xlsx"
            label="Excel técnico del experimento"
            body={{ experiment_id: simulation.id, include_paths: true }}
          />
        </section>
      )}
      {rolling && <ValidationResults result={rolling} />}
      {backtest && (
        <section>
          <h2>Validación individual guardada</h2>
          <p>
            Conserva la evaluación original de la media simulada. No se cambia
            por la mediana al recuperar resultados.
          </p>
          <p>{backtest.convention}</p>
          <div className="table-scroll">
            <table>
              <caption>Evaluación original por observación</caption>
              <thead>
                <tr>
                  <th>Método</th>
                  <th>Fecha</th>
                  <th>Real</th>
                  <th>Media proyectada</th>
                  <th>Error absoluto</th>
                </tr>
              </thead>
              <tbody>
                {backtest.methods.flatMap((m) =>
                  m.points.map((p) => (
                    <tr key={`${m.method}:${p.step}`}>
                      <td>{m.method}</td>
                      <td>{shortDate(p.date)}</td>
                      <td>{money(p.actual)}</td>
                      <td>{money(p.predicted_mean)}</td>
                      <td>{money(p.absolute_error)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <ExportButton
            path={`/exports/backtest/${backtest.id}`}
            filename="SIMTRM_validacion.xlsx"
            label="Excel de la validación individual"
          />
        </section>
      )}
    </details>
  );
}
