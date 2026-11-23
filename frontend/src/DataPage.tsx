import { useEffect, useState } from "react";
import { queryString, request } from "./api";
import { money, shortDate, timestamp } from "./format";
import ExportButton from "./ExportButton";
import type { DataStatus, History, Latest, Statistics } from "./types";

export default function DataPage({
  status,
  latest,
  years,
  today,
  revision,
  refresh,
}: {
  status: DataStatus;
  latest: Latest | null;
  years: number[];
  today: string;
  revision: number;
  refresh: () => void;
}) {
  const [filters, setFilters] = useState({ start: "", end: "", year: "" });
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [calculation, setCalculation] = useState<{ key: string; revision: number; value: Statistics } | null>(null);
  const [calculating, setCalculating] = useState(false);
  const periodKey = queryString(filters);
  const stats = calculation?.key === periodKey && calculation.revision === revision ? calculation.value : null;
  const gapRanges = status.last_success?.audit.gap_ranges;
  const query = queryString({ ...filters, page, page_size: 20 });
  const invalid = !!(
    filters.start &&
    filters.end &&
    filters.start > filters.end
  );
  useEffect(() => {
    if (invalid) return;
    const controller = new AbortController();
    request<History>(`/trm/history?${query}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setHistory(data);
          setError("");
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [query, revision, invalid]);
  function filter(key: keyof typeof filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
    setLoading(true);
    setCalculation(null);
  }
  async function sync() {
    setSyncing(true);
    setSyncError("");
    setMessage("");
    try {
      await request("/data/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Admin-Token": token } : {}),
        },
        body: JSON.stringify({ mode: "full" }),
      });
      setMessage(
        "Actualización completada. Se conserva el histórico validado.",
      );
    } catch (e) {
      setSyncError(
        e instanceof Error ? e.message : "No fue posible actualizar los datos",
      );
    } finally {
      setSyncing(false);
      refresh();
    }
  }
  async function calibration() {
    setCalculating(true);
    try {
      const value = await request<Statistics>(
        `/trm/statistics?${queryString({ ...filters, variable: "log_return" })}`);
      setCalculation({key: periodKey, revision, value});
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No fue posible calcular los rendimientos",
      );
    } finally {
      setCalculating(false);
    }
  }
  return (
    <div className="data-page">
      <section className="panel analysis-audit">
        <h2>Fuente y cobertura</h2>
        <p>
          <a href={status.source_url} target="_blank" rel="noreferrer">
            {status.source}
          </a>{" "}
          · {status.total.toLocaleString("es-CO")} vigencias almacenadas.
        </p>
        <p>
          Desde {shortDate(status.first?.valid_from)} hasta{" "}
          {shortDate(status.last?.valid_to)}. Última actualización comprobada:{" "}
          {timestamp(status.last_success?.finished_at)}.
        </p>
        <p>
          TRM vigente: {money(latest?.record?.value)} COP/USD ·{" "}
          {shortDate(latest?.record?.valid_from)} al{" "}
          {shortDate(latest?.record?.valid_to)}.
        </p>
        {status.last && status.last.valid_from > today && (
          <p>
            Publicación con vigencia futura: {money(status.last.value)} COP/USD
            desde {shortDate(status.last.valid_from)}. No se incorpora al
            entrenamiento anterior a esa fecha.
          </p>
        )}
        {(status.state === "source_error" ||
          (latest && latest.state !== "current")) && (
          <p role="status">
            La información puede estar desactualizada. Compruebe la fuente antes
            de proyectar.
          </p>
        )}
        {status.manual_sync_available !== false ? <details>
          <summary>Actualizar histórico oficial</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sync();
            }}
          >
            <div className="filters">
              <label>
                Clave de actualización (si está configurada)
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <button className="primary" disabled={syncing}>
                {syncing
                  ? "Consultando fuente…"
                  : "Comprobar nuevas publicaciones"}
              </button>
            </div>
          </form>
          {syncError && (
            <p className="error-box" role="alert">
              {syncError}
            </p>
          )}
          {message && <p role="status">{message}</p>}
        </details> : <p>El histórico oficial se actualiza automáticamente. La actualización manual está reservada a la administración.</p>}
        <details>
          <summary>Integridad y actualización automática</summary>
          <p>
            Zona horaria: {status.timezone}. Huella:{" "}
            <code>{status.dataset_fingerprint}</code>. Versiones conservadas:{" "}
            {status.stored_versions}.
          </p>
          <p>
            Actualización automática:{" "}
            {status.auto_sync_enabled
              ? `cada ${status.auto_sync_interval_hours} horas`
              : "desactivada"}
            . Próxima comprobación: {timestamp(status.next_auto_check_at)}.
          </p>
          <dl className="audit-grid">
            {Object.entries(status.last_success?.audit ?? {}).filter(([key]) =>
              ["gaps", "missing_days", "overlaps", "duplicates", "extended", "rejected", "conflicts", "observed_days"].includes(key)).map(
              ([key, value]) => (
                <div key={key}>
                  <dt>
                    {(
                      {
                        gaps: "Huecos",
                        overlaps: "Solapamientos",
                        extended: "Vigencias extendidas",
                        rejected: "Rechazados",
                        conflicts: "Conflictos",
                        duplicates: "Duplicados",
                        missing_days: "Días sin observación",
                        observed_days: "Observaciones diarias originales",
                      } as Record<string, string>
                    )[key] ?? key}
                  </dt>
                  <dd>{String(value)}</dd>
                </div>
              ),
            )}
          </dl>
          {Array.isArray(gapRanges) && gapRanges.length > 0 && <p>Fechas sin observación: {gapRanges.map(g =>
            `${shortDate(g.start)} al ${shortDate(g.end)}`).join('; ')}. No se completan con estimaciones.</p>}
        </details>
      </section>
      <section className="panel table-panel">
        <div className="section-heading">
          <div>
            <h2>Registros oficiales para entrenamiento</h2>
            <p>
              Los datos utilizados por una proyección se conservan en su
              experimento y en su Excel.
            </p>
          </div>
        </div>
        <div className="filters data-filters">
          <label>
            Año
            <select
              aria-label="Año"
              value={filters.year}
              onChange={(e) => filter("year", e.target.value)}
            >
              <option value="">Todos</option>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </label>
          <label>
            Desde
            <input
              type="date"
              value={filters.start}
              onChange={(e) => filter("start", e.target.value)}
            />
          </label>
          <label>
            Hasta
            <input
              type="date"
              value={filters.end}
              onChange={(e) => filter("end", e.target.value)}
            />
          </label>
        </div>
        {invalid && (
          <p className="error-box" role="alert">
            La fecha inicial debe ser anterior o igual a la final.
          </p>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
            <button onClick={refresh}>Reintentar</button>
          </div>
        )}
        {loading && !invalid && (
          <p className="analysis-table-note" role="status">
            Consultando registros…
          </p>
        )}
        {!invalid && (
          <>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Registros oficiales desplazables"
            >
              <table>
                <caption className="sr-only">Histórico oficial de TRM</caption>
                <thead>
                  <tr>
                    <th>Vigencia desde</th>
                    <th>Vigencia hasta</th>
                    <th>TRM COP/USD</th>
                  </tr>
                </thead>
                <tbody>
                  {!loading && history?.items.map((r) => (
                    <tr key={r.id}>
                      <td>{shortDate(r.valid_from)}</td>
                      <td>{shortDate(r.valid_to)}</td>
                      <td>{money(r.value)}</td>
                    </tr>
                  ))}
                  {!loading && history?.total === 0 && <tr><td colSpan={3}>No hay registros en el periodo seleccionado.</td></tr>}
                </tbody>
              </table>
            </div>
            {history && (
              <div className="pagination">
                <span>
                  {history.total} registros · Página {history.page} de{" "}
                  {history.pages || 1}
                </span>
                <div>
                  <button
                    disabled={page <= 1}
                    onClick={() => {
                      setPage((p) => p - 1);
                      setLoading(true);
                    }}
                  >
                    Anterior
                  </button>
                  <button
                    disabled={page >= history.pages}
                    onClick={() => {
                      setPage((p) => p + 1);
                      setLoading(true);
                    }}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            )}
            <div className="data-actions">
              <ExportButton
                path={`/exports/history?${queryString(filters)}`}
                filename="SIMTRM_historico.xlsx"
                label="Excel del histórico consultado"
                disabled={loading || !history?.total}
              />
              <button
                disabled={loading || calculating || !history?.total}
                onClick={() => void calibration()}
              >
                {calculating ? "Calculando rendimientos…" : "Consultar rendimientos del periodo"}
              </button>
            </div>
          </>
        )}
        {stats && (
          <section className="analysis-audit">
            <h3>Rendimientos para calibración</h3>
            <p>
              {stats.volatility.log_return_count} rendimientos · media
              logarítmica {stats.summary.mean?.toFixed(6) ?? "—"} · desviación
              muestral {stats.summary.sample_std?.toFixed(6) ?? "—"} ·
              transiciones excluidas por huecos: {stats.excluded_gap_pairs}.
            </p>
            <p>
              Los modelos usan los rendimientos del entrenamiento guardado, no
              el filtro de esta consulta.
            </p>
            <ExportButton path={`/exports/statistics?${queryString({...filters, variable: 'log_return'})}`}
              filename="SIMTRM_rendimientos.xlsx" label="Excel de los rendimientos" />
          </section>
        )}
      </section>
    </div>
  );
}
