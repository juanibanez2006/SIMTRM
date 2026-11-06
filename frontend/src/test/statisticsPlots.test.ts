import { expect, it } from "vitest";
import { statisticsPlot } from "../statisticsPlots";
import type { Statistics } from "../types";
import fixtures from "./statistics-synthetic.json";

const stats = fixtures.price as Statistics;

it("el histograma conserva todas las frecuencias calculadas por el backend", () => {
  const result = statisticsPlot(stats, "histogram");
  const trace = result.data[0] as { y: number[]; customdata: number[][] };
  expect(trace.y.reduce((sum, count) => sum + count, 0)).toBe(
    stats.summary.count,
  );
  expect(trace.customdata[0]).toEqual([
    stats.histogram[0].lower,
    stats.histogram[0].upper,
    stats.histogram[0].relative_frequency,
  ]);
});

it("la distribución acumulada empieza en cero, alcanza uno y conserva empates", () => {
  const trace = statisticsPlot(stats, "ecdf").data[0] as {
    x: number[];
    y: number[];
    line: { shape: string };
  };
  expect(trace.y[0]).toBe(0);
  expect(trace.y.at(-1)).toBe(1);
  expect(trace.y).toContain(0.6);
  expect(trace.line.shape).toBe("hv");
});

it("la caja conserva los extremos señalados sin omitirlos", () => {
  const result = statisticsPlot(
    {
      ...stats,
      boxplot: { ...stats.boxplot!, outliers: [999], outlier_count: 1 },
    },
    "boxplot",
  );
  expect((result.data.at(-1) as { x: number[] }).x).toEqual([999]);
  expect((result.data[2] as { x: number[] }).x).toContain(stats.summary.median);
});

it("la serie de rendimientos conserva huecos y usa unidades porcentuales", () => {
  const result = statisticsPlot(
    {
      ...(fixtures.log_return as Statistics),
      points: [
        { date: "2024-01-01", value: null },
        { date: "2024-01-02", value: 0.1 },
      ],
    },
    "series",
  );
  const trace = result.data[0] as {
    y: (number | null)[];
    connectgaps: boolean;
  };
  expect(trace.y).toEqual([null, 0.1]);
  expect(trace.connectgaps).toBe(false);
  expect(result.layout.yaxis?.tickformat).toBe(".4%");
});

it("la volatilidad utiliza su propia serie logarítmica sin anualizar", () => {
  const trace = statisticsPlot(stats, "volatility").data[0] as {
    y: (number | null)[];
  };
  expect(trace.y).toEqual(stats.volatility.points.map((point) => point.value));
  expect(trace.y[0]).toBeNull();
});
