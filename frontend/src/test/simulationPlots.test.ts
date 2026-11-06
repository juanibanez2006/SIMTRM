import { expect, it } from "vitest";
import { simulationPlot } from "../simulationPlots";
import type { Simulation } from "../types";
import fixture from "./simulation-synthetic.json";

const experiment = fixture as Simulation;
const result = experiment.methods[0];

it("distingue las réplicas de las bandas y de la media por paso", () => {
  const chart = simulationPlot(experiment, result, "paths");
  expect(chart.data).toHaveLength(result.displayed_paths + 4);
  const paths = chart.data.filter((trace) => trace.name?.startsWith("Réplica"));
  expect(paths).toHaveLength(result.displayed_paths);
  const median = chart.data.find(
    (trace) => trace.name === "Mediana por paso",
  ) as { y: number[] };
  expect(median.y).toEqual(result.bands.map((row) => row.median));
  const upper = chart.data.find(
    (trace) => trace.name === "Banda marginal P5–P95",
  ) as { fill: string; y: number[] };
  expect(upper.fill).toBe("tonexty");
  expect(upper.y).toEqual(result.bands.map((row) => row.p95));
});

it("el histograma terminal conserva todas las réplicas, no solo las dibujadas", () => {
  const trace = simulationPlot(experiment, result, "terminal").data[0] as {
    y: number[];
  };
  expect(trace.y.reduce((sum, value) => sum + value, 0)).toBe(
    result.total_paths,
  );
  expect(result.displayed_paths).toBeLessThan(result.total_paths);
});

it("representa el histórico con fechas reales y separa huecos de cobertura", () => {
  const sample = structuredClone(experiment);
  sample.training.history = [
    {
      date: "2024-01-01",
      valid_to: "2024-01-03",
      value: "100",
      extended: true,
    },
    {
      date: "2024-01-06",
      valid_to: "2024-01-06",
      value: "110",
      extended: false,
    },
  ];
  const chart = simulationPlot(sample, result, "history");
  const trace = chart.data[0] as {
    x: (string | null)[];
    y: (number | null)[];
    connectgaps: boolean;
  };
  expect(trace.x).toEqual(["2024-01-01", "2024-01-03", null, "2024-01-06"]);
  expect(trace.y).toEqual([100, 100, null, 110]);
  expect(trace.connectgaps).toBe(false);
  expect(chart.layout.xaxis?.type).toBe("date");
});
