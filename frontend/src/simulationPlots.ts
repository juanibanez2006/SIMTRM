import type { Data, Layout } from "plotly.js";
import type { Simulation, SimulationMethodResult } from "./types";

export type SimulationPlotKind = "paths" | "terminal" | "history";
export function simulationPlot(
  experiment: Simulation,
  result: SimulationMethodResult,
  kind: SimulationPlotKind,
): { data: Data[]; layout: Partial<Layout> } {
  const layout: Partial<Layout> = {
    height: 365,
    autosize: true,
    margin: { l: 75, r: 25, t: 30, b: 65 },
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    separators: ",.",
    font: { family: "Segoe UI, sans-serif", size: 11, color: "#607381" },
    legend: { orientation: "h", x: 0, y: 1.15 },
    xaxis: {
      title: { text: "Paso del modelo" },
      showgrid: false,
      tickformat: "d",
    },
    yaxis: {
      title: { text: "COP por USD" },
      gridcolor: "#e9eef0",
      zeroline: false,
      tickformat: ",.2f",
    },
  };
  if (kind === "history") {
    const x: (string | null)[] = [],
      y: (number | null)[] = [];
    experiment.training.history.forEach((point, index, points) => {
      if (
        index &&
        Date.parse(point.date) - Date.parse(points[index - 1].valid_to) >
          86_400_000
      ) {
        x.push(null);
        y.push(null);
      }
      x.push(point.date);
      y.push(Number(point.value));
      if (point.extended) {
        x.push(point.valid_to);
        y.push(Number(point.value));
      }
    });
    return {
      data: [
        {
          type: "scatter",
          mode: "lines",
          name: "TRM histórica oficial",
          x,
          y,
          connectgaps: false,
          line: { color: "#173d64", width: 2 },
          hovertemplate:
            "%{x|%d/%m/%Y}<br>%{y:,.2f} COP/USD<extra>Dato histórico</extra>",
        },
      ],
      layout: {
        ...layout,
        height: 280,
        xaxis: {
          type: "date",
          title: { text: "Fecha de vigencia" },
          showgrid: false,
        },
      },
    };
  }
  if (kind === "terminal")
    return {
      data: [
        {
          type: "bar",
          x: result.histogram.map((bin) => (bin.lower + bin.upper) / 2),
          y: result.histogram.map((bin) => bin.frequency),
          width: result.histogram.map((bin) => bin.upper - bin.lower),
          marker: { color: "#ad8057", line: { color: "white", width: 1 } },
          customdata: result.histogram.map((bin) => [
            bin.lower,
            bin.upper,
            bin.relative_frequency,
          ]),
          hovertemplate:
            "[%{customdata[0]:,.2f}, %{customdata[1]:,.2f}] COP/USD<br>Réplicas: %{y}<br>Proporción: %{customdata[2]:.2%}<extra>Precios terminales simulados</extra>",
        },
      ],
      layout: {
        ...layout,
        showlegend: false,
        bargap: 0,
        xaxis: { title: { text: "Precio terminal · COP/USD" } },
        yaxis: {
          ...layout.yaxis,
          title: { text: "Frecuencia de réplicas" },
          rangemode: "tozero",
        },
      },
    };
  const steps = result.bands.map((point) => point.step);
  const data: Data[] = [];
  data.push({
    type: "scatter",
    mode: "lines",
    x: steps,
    y: result.bands.map((point) => point.p5),
    line: { width: 0 },
    name: "P5",
    showlegend: false,
    hoverinfo: "skip",
  });
  data.push({
    type: "scatter",
    mode: "lines",
    x: steps,
    y: result.bands.map((point) => point.p95),
    fill: "tonexty",
    fillcolor: "rgba(30,139,134,.15)",
    line: { width: 0 },
    name: "Banda marginal P5–P95",
    hovertemplate: "Paso %{x}<br>P95: %{y:,.2f}<extra>Banda marginal</extra>",
  });
  result.paths.forEach((path, index) =>
    data.push({
      type: "scatter",
      mode: "lines",
      x: steps,
      y: path,
      name: `Réplica ${index + 1}`,
      showlegend: index === 0,
      legendgroup: "paths",
      line: { color: "rgba(92,160,151,.28)", width: 1 },
      hovertemplate: `Paso %{x}<br>%{y:,.2f} COP/USD<extra>Réplica ${index + 1}</extra>`,
    }),
  );
  data.push({
    type: "scatter",
    mode: "lines",
    x: steps,
    y: result.bands.map((point) => point.mean),
    name: "Media por paso (resumen)",
    line: { color: "#147d83", width: 2.5 },
    hovertemplate:
      "Paso %{x}<br>Media: %{y:,.2f} COP/USD<extra>Resumen, no trayectoria</extra>",
  });
  data.push({
    type: "scatter",
    mode: "lines",
    x: steps,
    y: result.bands.map((point) => point.median),
    name: "Mediana por paso",
    line: { color: "#b47e4d", width: 2, dash: "dot" },
    hovertemplate:
      "Paso %{x}<br>Mediana: %{y:,.2f} COP/USD<extra>Resumen</extra>",
  });
  return { data, layout };
}
