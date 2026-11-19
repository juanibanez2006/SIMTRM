import ExportButton from "./ExportButton";
import { useState } from "react";
import PlotChart from "./PlotChart";
import { money, shortDate } from "./format";
import { methodNames } from "./projectionSettings";
import type { RollingEvaluation } from "./types";

export default function ValidationResults({
  result,
}: {
  result: RollingEvaluation;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const horizon = result.summaries.some(s => s.horizon === selected) ? selected! : result.summaries[0]?.horizon;
  const cases = result.cases.filter(c => c.horizon === horizon);
  return (
    <section className="panel table-panel">
      <div className="section-heading">
        <div>
          <h2>Errores por horizonte frente a persistencia</h2>
          <p>
            Horizonte en{" "}
            {result.request.unit === "calendar_days"
              ? "días calendario"
              : "transiciones"}
            . {methodNames[result.request.settings.method]} · mediana de{" "}
            {result.request.settings.replicas} réplicas · ventana de{" "}
            {result.request.settings.training_records} vigencias · semilla{" "}
            {result.request.settings.seed}.
          </p>
        </div>
      </div>
      <div className="analysis-audit">
        <label>Horizonte del gráfico
          <select aria-label="Horizonte del gráfico" value={horizon} onChange={e => setSelected(Number(e.target.value))}>
            {result.summaries.map(s => <option key={s.horizon} value={s.horizon}>{s.horizon} {result.request.unit === 'calendar_days' ? 'días' : 'transiciones'}</option>)}
          </select>
        </label>
        <PlotChart temporal label="Proyecciones retrospectivas frente a TRM observada"
          viewKey={`${result.id}:${horizon}`} fallback="Consulte la tabla de errores por horizonte."
          data={[
            {type: 'scatter', mode: 'markers', name: 'Mediana e intervalo del 90 %',
              x: cases.map(c => c.target), y: cases.map(c => c.predicted),
              marker: {color: '#bc5f16', size: 9},
              error_y: {type: 'data', symmetric: false, array: cases.map(c => c.upper - c.predicted),
                arrayminus: cases.map(c => c.predicted - c.lower), color: '#bc5f16'},
              hovertemplate: '%{x|%d/%m/%Y}<br>Mediana: %{y:,.2f} COP/USD<extra>Validación</extra>'},
            {type: 'scatter', mode: 'markers', name: 'TRM observada', x: cases.map(c => c.target),
              y: cases.map(c => c.actual), marker: {color: '#173d64', size: 10, symbol: 'diamond'}},
            {type: 'scatter', mode: 'markers', name: 'Persistencia', x: cases.map(c => c.target),
              y: cases.map(c => c.initial), marker: {color: '#66798a', size: 9, symbol: 'x'}},
          ]} layout={{height: 350, margin: {l: 75, r: 20, t: 70, b: 55},
            legend: {orientation: 'h', y: 1.23}, xaxis: {type: 'date'},
            yaxis: {title: {text: 'COP/USD'}, tickformat: ',.2f'}}} />
      </div>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Métricas de validación desplazables"
      >
        <table>
          <caption>
            Errores terminales en COP/USD, agrupados por horizonte
          </caption>
          <thead>
            <tr>
              <th>Horizonte</th>
              <th>Cortes</th>
              <th>MAE modelo</th>
              <th>MAE referencia</th>
              <th>RMSE modelo</th>
              <th>RMSE referencia</th>
              <th>Cobertura P5–P95</th>
              <th>Amplitud media</th>
            </tr>
          </thead>
          <tbody>
            {result.summaries.map((row) => (
              <tr key={row.horizon}>
                <td>{row.horizon}</td>
                <td>{row.count}</td>
                <td>{money(row.model.mae)}</td>
                <td>{money(row.baseline.mae)}</td>
                <td>{money(row.model.rmse)}</td>
                <td>{money(row.baseline.rmse)}</td>
                <td>
                  {row.model.coverage === null
                    ? "—"
                    : new Intl.NumberFormat("es-CO", {
                        style: "percent",
                        maximumFractionDigits: 1,
                      }).format(row.model.coverage)}
                </td>
                <td>{money(row.mean_width)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        MAE: error absoluto medio. RMSE: raíz del error cuadrático medio.
        Valores menores indican menos error en estos cortes. Compare también la
        cobertura con la amplitud del intervalo. No se afirma superioridad
        futura.
      </p>
      <ul>
        {result.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <ExportButton
        path={`/exports/rolling/${result.id}`}
        filename="SIMTRM_evaluacion.xlsx"
        label="Excel de la evaluación en varios cortes"
      />
      <details className="analysis-audit">
        <summary>Valores por corte y trazabilidad</summary>
        <p>{result.convention}</p>
        <p>
          Identificador: <code>{result.id}</code>
        </p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Valores por corte desplazables"
        >
          <table>
            <caption>Proyecciones evaluadas</caption>
            <thead>
              <tr>
                <th>Corte</th>
                <th>Fecha observada</th>
                <th>Horizonte</th>
                <th>Inicial</th>
                <th>Mediana</th>
                <th>Real</th>
                <th>Error absoluto COP/USD</th>
                <th>Error porcentual</th>
                <th>Modelo</th>
                <th>Vigencia real</th>
                <th>Pasos simulados</th>
                <th>P5</th>
                <th>P95</th>
                <th>Experimento</th>
              </tr>
            </thead>
            <tbody>
              {result.cases.map((row) => (
                <tr key={row.experiment_id}>
                  <td>{shortDate(row.cutoff)}</td>
                  <td>{shortDate(row.target)}</td>
                  <td>{row.horizon}</td>
                  <td>{money(row.initial)}</td>
                  <td>{money(row.predicted)}</td>
                  <td>{money(row.actual)}</td>
                  <td>
                    {money(
                      row.absolute_error ??
                        Math.abs(row.predicted - row.actual),
                    )}
                  </td>
                  <td>
                    {new Intl.NumberFormat("es-CO", {
                      style: "percent",
                      maximumFractionDigits: 2,
                    }).format(
                      row.relative_error ??
                        Math.abs(row.predicted / row.actual - 1),
                    )}
                  </td>
                  <td>
                    {methodNames[row.model ?? result.request.settings.method]}
                  </td>
                  <td>
                    {shortDate(row.target_valid_from ?? row.target)} al{" "}
                    {shortDate(row.target_valid_to ?? row.target)}
                  </td>
                  <td>
                    {row.simulated_steps ?? row.horizon}
                    {row.calendar_matches === false
                      ? " · calendario distinto"
                      : ""}
                  </td>
                  <td>{money(row.lower)}</td>
                  <td>{money(row.upper)}</td>
                  <td>
                    <code>{row.experiment_id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
