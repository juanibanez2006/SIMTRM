import { expect, it } from "vitest";
import { projectionPlot } from "../projectionPlot";
import { projection } from "./projectionFixtures";

it("dibuja las primeras réplicas originales con sus pasos y vigencias, sin inventar ruido", () => {
  const original = structuredClone(projection);
  const figure = projectionPlot(projection, "paths");
  const samples = figure.data.slice(4);
  expect(samples).toHaveLength(Math.min(5, projection.experiment.methods[0].paths.length));
  samples.forEach((trace, index) => {
    const source = projection.experiment.methods[0].paths[index];
    expect(trace.x).toEqual(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-17", "2026-11-18"]);
    expect(trace.y).toEqual([source[0], source[1], source[2], source[2], source[3]]);
  });
  expect(figure.data[3].name).toBe("Mediana estimada");
  expect(projectionPlot(projection, "paths")).toEqual(figure);
  expect(projection).toEqual(original);
});

it("el promedio usa todas las réplicas y no la muestra visible; la mediana no cambia", () => {
  const model = projection.experiment.methods[0];
  const average = model.terminal_values.reduce((sum, value) => sum + value, 0) / model.total_paths;
  const figure = projectionPlot(projection, "mean");
  expect(figure.data).toHaveLength(4);
  expect(figure.data[3].name).toBe("Promedio simple");
  expect((figure.data[3].y as number[]).at(-1)).toBeCloseTo(average, 10);
  expect((projectionPlot(projection, "median").data[3].y as number[]).at(-1)).toBe(projection.estimate);
});
