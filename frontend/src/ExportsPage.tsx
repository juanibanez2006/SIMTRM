import { useState } from "react";
import ExportButton from "./ExportButton";

export default function ExportsPage({
  navigate,
}: {
  navigate: (
    page: "history" | "statistics" | "comparison" | "simulation" | "backtest",
  ) => void;
}) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState("simulation");
  const [paths, setPaths] = useState(true);
  const valid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id.trim(),
    );
  return (
    <div>
      <section className="panel audit-panel">
        <p className="eyebrow">DESCARGAS</p>
        <h2>Descargar información y resultados</h2>
        <p>
          Descargue el histórico y los resultados de sus análisis en Excel, con
          los periodos, parámetros y fuentes correspondientes. Cada módulo
          exporta el conjunto seleccionado completo, aunque la tabla muestre
          solo una parte.
        </p>
        <ExportButton
          path="/exports/history"
          filename="SIMTRM_historico.xlsx"
          label="Descargar todo el histórico"
        />
      </section>
      <div className="exports-grid">
        {(
          [
            {
              page: "history",
              title: "Histórico filtrado",
              text: "Seleccione año, mes o fechas y descargue todos los registros del periodo.",
            },
            {
              page: "statistics",
              title: "Estadística descriptiva",
              text: "Incluye indicadores, precios usados, rendimientos, frecuencias y volatilidad móvil.",
            },
            {
              page: "comparison",
              title: "Comparación de periodos",
              text: "Conserva ambas muestras, sus indicadores, diferencias y alineación completa.",
            },
            {
              page: "simulation",
              title: "Simulaciones",
              text: "Exporta el experimento guardado, su entrenamiento y todas las trayectorias.",
            },
            {
              page: "backtest",
              title: "Validación retrospectiva",
              text: "Descarga datos de entrenamiento y evaluación, errores, cobertura y diagnósticos.",
            },
          ] as const
        ).map((item) => (
          <section className="panel audit-panel" key={item.page}>
            <h2>{item.title}</h2>
            <p>{item.text}</p>
            <button className="text-button" onClick={() => navigate(item.page)}>
              Abrir {item.title.toLowerCase()} →
            </button>
          </section>
        ))}
      </div>
      <section className="panel audit-panel">
        <h2>Descargar un resultado guardado</h2>
        <p>
          Use el identificador que aparece al ejecutar una simulación o
          validación.
        </p>
        <div className="filters">
          <label>
            Tipo de resultado
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="simulation">Simulación</option>
              <option value="backtest">Validación retrospectiva</option>
            </select>
          </label>
          <label>
            Identificador del resultado
            <input
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="Pegue el identificador del resultado"
            />
          </label>
        </div>
        {kind === "simulation" && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={paths}
              onChange={(event) => setPaths(event.target.checked)}
            />
            Incluir todas las trayectorias guardadas
          </label>
        )}
        <ExportButton
          path={
            kind === "simulation"
              ? "/exports/simulation"
              : `/exports/backtest/${id.trim()}`
          }
          body={
            kind === "simulation"
              ? { experiment_id: id.trim(), include_paths: paths }
              : undefined
          }
          filename="SIMTRM_resultado.xlsx"
          label="Descargar resultado guardado"
          disabled={!valid}
        />
      </section>
    </div>
  );
}
