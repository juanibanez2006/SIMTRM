import { useEffect, useState } from "react";
import { queryString, request } from "./api";
import { shortDate, timestamp } from "./format";
import { methodNames } from "./projectionSettings";
import ExportButton from "./ExportButton";
import type { EvaluationHistoryPage } from "./types";

const emptyFilters = { q: "", start: "", end: "", method: "", horizon: "", unit: "" };

export default function EvaluationHistory({ revision, selectedId, busy, onOpen, onNew }: {
  revision: number;
  selectedId?: string;
  busy: boolean;
  onOpen: (id: string) => Promise<void>;
  onNew: () => void;
}) {
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string; data?: EvaluationHistoryPage; error?: string;
  } | null>(null);
  const query = queryString({ ...filters, page, page_size: pageSize });
  const key = `${query}|${revision}|${retry}`;
  const loading = loaded?.key !== key;
  const data = !loading ? loaded?.data : undefined;
  const error = !loading ? loaded?.error : undefined;
  const filtered = Object.values(filters).some(Boolean);
  useEffect(() => {
    const controller = new AbortController();
    request<EvaluationHistoryPage>(`/validations/rolling?${query}`, { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) setLoaded({ key, data });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setLoaded({ key, error: error.message });
      });
    return () => controller.abort();
  }, [query, key]);

  return <section className="panel table-panel evaluation-history" aria-label="Mis evaluaciones">
    <div className="section-heading">
      <div><h2>Mis evaluaciones</h2>
        <p>Resultados guardados, del más reciente al más antiguo. Fechas y horas de Colombia.</p></div>
      <button type="button" onClick={onNew}>Nueva evaluación</button>
    </div>
    <form className="evaluation-filters" onSubmit={event => {
      event.preventDefault(); setFilters({ ...draft }); setPage(1); setRetry(n => n + 1);
    }}>
      <label>Buscar evaluaciones<input type="search" maxLength={100} value={draft.q}
          placeholder="Método, fecha o parámetros" onChange={e => setDraft(f => ({ ...f, q: e.target.value }))} /></label>
      <details className="evaluation-filter-options">
        <summary>Filtros por fecha, método y horizonte</summary>
        <div className="filters">
        <label>Creada desde<input type="date" value={draft.start} max={draft.end || undefined}
          onChange={e => setDraft(f => ({ ...f, start: e.target.value }))} /></label>
        <label>Creada hasta<input type="date" value={draft.end} min={draft.start || undefined}
          onChange={e => setDraft(f => ({ ...f, end: e.target.value }))} /></label>
        <label>Método guardado<select value={draft.method} onChange={e => setDraft(f => ({ ...f, method: e.target.value }))}>
          <option value="">Todos los métodos</option>
          {Object.entries(methodNames).map(([method, name]) => <option key={method} value={method}>{name}</option>)}
        </select></label>
        <label>Horizonte guardado<input type="number" min={1} max={365} step={1} value={draft.horizon}
          placeholder="Cualquiera" onChange={e => setDraft(f => ({ ...f, horizon: e.target.value }))} /></label>
        <label>Unidad del horizonte<select value={draft.unit} onChange={e => setDraft(f => ({ ...f, unit: e.target.value }))}>
          <option value="">Todas las unidades</option><option value="calendar_days">Días calendario</option>
          <option value="transitions">Transiciones</option>
        </select></label>
        </div>
      </details>
      <div className="evaluation-actions">
        <button type="submit">Buscar</button>
        <button type="button" onClick={() => {
          setDraft(emptyFilters); setFilters(emptyFilters); setPage(1); setRetry(n => n + 1);
        }}>Limpiar filtros</button>
        <button type="button" disabled={loading} onClick={() => setRetry(n => n + 1)}>Actualizar lista</button>
      </div>
    </form>
    {loading && <p role="status">Cargando evaluaciones…</p>}
    {error && <div className="error-box" role="alert">{error}
      <button type="button" onClick={() => setRetry(n => n + 1)}>Reintentar consulta</button></div>}
    {data && <>
      {data.items.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Evaluaciones guardadas desplazables">
        <table><caption className="sr-only">Evaluaciones guardadas y parámetros originales</caption>
          <thead><tr><th>Creación y método</th><th>Horizontes</th><th>Cortes y entrenamiento</th><th>Parámetros</th><th>Acciones</th></tr></thead>
          <tbody>{data.items.map(entry => <tr key={entry.id} className={selectedId === entry.id ? "selected-evaluation" : ""}>
            <td><time dateTime={entry.created_at}>{timestamp(entry.created_at)}</time><br />
              <strong>{methodNames[entry.request.settings.method]}</strong></td>
            <td data-label="Horizontes">{entry.request.horizons.join(", ")}<br />{entry.request.unit === "calendar_days" ? "días calendario" : "transiciones"}</td>
            <td data-label="Entrenamiento">{entry.evaluated_folds} de {entry.request.folds} cortes<br />
              Ventana: {entry.request.settings.training_records.toLocaleString("es-CO")} vigencias
              {entry.skipped > 0 && <><br />{entry.skipped} omitidos por huecos</>}
              {entry.request.last_cutoff && <><br />Hasta {shortDate(entry.request.last_cutoff)}</>}
            </td>
            <td data-label="Parámetros">{entry.request.settings.replicas.toLocaleString("es-CO")} réplicas<br />
              Semilla: {entry.request.settings.seed}<br />
              Volatilidad × {entry.request.settings.volatility_scale ?? 1}</td>
            <td><div className="evaluation-row-actions">
              <button type="button" disabled={busy} onClick={() => void onOpen(entry.id)}>
                {selectedId === entry.id ? "Ver resultados abiertos" : "Abrir resultados"}</button>
              <ExportButton path={`/exports/rolling/${entry.id}`} filename="SIMTRM_evaluacion.xlsx" label="Descargar Excel" />
            </div></td>
          </tr>)}</tbody>
        </table>
      </div> : <p role="status">{filtered
        ? "No hay evaluaciones que coincidan con la búsqueda. Pruebe otros filtros."
        : data.total ? "Esta página no contiene evaluaciones. Regrese a la primera página."
          : "Aún no hay evaluaciones guardadas. Ejecute una evaluación para comenzar."}</p>}
      <div className="pagination" aria-label="Paginación de evaluaciones">
        <span>{data.total} evaluaciones · Página {data.page} de {Math.max(1, data.pages)}</span>
        <label>Evaluaciones por página<select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}>
          {[5, 10, 20].map(size => <option key={size} value={size}>{size}</option>)}
        </select></label>
        <div><button type="button" disabled={page === 1} onClick={() => setPage(1)}>Primera página</button>
          <button type="button" disabled={page === 1} onClick={() => setPage(n => n - 1)}>Anterior</button>
          <button type="button" disabled={page >= data.pages} onClick={() => setPage(n => n + 1)}>Siguiente</button></div>
      </div>
    </>}
  </section>;
}
