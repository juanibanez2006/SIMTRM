import { expect, it } from "vitest";
import {
  coordinate,
  nearestPoint,
  scaledRange,
  shiftedRange,
} from "../plotInteractions";
import { quickPeriod, selectedBounds } from "../periodFilters";

it("el zoom conserva el ancla y el desplazamiento conserva la amplitud", () => {
  expect(scaledRange([0, 100], 0.5, 0.25)).toEqual([12.5, 62.5]);
  expect(shiftedRange([20, 80], -0.25)).toEqual([5, 65]);
  expect(coordinate(1_700_000_000_000, true)).toBe(1_700_000_000_000);
  expect(coordinate("2024-01-01", true)).toBe(Date.UTC(2024, 0, 1));
});

it("selecciona puntos reales e ignora separadores y valores ausentes", () => {
  expect(
    nearestPoint(
      [{ type: "scatter", x: [0, null, 10, 20], y: [100, null, 110, null] }],
      19,
      false,
    ),
  ).toBe(2);
});

it("los periodos rápidos respetan meses, años bisiestos y extremos inclusivos", () => {
  expect(quickPeriod(1, "2024-03-31")).toEqual({
    year: "",
    month: "",
    start: "2024-03-01",
    end: "2024-03-31",
  });
  expect(quickPeriod(12, "2024-02-29").start).toBe("2023-03-01");
  expect(quickPeriod(60, "2026-11-05").start).toBe("2021-11-06");
  expect(quickPeriod(null, "2026-11-05")).toEqual({
    year: "",
    month: "",
    start: "",
    end: "",
  });
});

it("comparte la intersección exacta de filtros y cobertura local", () => {
  expect(
    selectedBounds(
      { year: "2024", month: "2", start: "2024-02-10", end: "" },
      "1991-12-02",
      "2026-11-05",
    ),
  ).toEqual({ start: "2024-02-10", end: "2024-02-29" });
});
