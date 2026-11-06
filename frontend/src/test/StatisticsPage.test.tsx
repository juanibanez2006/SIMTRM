import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import StatisticsPage from "../StatisticsPage";
import { queryString } from "../api";
import type { AnalysisVariable, Statistics } from "../types";
import fixtures from "./statistics-synthetic.json";

vi.mock("../StatisticsChart", () => ({
  default: ({ kind, stats }: { kind: string; stats: Statistics }) => (
    <div
      role="img"
      aria-label={`${kind}: ${stats.variable}, ${stats.summary.count} observaciones`}
    />
  ),
}));

let failure = false;
let pending = false;
let empty = false;
let fetchMock: Mock<(input: string) => Promise<Response>>;
beforeEach(() => {
  failure = false;
  pending = false;
  empty = false;
  fetchMock = vi.fn(async (input: string) => {
    if (pending) return new Promise<Response>(() => {});
    if (failure)
      return Response.json(
        { error: { message: "Estadísticas no disponibles" } },
        { status: 503 },
      );
    const url = new URL(input, "http://localhost");
    const variable = url.searchParams.get("variable") as AnalysisVariable;
    const result = structuredClone(fixtures[variable]) as Statistics;
    if (url.searchParams.get("year") === "2023") result.summary.mean = 100;
    if (empty) {
      result.summary.count = 0;
      result.summary.mean = null;
      result.points = [];
      result.histogram = [];
      result.ecdf = [];
      result.volatility.points = [];
      result.volatility.historical = null;
      result.warnings = ["Se requieren al menos dos rendimientos válidos."];
    }
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetchMock);
});

it("muestra indicadores, distribuciones, frecuencias y trazabilidad", async () => {
  const user = userEvent.setup();
  render(<StatisticsPage periodQuery="year=2024" refresh={0} />);
  expect(
    await screen.findByRole("heading", {
      name: "Lectura de la muestra seleccionada",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("112,2")).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "histogram: price, 5 observaciones" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "ecdf: price, 5 observaciones" }),
  ).toBeInTheDocument();
  await user.click(screen.getByText(/Tabla de frecuencias/));
  expect(
    screen.getByRole("columnheader", { name: "Relativa acumulada" }),
  ).toBeInTheDocument();
  await user.click(
    screen.getByText("Procedimiento y trazabilidad del cálculo"),
  );
  expect(
    screen.getByText(fixtures.price.dataset_fingerprint),
  ).toBeInTheDocument();
  expect(screen.getByText(/poblacional · divisor n/)).toBeInTheDocument();
});

it("selecciona rendimientos y envía configuración real al backend", async () => {
  const user = userEvent.setup();
  render(<StatisticsPage periodQuery="year=2024" refresh={0} />);
  await screen.findByRole("heading", {
    name: "Lectura de la muestra seleccionada",
  });
  await user.selectOptions(
    screen.getByLabelText("Variable de análisis"),
    "log_return",
  );
  expect(
    await screen.findByRole("img", {
      name: "histogram: log_return, 4 observaciones",
    }),
  ).toBeInTheDocument();
  await user.selectOptions(
    screen.getByLabelText("Clases del histograma"),
    "10",
  );
  await user.selectOptions(
    screen.getByLabelText("Ventana de volatilidad móvil"),
    "2",
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("variable=log_return&bins=10&rolling_window=2"),
      ),
    ).toBe(true),
  );
  expect(
    screen.getByText(/varianzas, puntos porcentuales al cuadrado/),
  ).toBeInTheDocument();
  expect(screen.getByText("No aplicable")).toBeInTheDocument();
});

it("actualiza indicadores al cambiar el periodo y al refrescar los datos", async () => {
  const { rerender } = render(
    <StatisticsPage periodQuery="year=2024" refresh={0} />,
  );
  await screen.findByText("112,2");
  rerender(<StatisticsPage periodQuery="year=2023" refresh={0} />);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("year=2023")),
    ).toBe(true),
  );
  expect(
    await screen.findByText("100", { selector: "strong" }),
  ).toBeInTheDocument();
  const count = fetchMock.mock.calls.length;
  rerender(<StatisticsPage periodQuery="year=2023" refresh={1} />);
  await waitFor(() =>
    expect(fetchMock.mock.calls.length).toBeGreaterThan(count),
  );
});

it("oculta resultados anteriores durante una consulta pendiente", async () => {
  const { rerender } = render(
    <StatisticsPage periodQuery="year=2024" refresh={0} />,
  );
  await screen.findByText("112,2");
  pending = true;
  rerender(<StatisticsPage periodQuery="year=2023" refresh={0} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Calculando estadísticas locales",
  );
  expect(screen.queryByText("112,2")).not.toBeInTheDocument();
});

it("muestra limitaciones cuando no hay rendimientos calculables", async () => {
  empty = true;
  render(<StatisticsPage periodQuery="" refresh={0} />);
  expect(
    await screen.findByRole("heading", {
      name: "No hay observaciones calculables",
    }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Limitaciones de la muestra")).toHaveTextContent(
    "Se requieren al menos dos rendimientos",
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText(/No hay un tramo con/)).toBeInTheDocument();
});

it("recupera un cálculo fallido sin mostrar valores ficticios", async () => {
  const user = userEvent.setup();
  failure = true;
  render(<StatisticsPage periodQuery="" refresh={0} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Estadísticas no disponibles",
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  failure = false;
  await user.click(screen.getByRole("button", { name: "Reintentar análisis" }));
  expect(
    await screen.findByRole("img", {
      name: "histogram: price, 5 observaciones",
    }),
  ).toBeInTheDocument();
});

it("permite navegar al módulo estadístico con los filtros de la aplicación", async () => {
  const App = (await import("../App")).default;
  const originalFetch = fetchMock;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("/statistics?")) return originalFetch(input);
      if (input.includes("/years")) return Response.json([2024, 2023]);
      if (input.includes("/latest"))
        return Response.json({
          record: null,
          previous: null,
          state: "empty",
          today: "2026-11-05",
          delta: null,
          variation_pct: null,
        });
      if (input.includes("/status"))
        return Response.json({ total: 5, state: "local", last_success: null });
      if (input.includes("/series"))
        return Response.json({ count: 0, points: [] });
      return Response.json({
        total: 0,
        items: [],
        pages: 0,
        page: 1,
        page_size: 20,
      });
    }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    screen.getByRole("button", { name: "Análisis estadístico" }),
  );
  expect(
    await screen.findByRole("heading", {
      name: "Lectura de la muestra seleccionada",
    }),
  ).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Año"), "2023");
  await waitFor(() =>
    expect(
      originalFetch.mock.calls.some(([url]) =>
        String(url).includes("year=2023"),
      ),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("Desde"), {
    target: { value: "2024-02-01" },
  });
  fireEvent.change(screen.getByLabelText("Hasta"), {
    target: { value: "2024-01-01" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("La fecha inicial");
  expect(
    screen.queryByRole("heading", {
      name: "Lectura de la muestra seleccionada",
    }),
  ).not.toBeInTheDocument();
});

it("conserva los filtros de fecha en la codificación del análisis", () => {
  expect(
    queryString({
      start: "2024-01-02",
      end: "2024-01-08",
      variable: "simple_return",
    }),
  ).toBe("start=2024-01-02&end=2024-01-08&variable=simple_return");
});
