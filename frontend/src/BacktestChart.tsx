import { useMemo } from "react";
import PlotChart from "./PlotChart";
import { backtestPlot } from "./backtestPlots";
import type { Backtest } from "./types";
export default function BacktestChart({
  result,
  index,
}: {
  result: Backtest;
  index: number;
}) {
  const figure = useMemo(() => backtestPlot(result, index), [result, index]);
  return (
    <PlotChart
      {...figure}
      temporal
      viewKey={result.id}
      label="Validación: datos reales posteriores al corte, media simulada y persistencia"
      fallback="No se pudo mostrar el gráfico. Consulte los errores por paso en la tabla."
    />
  );
}
