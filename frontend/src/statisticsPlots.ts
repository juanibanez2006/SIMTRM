import type { Data, Layout } from "plotly.js";
import type { Statistics } from "./types";

export type StatisticsPlotKind =
  "histogram" | "ecdf" | "boxplot" | "series" | "volatility";

export const plotTitles: Record<StatisticsPlotKind, string> = {
  histogram: "Histograma de frecuencias",
  ecdf: "Distribución acumulada empírica",
  boxplot: "Diagrama de caja",
  series: "Evolución de la variable",
  volatility: "Volatilidad móvil de rendimientos logarítmicos",
};

export function statisticsPlot(
  stats: Statistics,
  kind: StatisticsPlotKind,
): { data: Data[]; layout: Partial<Layout> } {
  const isPrice = stats.variable === "price";
  const format = isPrice ? ",.2f" : ".4%";
  const unit = isPrice ? "COP/USD" : "% por transición de vigencia";
  const layout: Partial<Layout> = {
    height: kind === "boxplot" ? 240 : 300,
    autosize: true,
    margin: { l: 72, r: 22, t: 18, b: 65 },
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { family: "Segoe UI, sans-serif", size: 11, color: "#607381" },
    separators: ",.",
    showlegend: false,
    xaxis: {
      title: { text: unit },
      gridcolor: "#e9eef0",
      tickformat: format,
      zeroline: false,
    },
    yaxis: { gridcolor: "#e9eef0", zeroline: false },
  };
  if (kind === "histogram")
    return {
      data: [
        {
          type: "bar",
          x: stats.histogram.map((bin) => (bin.lower + bin.upper) / 2),
          width: stats.histogram.map((bin) => bin.upper - bin.lower),
          y: stats.histogram.map((bin) => bin.frequency),
          customdata: stats.histogram.map((bin) => [
            bin.lower,
            bin.upper,
            bin.relative_frequency,
          ]),
          marker: { color: "#249695", line: { color: "white", width: 1 } },
          hovertemplate: `Desde %{customdata[0]:${format}}<br>Hasta %{customdata[1]:${format}}<br>Frecuencia: %{y}<br>Proporción: %{customdata[2]:.2%}<extra></extra>`,
        },
      ],
      layout: {
        ...layout,
        bargap: 0,
        yaxis: {
          ...layout.yaxis,
          title: { text: "Frecuencia absoluta" },
          rangemode: "tozero",
          dtick: stats.summary.count < 10 ? 1 : undefined,
        },
      },
    };
  if (kind === "ecdf")
    return {
      data: [
        {
          type: "scatter",
          mode: "lines",
          x: stats.ecdf.length
            ? [
                stats.ecdf[0].value -
                  Math.max(Math.abs(stats.ecdf[0].value) * 0.001, 0.000001),
                ...stats.ecdf.map((point) => point.value),
              ]
            : [],
          y: stats.ecdf.length
            ? [0, ...stats.ecdf.map((point) => point.probability)]
            : [],
          line: { color: "#147d83", shape: "hv", width: 2 },
          hovertemplate: `x: %{x:${format}}<br>F(x): %{y:.4%}<extra></extra>`,
        },
      ],
      layout: {
        ...layout,
        yaxis: {
          ...layout.yaxis,
          title: { text: "F(x) = proporción ≤ x" },
          range: [0, 1.02],
          tickformat: ".0%",
        },
      },
    };
  if (kind === "boxplot") {
    const box = stats.boxplot;
    const { q1, q3, median } = stats.summary;
    if (!box || q1 === null || q3 === null || median === null)
      return { data: [], layout };
    return {
      data: [
        {
          type: "scatter",
          mode: "lines",
          x: [q1, q3, q3, q1, q1],
          y: [-0.25, -0.25, 0.25, 0.25, -0.25],
          fill: "toself",
          fillcolor: "#d8eeeb",
          line: { color: "#147d83", width: 2 },
          hoverinfo: "skip",
        },
        {
          type: "scatter",
          mode: "lines",
          x: [
            median,
            median,
            null,
            box.whisker_low,
            q1,
            null,
            q3,
            box.whisker_high,
            null,
            box.whisker_low,
            box.whisker_low,
            null,
            box.whisker_high,
            box.whisker_high,
          ],
          y: [
            -0.25,
            0.25,
            null,
            0,
            0,
            null,
            0,
            0,
            null,
            -0.15,
            0.15,
            null,
            -0.15,
            0.15,
          ],
          line: { color: "#147d83", width: 2 },
          hoverinfo: "skip",
        },
        {
          type: "scatter",
          mode: "markers",
          x: [box.whisker_low, q1, median, q3, box.whisker_high],
          y: [0, 0, 0, 0, 0],
          text: ["Bigote inferior", "Q1", "Mediana", "Q3", "Bigote superior"],
          marker: { size: 6, color: "#147d83" },
          hovertemplate: `%{text}: %{x:${format}}<extra></extra>`,
        },
        {
          type: "scatter",
          mode: "markers",
          x: box.outliers,
          y: box.outliers.map(() => 0),
          marker: { color: "#ba8351", size: 5 },
          hovertemplate: `Valor fuera de cercas de Tukey: %{x:${format}}<extra></extra>`,
        },
      ],
      layout: {
        ...layout,
        yaxis: { visible: false, range: [-0.7, 0.7], fixedrange: true },
      },
    };
  }
  const points = kind === "volatility" ? stats.volatility.points : stats.points;
  const valueFormat = kind === "volatility" ? ".4%" : format;
  return {
    data: [
      {
        type: "scatter",
        mode: "lines",
        x: points.map((point) => point.date),
        y: points.map((point) => point.value),
        connectgaps: false,
        line: { color: "#147d83", width: 1.7 },
        hovertemplate: `%{x|%d/%m/%Y}<br>%{y:${valueFormat}}<extra></extra>`,
      },
    ],
    layout: {
      ...layout,
      xaxis: { type: "date", showgrid: false },
      yaxis: {
        ...layout.yaxis,
        tickformat: valueFormat,
        title: {
          text: kind === "volatility" ? "σ logarítmica · sin anualizar" : unit,
        },
      },
    },
  };
}
