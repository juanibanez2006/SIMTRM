import { expect, it } from "vitest";
import {
  coordinate,
  nearestPoint,
  scaledRange,
  shiftedRange,
} from "../plotInteractions";

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
