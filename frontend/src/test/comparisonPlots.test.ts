import { expect, it } from "vitest";
import { initialPeriod, periodBounds } from "../comparisonPeriods";
import { comparisonPlot } from "../comparisonPlots";
import type { Comparison } from "../types";
import fixture from "./comparison-synthetic.json";

const data = fixture as Comparison;

it("calcula límites de años y meses respetando el calendario bisiesto", () => {
  expect(periodBounds(initialPeriod(2024))).toEqual({
    start: "2024-01-01",
    end: "2024-12-31",
  });
  expect(
    periodBounds({ ...initialPeriod(2024), mode: "month", month: "2" }),
  ).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  expect(
    periodBounds({ ...initialPeriod(2023), mode: "month", month: "2" }),
  ).toEqual({ start: "2023-02-01", end: "2023-02-28" });
  expect(
    periodBounds({ ...initialPeriod(2024), mode: "month", month: "4" }).end,
  ).toBe("2024-04-30");
});

it("conserva rangos personalizados y no inventa un año sin datos", () => {
  expect(
    periodBounds({
      ...initialPeriod(),
      mode: "range",
      start: "2023-12-29",
      end: "2024-01-02",
    }),
  ).toEqual({ start: "2023-12-29", end: "2024-01-02" });
  expect(periodBounds(initialPeriod())).toEqual({ start: "", end: "" });
});

it("distingue niveles originales de índices base 100 sin igualar longitudes", () => {
  const normalized = comparisonPlot(data, "normalized", "overlay");
  const prices = comparisonPlot(data, "price", "overlay");
  expect((normalized.data[0] as { y: number[] }).y).toEqual([100, 110, 120]);
  expect((normalized.data[1] as { y: number[] }).y).toEqual([
    100, 110, 121, 133.1,
  ]);
  expect((prices.data[1] as { y: number[] }).y).toEqual([200, 220, 242, 266.2]);
  expect(prices.layout.yaxis?.title).toEqual({ text: "COP por USD" });
  expect(normalized.layout.yaxis?.title).toEqual({
    text: "Índice · primer valor = 100",
  });
});

it("no conecta huecos ni sustituye precios ausentes por cero", () => {
  const input = structuredClone(data);
  input.a.points[1].gap_before = true;
  const trace = comparisonPlot(input, "normalized", "overlay").data[0] as {
    y: (number | null)[];
    connectgaps: boolean;
  };
  expect(trace.y).toEqual([100, null, 110, 120]);
  expect(trace.connectgaps).toBe(false);
});

it("extiende vigencias solo en el gráfico por días, sin modificar la muestra", () => {
  const input = structuredClone(data);
  input.alignment = "elapsed_days";
  input.a.points = [
    { ...input.a.points[0], position: 0, effective_until: "2024-01-03" },
  ];
  const trace = comparisonPlot(input, "normalized", "overlay").data[0] as {
    x: number[];
    y: number[];
  };
  expect(trace.x).toEqual([0, 2]);
  expect(trace.y).toEqual([100, 100]);
  expect(input.a.points).toHaveLength(1);
});

it("las barras comparan indicadores de precios aunque se seleccione base 100", () => {
  const result = comparisonPlot(data, "normalized", "bars");
  expect((result.data[0] as { y: number[] }).y[0]).toBe(110);
  expect((result.data[1] as { y: number[] }).y[0]).toBeCloseTo(232.05);
  expect(result.layout.yaxis?.title).toEqual({
    text: "COP por USD · niveles originales",
  });
});
