import { useMemo } from "react";
import PlotChart from "./PlotChart";
import { comparisonPlot } from "./comparisonPlots";
import type { Comparison, ComparisonScale } from "./types";
export default function ComparisonChart({
  comparison,
  scale,
  kind,
}: {
  comparison: Comparison;
  scale: ComparisonScale;
  kind: "overlay" | "bars";
}) {
  const figure = useMemo(
    () => comparisonPlot(comparison, scale, kind),
    [comparison, scale, kind],
  );
  return (
    <PlotChart
      {...figure}
      temporal={kind === "overlay"}
      viewKey={`${comparison.alignment}:${comparison.a.requested_start}:${comparison.a.requested_end}:${comparison.b.requested_start}:${comparison.b.requested_end}`}
      label={`${kind === "overlay" ? "Series superpuestas" : "Barras de indicadores"} · ${kind === "bars" || scale === "price" ? "COP/USD" : "base 100"}`}
      fallback="No se pudo dibujar el gráfico comparativo. Los valores están disponibles en las tablas."
    />
  );
}
