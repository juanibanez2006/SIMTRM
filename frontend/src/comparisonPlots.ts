import type { Data, Layout } from "plotly.js";
import type { Comparison, ComparisonScale } from "./types";

export function comparisonPlot(
  comparison: Comparison,
  scale: ComparisonScale,
  kind: "overlay" | "bars",
): { data: Data[]; layout: Partial<Layout> } {
  const layout: Partial<Layout> = {
    height: 340,
    autosize: true,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    margin: { l: 74, r: 25, t: 20, b: 65 },
    separators: ",.",
    font: { family: "Segoe UI, sans-serif", color: "#607381", size: 11 },
    legend: { orientation: "h", x: 0, y: 1.13 },
    hovermode: "closest",
    xaxis: {
      title: {
        text:
          comparison.alignment === "observation"
            ? "Número de observación (desde 1)"
            : "Días calendario desde el inicio solicitado (desde 0)",
      },
      showgrid: false,
      zeroline: false,
      tickformat: "d",
    },
    yaxis: {
      title: {
        text:
          scale === "normalized"
            ? "Índice · primer valor = 100"
            : "COP por USD",
      },
      gridcolor: "#e9eef0",
      zeroline: false,
      tickformat: ",.2f",
    },
  };
  const data: Data[] = [];
  (["a", "b"] as const).forEach((id, index) => {
    const period = comparison[id];
    const marker = { color: index === 0 ? "#147d83" : "#b8804c" };
    const name = `Periodo ${id.toUpperCase()}`;
    if (kind === "bars") {
      const metrics = ["mean", "median", "minimum", "maximum"] as const;
      data.push({
        type: "bar",
        name,
        marker,
        x: ["Media", "Mediana", "Mínimo", "Máximo"],
        y: metrics.map((metric) => period.metrics[metric]),
        hovertemplate: "%{x}: %{y:,.4f} COP/USD<extra>%{fullData.name}</extra>",
      });
      return;
    }
    const x: (number | null)[] = [],
      y: (number | null)[] = [],
      customdata: string[][] = [];
    for (const point of period.points) {
      if (point.gap_before) {
        x.push(null);
        y.push(null);
        customdata.push(["", "", ""]);
      }
      const value =
        scale === "normalized" ? point.normalized : Number(point.value);
      x.push(point.position);
      y.push(value);
      customdata.push([point.effective_date, point.date, point.valid_to]);
      if (
        comparison.alignment === "elapsed_days" &&
        point.effective_until > point.effective_date
      ) {
        const duration =
          (Date.parse(point.effective_until) -
            Date.parse(point.effective_date)) /
          86_400_000;
        x.push(point.position + duration);
        y.push(value);
        customdata.push([point.effective_until, point.date, point.valid_to]);
      }
    }
    data.push({
      type: "scatter",
      mode: "lines+markers",
      name,
      x,
      y,
      customdata,
      connectgaps: false,
      line: { color: marker.color, width: 2 },
      marker: { color: marker.color, size: 3 },
      hovertemplate: `Fecha mostrada: %{customdata[0]}<br>Vigencia original: %{customdata[1]} a %{customdata[2]}<br>%{y:,.4f} ${scale === "normalized" ? "(índice base 100)" : "COP/USD"}<extra>%{fullData.name}</extra>`,
    });
  });
  return {
    data,
    layout:
      kind === "bars"
        ? {
            ...layout,
            barmode: "group",
            xaxis: {},
            yaxis: {
              ...layout.yaxis,
              title: { text: "COP por USD · niveles originales" },
              rangemode: "tozero",
            },
          }
        : layout,
  };
}
