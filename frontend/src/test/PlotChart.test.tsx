import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Data } from "plotly.js";
import PlotChart from "../PlotChart";

const plotly = vi.hoisted(() => ({
  react: vi.fn(),
  purge: vi.fn(),
  Plots: { resize: vi.fn() },
}));
vi.mock("plotly.js-basic-dist-min", () => ({ default: plotly }));
beforeEach(() => {
  plotly.react.mockReset().mockResolvedValue(undefined);
  plotly.purge.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
const first: Data[] = [{ x: [1, 2], y: [100, 101], type: "scatter" }];
const second: Data[] = [{ x: [1, 2], y: [100, 99], type: "scatter" }];
const layout = { height: 300 };

it("serializa actualizaciones rápidas y limpia sin borrar el nuevo gráfico", async () => {
  let finish!: () => void;
  plotly.react.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender, unmount } = render(
    <PlotChart
      data={first}
      layout={layout}
      label="Prueba sintética"
      fallback="Error de prueba"
    />,
  );
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  rerender(
    <PlotChart
      data={second}
      layout={layout}
      label="Prueba sintética"
      fallback="Error de prueba"
    />,
  );
  expect(plotly.react).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(2));
  expect(plotly.react.mock.calls[1][1]).toBe(second);
  expect(plotly.purge).not.toHaveBeenCalled();
  unmount();
  await waitFor(() => expect(plotly.purge).toHaveBeenCalledTimes(1));
});

it("permite recuperarse de un fallo al cambiar los datos", async () => {
  plotly.react.mockRejectedValueOnce(new Error("Synthetic rendering failure"));
  const { rerender } = render(
    <PlotChart
      data={first}
      layout={layout}
      label="Prueba sintética"
      fallback="Error de prueba"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Error de prueba");
  rerender(
    <PlotChart
      data={second}
      layout={layout}
      label="Prueba sintética"
      fallback="Error de prueba"
    />,
  );
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Prueba sintética" })).toBeVisible();
});

it("libera un gráfico que termina de dibujarse después del desmontaje", async () => {
  let finish!: () => void;
  plotly.react.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(
    <PlotChart
      data={first}
      layout={layout}
      label="Prueba sintética"
      fallback="Error de prueba"
    />,
  );
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  unmount();
  finish();
  await waitFor(() => expect(plotly.purge).toHaveBeenCalledTimes(1));
});
