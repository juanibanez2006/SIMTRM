import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import BacktestPage from "../BacktestPage";
import { backtestPlot } from "../backtestPlots";
import type { Backtest, DataStatus, Latest } from "../types";
import fixture from "./backtest-synthetic.json";

vi.mock("../BacktestChart", () => ({
  default: ({ index }: { index: number }) => (
    <div role="img" aria-label={`Validación del modelo ${index}`} />
  ),
}));
const latest: Latest = {
  record: null,
  previous: null,
  today: "2026-11-05",
  state: "empty",
  delta: null,
  variation_pct: null,
};
const status: DataStatus = {
  total: 5,
  first: null,
  last: null,
  source: "synthetic-test",
  source_url: "https://example.test",
  timezone: "America/Bogota",
  state: "local",
  last_success: null,
  last_attempt: null,
  dataset_fingerprint: "synthetic",
  stored_versions: 5,
};
let fetchMock: Mock<
  (input: string, options?: RequestInit) => Promise<Response>
>;
let failure = false;
let partial = false;
beforeEach(() => {
  failure = false;
  partial = false;
  fetchMock = vi.fn(async () => {
    if (failure)
      return Response.json(
        { error: { message: "La fuente no cubre la fecha de corte" } },
        { status: 422 },
      );
    const result = structuredClone(fixture) as Backtest;
    if (partial) {
      result.status = "insufficient";
      result.evaluated_steps = 0;
      result.observations = [];
      result.methods.forEach((model) => {
        model.points = [];
        model.metrics.terminal_absolute_error = null;
      });
    }
    return Response.json(result, { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

it("envía corte, horizonte y parámetros y presenta referencia y diagnósticos separados", async () => {
  const user = userEvent.setup();
  render(<BacktestPage latest={latest} status={status} />);
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Ejecutar validación retrospectiva" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Resultado retrospectivo" }),
  ).toBeInTheDocument();
  const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(sent).toMatchObject({
    training_start: "2025-01-01",
    cutoff_date: "2025-12-31",
    horizon: 30,
    replicas: 1000,
    seed: 2026,
    uniform_count: 1000,
    alpha: 0.05,
  });
  expect(
    screen.getByRole("row", { name: /Persistencia P0/ }),
  ).toHaveTextContent("10,50");
  expect(
    screen.getByRole("heading", {
      name: "Diagnóstico del generador y del entrenamiento",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Excel de la validación" }),
  ).toBeInTheDocument();
});

it("cambia el modelo visible sin recalibrar y conserva el corte consultado", async () => {
  const user = userEvent.setup();
  render(<BacktestPage latest={latest} status={status} />);
  await user.click(
    screen.getByRole("button", { name: "Ejecutar validación retrospectiva" }),
  );
  await screen.findByRole("heading", { name: "Resultado retrospectivo" });
  await user.click(screen.getByRole("button", { name: "Bootstrap" }));
  expect(
    screen.getByRole("img", { name: "Validación del modelo 1" }),
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Corte retrospectivo"), {
    target: { value: "2024-02-01" },
  });
  expect(
    screen.getByText(/Parámetros modificados: ejecute la validación/),
  ).toBeInTheDocument();
});

it("rechaza rangos inválidos y solicitudes excesivas sin consultar", () => {
  render(<BacktestPage latest={latest} status={status} />);
  fireEvent.change(screen.getByLabelText("Corte retrospectivo"), {
    target: { value: "2024-01-01" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "inicio del entrenamiento",
  );
  fireEvent.change(screen.getByLabelText("Corte retrospectivo"), {
    target: { value: "2025-12-31" },
  });
  fireEvent.change(screen.getByLabelText("Pasos a evaluar"), {
    target: { value: "365" },
  });
  fireEvent.change(screen.getByLabelText("Réplicas por modelo"), {
    target: { value: "50000" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("2.000.000");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("identifica validación insuficiente sin dibujar observaciones futuras ficticias", async () => {
  partial = true;
  const user = userEvent.setup();
  render(<BacktestPage latest={latest} status={status} />);
  await user.click(
    screen.getByRole("button", { name: "Ejecutar validación retrospectiva" }),
  );
  expect(
    await screen.findByText("VALIDACIÓN INSUFICIENTE"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("muestra errores y permite repetir la consulta", async () => {
  failure = true;
  const user = userEvent.setup();
  render(<BacktestPage latest={latest} status={status} />);
  await user.click(
    screen.getByRole("button", { name: "Ejecutar validación retrospectiva" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "La fuente no cubre",
  );
  failure = false;
  await user.click(
    screen.getByRole("button", { name: "Ejecutar validación retrospectiva" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Resultado retrospectivo" }),
  ).toBeInTheDocument();
});

it("el gráfico separa observaciones posteriores, simulación y persistencia", () => {
  const result = fixture as Backtest;
  const chart = backtestPlot(result, 0);
  expect(
    (
      chart.data.find(
        (trace) => trace.name === "TRM real posterior al corte",
      ) as { y: number[] }
    ).y,
  ).toEqual([121, 120]);
  expect(
    (
      chart.data.find((trace) => trace.name === "Persistencia P0") as {
        y: number[];
      }
    ).y,
  ).toEqual([110, 110]);
  expect(chart.layout.xaxis?.type).toBe("date");
});

it("integra validación y exportaciones en la navegación", async () => {
  const App = (await import("../App")).default;
  const post = fetchMock;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      if (input.endsWith("/backtests")) return post(input, options);
      if (input.includes("/status")) return Response.json(status);
      if (input.includes("/latest")) return Response.json(latest);
      if (input.includes("/years")) return Response.json([2025, 2024]);
      if (input.includes("/series"))
        return Response.json({ count: 0, points: [] });
      return Response.json({ items: [], total: 0, pages: 0, page: 1 });
    }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    screen.getByRole("button", { name: "Validación retrospectiva" }),
  );
  expect(
    await screen.findByRole("heading", {
      name: "Configurar validación retrospectiva",
    }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Exportaciones" }));
  expect(
    screen.getByRole("heading", {
      name: "Exportaciones completas y trazables",
    }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Descargar todo el histórico" }),
    ).toBeInTheDocument(),
  );
});
