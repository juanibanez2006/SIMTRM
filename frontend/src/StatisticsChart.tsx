import { useMemo } from "react";
import PlotChart from "./PlotChart";
import { plotTitles, statisticsPlot } from "./statisticsPlots";
import type { StatisticsPlotKind } from "./statisticsPlots";
import type { Statistics } from "./types";
export default function StatisticsChart({
  stats,
  kind,
}: {
  stats: Statistics;
  kind: StatisticsPlotKind;
}) {
  const figure = useMemo(() => statisticsPlot(stats, kind), [stats, kind]);
  return (
    <PlotChart
      {...figure}
      temporal={kind === "series" || kind === "volatility"}
      viewKey={`${kind}:${stats.variable}:${JSON.stringify(stats.filters)}`}
      className="statistics-chart"
      label={`${plotTitles[kind]} · ${stats.summary.count} observaciones de la variable seleccionada`}
      fallback={`No se pudo mostrar ${plotTitles[kind].toLowerCase()}. Consulte las tablas y los indicadores de este módulo.`}
    />
  );
}
