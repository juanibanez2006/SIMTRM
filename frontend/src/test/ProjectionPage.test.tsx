import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import ProjectionPage from "../ProjectionPage";
import RollingValidation from "../RollingValidation";
import { projectionPlot } from "../projectionPlot";
import { money } from "../format";
import { latest, projection, rolling } from "./projectionFixtures";

vi.mock("../PlotChart", () => ({
  default: () => <div role="img" aria-label="Gráfico de prueba" />,
}));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (path: string) =>
    Response.json(path.includes("/validations/rolling?")
      ? {items: [], total: 0, page: 1, page_size: 5, pages: 0}
      : path.endsWith("/experiments") ? [] : projection),
  );
  vi.stubGlobal("fetch", fetchMock);
});
async function execute() {
  const user = userEvent.setup();
  fireEvent.change(screen.getByLabelText("Fecha de proyección"), {
    target: { value: projection.target_date },
  });
  await user.click(
    screen.getByRole("button", { name: "Calcular proyección" }),
  );
  return screen.findByRole("region", { name: "Resultado de proyección" });
}
it("envía la fecha, destaca la mediana y muestra la misma estimación en la tabla", async () => {
  render(<ProjectionPage latest={latest} revision="one" />);
  const output = await execute();
  expect(within(output).getByRole("heading")).toHaveTextContent(
    money(projection.estimate),
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).target_date).toBe(
    projection.target_date,
  );
  const row = screen.getByRole("row", { current: "date" });
  expect(row).toHaveTextContent(money(projection.estimate));
  expect(row).toHaveTextContent(money(projection.lower));
  expect(
    screen.getByRole("button", { name: "Descargar Excel" }),
  ).toBeEnabled();
});
it("mantiene el resultado guardado al cambiar la fecha o el histórico", async () => {
  const { rerender } = render(
    <ProjectionPage latest={latest} revision="one" />,
  );
  await execute();
  fireEvent.change(screen.getByLabelText("Fecha de proyección"), {
    target: { value: "2026-12-05" },
  });
  expect(screen.getByRole("status")).toHaveTextContent("parámetros originales");
  expect(
    screen.getByRole("region", { name: "Resultado de proyección" }),
  ).toHaveTextContent(money(projection.estimate));
  rerender(<ProjectionPage latest={latest} revision="two" />);
  expect(screen.getByRole("status")).toHaveTextContent("Vuelva a calcular");
});
it("bloquea datos desactualizados y comunica errores sin inventar resultados", async () => {
  const { rerender } = render(
    <ProjectionPage latest={{ ...latest, state: "stale" }} revision="one" />,
  );
  expect(
    screen.getByRole("button", { name: "Calcular proyección" }),
  ).toBeDisabled();
  rerender(<ProjectionPage latest={latest} revision="one" />);
  fetchMock.mockResolvedValue(
    Response.json(
      { error: { message: "Se requieren 252 vigencias de entrenamiento" } },
      { status: 422 },
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Calcular proyección" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("252 vigencias");
  expect(
    screen.queryByLabelText("Resultado de proyección"),
  ).not.toBeInTheDocument();
});
it("la línea naranja empieza exactamente en el precio oficial y termina en la mediana", () => {
  const figure = projectionPlot(projection);
  const data = figure.data as {
    x: string[];
    y: number[];
    line?: { color?: string; shape?: string };
  }[];
  expect(figure.layout.xaxis?.type).toBe("date");
  expect(data[0].x.at(-1)).toBe(projection.as_of);
  expect(data[3].x[0]).toBe(projection.as_of);
  expect(data[0].y.at(-1)).toBe(data[3].y[0]);
  expect(data[3].y.at(-1)).toBe(projection.estimate);
  expect(data[1].y.at(-1)).toBe(projection.lower);
  expect(data[2].y.at(-1)).toBe(projection.upper);
  expect(data[3].line?.color).toBe("#bc5f16");
});
it("evalúa plazos calendario y presenta errores, modelo y vigencia real", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (path: string) => Response.json(path.includes("/validations/rolling?")
    ? {items: [], total: 0, page: 1, page_size: 5, pages: 0} : rolling));
  render(<RollingValidation available initialSettings={projection.request} />);
  await user.click(
    screen.getByRole("button", { name: "Evaluar varios cortes" }),
  );
  await screen.findByRole("heading", {
    name: "Errores por horizonte frente a persistencia",
  });
  expect(screen.queryByText(/Parámetros modificados/)).not.toBeInTheDocument();
  expect(JSON.parse(fetchMock.mock.calls.find(([, options]) => options?.method === "POST")![1].body).unit).toBe(
    "calendar_days",
  );
  await user.click(screen.getByText("Valores por corte y trazabilidad"));
  expect(
    screen.getByRole("columnheader", { name: "Error porcentual" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: "Vigencia real" }),
  ).toBeInTheDocument();
});
it("recupera y reproduce un experimento conservando los resultados", async () => {
  const user = userEvent.setup();
  render(<ProjectionPage latest={latest} revision="one" />);
  await user.click(screen.getByText("Experimentos guardados"));
  await user.type(
    screen.getByLabelText("Identificador de experimento"),
    projection.id,
  );
  await user.click(
    screen.getByRole("button", { name: "Recuperar experimento" }),
  );
  await screen.findByLabelText("Resultado de proyección");
  expect(screen.getByRole("status")).toHaveTextContent("Resultado guardado");
  await user.click(screen.getByText("Metodología y datos del experimento"));
  await user.click(
    screen.getByRole("button", { name: "Reproducir proyección guardada" }),
  );
  expect(
    fetchMock.mock.calls.some(([path]) => String(path).endsWith("/replay")),
  ).toBe(true);
});

it("conserva Todo el histórico después de ejecutar y envía sus fechas reales", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/experiments')) return Response.json([]);
    const submitted = JSON.parse(String(options?.body));
    return Response.json({...projection, request: submitted, target_date: submitted.target_date});
  });
  render(<ProjectionPage latest={latest} revision="one" firstAvailable="1991-11-27" />);
  await user.click(screen.getByText('Parámetros del modelo'));
  await user.selectOptions(screen.getByLabelText('Periodo histórico'), 'all');
  await execute();
  expect(screen.getByLabelText('Periodo histórico')).toHaveValue('all');
  const body = JSON.parse(fetchMock.mock.calls.find(([path]) => String(path).endsWith('/projections'))![1].body);
  expect(body.training_start).toBe('1991-11-27');
  expect(body.training_end).toBe(latest.today);
});
