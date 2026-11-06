import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import ComparisonPage from "../ComparisonPage";
import type { Comparison, ComparisonScale } from "../types";
import fixture from "./comparison-synthetic.json";

vi.mock("../ComparisonChart", () => ({
  default: ({
    comparison,
    scale,
    kind,
  }: {
    comparison: Comparison;
    scale: ComparisonScale;
    kind: string;
  }) => (
    <div role="img" aria-label={`${kind} ${scale} ${comparison.alignment}`} />
  ),
}));

let failure = false;
let pending = false;
let empty = false;
let long = false;
let fetchMock: Mock<(input: string) => Promise<Response>>;
beforeEach(() => {
  failure = false;
  pending = false;
  empty = false;
  long = false;
  fetchMock = vi.fn(async (input: string) => {
    if (pending) return new Promise<Response>(() => {});
    if (failure)
      return Response.json(
        { error: { message: "Comparación temporalmente no disponible" } },
        { status: 503 },
      );
    const params = new URL(input, "http://localhost").searchParams;
    const result = structuredClone(fixture) as Comparison;
    result.alignment = params.get("alignment") as Comparison["alignment"];
    for (const id of ["a", "b"] as const) {
      const start = params.get(`${id}_start`)!;
      result[id].requested_start = start;
      result[id].requested_end = params.get(`${id}_end`)!;
      result[id].observed_start = start;
    }
    if (long)
      result.rows = Array.from({ length: 45 }, (_, index) => ({
        ...result.rows[index % 4],
        position: index + 1,
      }));
    if (empty) {
      result.a.metrics.count = result.b.metrics.count = 0;
      result.a.points = [];
      result.b.points = [];
      result.rows = [];
    }
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetchMock);
});

it("presenta comparación inicial, diferencias y tablas con valores ausentes", async () => {
  render(<ComparisonPage years={[2025, 2024, 2023]} refresh={0} />);
  expect(
    await screen.findByRole("heading", { name: "Lectura comparativa" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "overlay normalized observation" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Indicadores y diferencias" }),
  ).toBeInTheDocument();
  const row = screen.getByRole("row", {
    name: /Variación relativa entre extremos/,
  });
  expect(within(row).getByText("13,1 pp")).toBeInTheDocument();
  expect(
    screen.getByLabelText("Limitaciones de la comparación"),
  ).toHaveTextContent("distinta cantidad");
  expect(
    screen.getByText(
      /Una celda vacía puede corresponder a una vigencia extendida/,
    ),
  ).toBeInTheDocument();
});

it("aplica dos años y conserva resultados identificados hasta confirmar los cambios", async () => {
  const user = userEvent.setup();
  render(<ComparisonPage years={[2025, 2024, 2023]} refresh={0} />);
  await screen.findByRole("heading", { name: "Lectura comparativa" });
  const previous = fetchMock.mock.calls.length;
  await user.selectOptions(screen.getByLabelText("Año del periodo A"), "2023");
  expect(screen.getByText(/Cambios sin aplicar/)).toBeInTheDocument();
  expect(fetchMock.mock.calls).toHaveLength(previous);
  await user.click(screen.getByRole("button", { name: "Comparar periodos" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.includes("a_start=2023-01-01&a_end=2023-12-31"),
      ),
    ).toBe(true),
  );
});

it("selecciona meses bisiestos y alineación por días calendario", async () => {
  const user = userEvent.setup();
  render(<ComparisonPage years={[2025, 2024, 2023]} refresh={0} />);
  await screen.findByRole("heading", { name: "Lectura comparativa" });
  await user.selectOptions(screen.getByLabelText("Tipo de periodo A"), "month");
  await user.selectOptions(screen.getByLabelText("Mes del periodo A"), "2");
  await user.selectOptions(
    screen.getByLabelText("Alineación temporal"),
    "elapsed_days",
  );
  await user.click(screen.getByRole("button", { name: "Comparar periodos" }));
  expect(
    await screen.findByRole("img", { name: "overlay normalized elapsed_days" }),
  ).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.some(
      ([url]) =>
        url.includes("a_start=2024-02-01&a_end=2024-02-29") &&
        url.includes("alignment=elapsed_days"),
    ),
  ).toBe(true);
});

it("permite rangos personalizados y valida fechas invertidas antes de consultar", async () => {
  const user = userEvent.setup();
  render(<ComparisonPage years={[2025, 2024]} refresh={0} />);
  await screen.findByRole("heading", { name: "Lectura comparativa" });
  await user.selectOptions(screen.getByLabelText("Tipo de periodo A"), "range");
  fireEvent.change(screen.getByLabelText("Inicio del periodo A"), {
    target: { value: "2024-03-01" },
  });
  fireEvent.change(screen.getByLabelText("Fin del periodo A"), {
    target: { value: "2024-02-01" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("periodo A");
  expect(
    screen.getByRole("button", { name: "Comparar periodos" }),
  ).toBeDisabled();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  const count = fetchMock.mock.calls.length;
  fireEvent.change(screen.getByLabelText("Fin del periodo A"), {
    target: { value: "2024-03-20" },
  });
  await user.click(screen.getByRole("button", { name: "Comparar periodos" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.length).toBeGreaterThan(count),
  );
  expect(fetchMock.mock.calls.at(-1)![0]).toContain(
    "a_start=2024-03-01&a_end=2024-03-20",
  );
});

it("cambia escala sin recalcular indicadores ni consultar otra muestra", async () => {
  const user = userEvent.setup();
  render(<ComparisonPage years={[2025, 2024]} refresh={0} />);
  await screen.findByRole("heading", { name: "Lectura comparativa" });
  const previous = fetchMock.mock.calls.length;
  await user.selectOptions(
    screen.getByLabelText("Escala del gráfico"),
    "price",
  );
  expect(
    screen.getByRole("img", { name: "overlay price observation" }),
  ).toBeInTheDocument();
  expect(fetchMock.mock.calls).toHaveLength(previous);
  const mean = screen.getByRole("row", { name: /^Media / });
  expect(within(mean).getByText("232,05")).toBeInTheDocument();
});

it("restablece la comparación y pagina todas las posiciones", async () => {
  long = true;
  const user = userEvent.setup();
  render(<ComparisonPage years={[2025, 2024]} refresh={0} />);
  await screen.findByRole("heading", { name: "Lectura comparativa" });
  await user.click(
    screen.getByRole("button", { name: "Siguiente comparación" }),
  );
  expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Siguiente comparación" }),
  );
  expect(screen.getByText("Página 3 de 3")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Siguiente comparación" }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Restablecer comparación" }),
  );
  expect(await screen.findByText("Página 1 de 3")).toBeInTheDocument();
});

it("muestra ausencia de datos sin dibujar curvas ficticias", async () => {
  empty = true;
  render(<ComparisonPage years={[2025, 2024]} refresh={0} />);
  expect(
    await screen.findByRole("heading", {
      name: "No hay datos para estos periodos",
    }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("recupera una comparación fallida y muestra carga durante la consulta", async () => {
  failure = true;
  const user = userEvent.setup();
  render(<ComparisonPage years={[2025, 2024]} refresh={0} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Comparación temporalmente no disponible",
  );
  failure = false;
  await user.click(
    screen.getByRole("button", { name: "Reintentar comparación" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Lectura comparativa" }),
  ).toBeInTheDocument();
  pending = true;
  await user.click(screen.getByRole("button", { name: "Comparar periodos" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Comparando periodos locales",
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("sin años disponibles solicita fechas sin iniciar consultas artificiales", () => {
  render(<ComparisonPage years={[]} refresh={0} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Complete las fechas");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("integra el módulo en la navegación principal", async () => {
  const App = (await import("../App")).default;
  const compareFetch = fetchMock;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("/comparison?")) return compareFetch(input);
      if (input.includes("/years")) return Response.json([2025, 2024]);
      if (input.includes("/latest"))
        return Response.json({
          record: null,
          state: "empty",
          delta: null,
          variation_pct: null,
        });
      if (input.includes("/status"))
        return Response.json({ total: 7, state: "local", last_success: null });
      if (input.includes("/series"))
        return Response.json({ count: 0, points: [] });
      return Response.json({ total: 0, items: [], pages: 0, page: 1 });
    }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Comparar periodos" }));
  expect(
    await screen.findByRole("heading", { name: "Lectura comparativa" }),
  ).toBeInTheDocument();
  expect(compareFetch).toHaveBeenCalled();
});
