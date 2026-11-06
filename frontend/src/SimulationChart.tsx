import { useMemo } from "react";
import PlotChart from "./PlotChart";
import { simulationPlot } from "./simulationPlots";
import type { SimulationPlotKind } from "./simulationPlots";
import type { Simulation, SimulationMethodResult } from "./types";
export default function SimulationChart({
  experiment,
  result,
  kind,
}: {
  experiment: Simulation;
  result: SimulationMethodResult;
  kind: SimulationPlotKind;
}) {
  const figure = useMemo(
    () => simulationPlot(experiment, result, kind),
    [experiment, result, kind],
  );
  return (
    <PlotChart
      {...figure}
      temporal={kind !== "terminal"}
      viewKey={`${experiment.id}:${kind}`}
      label={
        kind === "paths"
          ? "Escenarios simulados y bandas marginales de percentiles"
          : kind === "terminal"
            ? "Distribución de precios terminales simulados"
            : "Referencia histórica oficial del entrenamiento"
      }
      fallback="No se pudo mostrar el gráfico. Consulte los indicadores y las tablas del experimento."
    />
  );
}
