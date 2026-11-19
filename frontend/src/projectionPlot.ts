import type { Data, Layout } from "plotly.js";
import type { Projection } from "./types";

export function projectionPlot(result: Projection): {
  data: Data[];
  layout: Partial<Layout>;
} {
  const hx: (string | null)[] = [],
    hy: (number | null)[] = [];
  (result.history ?? result.experiment.training.history).forEach(
    (row, i, rows) => {
      if (
        i &&
        Date.parse(row.date) - Date.parse(rows[i - 1].valid_to) > 86_400_000
      ) {
        hx.push(null);
        hy.push(null);
      }
      hx.push(row.date);
      hy.push(Number(row.value));
      const end = row.valid_to < result.as_of ? row.valid_to : result.as_of;
      if (end > row.date) {
        hx.push(end);
        hy.push(Number(row.value));
      }
    },
  );
  const points = result.points ?? [];
  const x: string[] = [],
    median: number[] = [],
    low: number[] = [],
    high: number[] = [];
  points.forEach((row) => {
    x.push(row.date);
    median.push(row.median);
    low.push(row.p5);
    high.push(row.p95);
    const end =
      row.valid_to < (result.target_date ?? row.valid_to)
        ? row.valid_to
        : result.target_date!;
    if (end > row.date) {
      x.push(end);
      median.push(row.median);
      low.push(row.p5);
      high.push(row.p95);
    }
  });
  const forecast = (name: string, y: number[], extra: Partial<Data>): Data =>
    ({
      type: "scatter",
      mode: "lines",
      x,
      y,
      name,
      connectgaps: false,
      hovertemplate: `%{x|%d/%m/%Y}<br>${name}: %{y:,.2f} COP/USD<extra>Estimación del modelo</extra>`,
      ...extra,
    }) as Data;
  return {
    data: [
      {
        type: "scatter",
        mode: "lines",
        name: "TRM oficial",
        x: hx,
        y: hy,
        connectgaps: false,
        line: { color: "#173d64", width: 2, shape: "hv" },
        hovertemplate:
          "%{x|%d/%m/%Y}<br>%{y:,.2f} COP/USD<extra>Registro oficial</extra>",
      },
      forecast("P5", low, {
        showlegend: false,
        line: { width: 0, shape: "hv" },
      }),
      forecast("Intervalo P5–P95", high, {
        line: { width: 0, shape: "hv" },
        fill: "tonexty",
        fillcolor: "rgba(188,95,22,.16)",
      }),
      forecast("Mediana estimada", median, {
        line: { color: "#bc5f16", width: 3, shape: "hv" },
      }),
    ],
    layout: {
      height: 410,
      autosize: true,
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      separators: ",.",
      font: { family: "Segoe UI, sans-serif", size: 11, color: "#526b7a" },
      margin: { l: 76, r: 20, t: 70, b: 65 },
      legend: { orientation: "h", traceorder: "normal", x: 0, y: 1.2 },
      xaxis: {
        type: "date",
        title: { text: "Fecha de vigencia" },
        tickformat: "%d/%m/%y",
        showgrid: false,
        range: [
          (result.history ?? result.experiment.training.history).slice(-60)[0]
            ?.date ?? result.as_of,
          result.target_date ?? result.as_of,
        ],
      },
      yaxis: {
        title: { text: "COP/USD" },
        tickformat: ",.2f",
        zeroline: false,
        gridcolor: "#e9eef0",
      },
      shapes: [
        {
          type: "line",
          x0: result.as_of,
          x1: result.as_of,
          y0: 0,
          y1: 1,
          yref: "paper",
          line: { color: "#526b7a", width: 1, dash: "dot" },
        },
      ],
    },
  };
}
