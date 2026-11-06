import type { Data, Layout } from "plotly.js";
import type { Backtest } from "./types";

export function backtestPlot(
  result: Backtest,
  index: number,
): { data: Data[]; layout: Partial<Layout> } {
  const model = result.methods[index];
  const dates = model.points.map((point) => point.date);
  const data: Data[] = [
    {
      type: "scatter",
      mode: "lines",
      x: dates,
      y: model.points.map((point) => point.p5),
      line: { width: 0 },
      showlegend: false,
      hoverinfo: "skip",
    },
    {
      type: "scatter",
      mode: "lines",
      x: dates,
      y: model.points.map((point) => point.p95),
      line: { width: 0 },
      fill: "tonexty",
      fillcolor: "rgba(20,125,131,.14)",
      name: "P5–P95 simulado",
      hovertemplate: "%{x}<br>P95: %{y:,.2f}<extra>Banda marginal</extra>",
    },
    {
      type: "scatter",
      mode: "lines+markers",
      x: dates,
      y: model.points.map((point) => point.actual),
      name: "TRM real posterior al corte",
      line: { color: "#173d64", width: 2.5 },
      hovertemplate: "%{x}<br>Real: %{y:,.2f}<extra>Dato oficial</extra>",
    },
    {
      type: "scatter",
      mode: "lines",
      x: dates,
      y: model.points.map((point) => point.predicted_mean),
      name: "Media simulada",
      line: { color: "#147d83", width: 2 },
      hovertemplate: "%{x}<br>Media: %{y:,.2f}<extra>Modelo</extra>",
    },
    {
      type: "scatter",
      mode: "lines",
      x: dates,
      y: model.points.map(() => result.initial_price),
      name: "Persistencia P0",
      line: { color: "#a37b54", dash: "dot", width: 2 },
    },
  ];
  return {
    data,
    layout: {
      height: 360,
      autosize: true,
      margin: { l: 75, r: 24, t: 40, b: 60 },
      separators: ",.",
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { family: "Segoe UI, sans-serif", size: 11, color: "#607381" },
      legend: { orientation: "h", y: 1.18 },
      xaxis: {
        type: "date",
        title: { text: "Inicio de vigencia de cada observación evaluada" },
        showgrid: false,
      },
      yaxis: {
        title: { text: "COP por USD" },
        gridcolor: "#e9eef0",
        tickformat: ",.2f",
        zeroline: false,
      },
    },
  };
}
