import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import EvaluationHistory from "../EvaluationHistory";
import RollingValidation from "../RollingValidation";
import { rolling } from "./projectionFixtures";
import type { EvaluationHistoryEntry } from "../types";

vi.mock("../PlotChart", () => ({ default: () => <div role="img" aria-label="Gráfico de prueba" /> }));
const entry: EvaluationHistoryEntry = {
  id: rolling.id, created_at: rolling.created_at, request: rolling.request,
  evaluated_folds: 2, skipped: 0,
};
const history = (items = [entry], page = 1, total = items.length) => ({
  items, page, total, page_size: 5, pages: Math.ceil(total / 5),
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json(history()));
  vi.stubGlobal("fetch", fetchMock);
});
const show = (onOpen = vi.fn(async () => {})) => {
  render(<EvaluationHistory revision={0} busy={false} onOpen={onOpen} onNew={vi.fn()} />);
  return onOpen;
};

it("muestra los parámetros y abre por selección sin pedir identificadores", async () => {
  const open = show();
  expect(screen.getByRole("status")).toHaveTextContent("Cargando evaluaciones");
  const button = await screen.findByRole("button", { name: "Abrir resultados" });
  const region = screen.getByRole("region", { name: "Mis evaluaciones" });
  expect(region).toHaveTextContent("Bootstrap");
  expect(region).toHaveTextContent("7días calendario");
  expect(region).toHaveTextContent("2 de 2 cortes");
  expect(region).toHaveTextContent("Semilla: 2026");
  expect(region).toHaveTextContent("Volatilidad × 1");
  expect(screen.queryByLabelText("Identificador de evaluación")).not.toBeInTheDocument();
  await userEvent.click(button);
  expect(open).toHaveBeenCalledExactlyOnceWith(entry.id);
  expect(within(region).getByRole("button", { name: "Descargar Excel" })).toBeEnabled();
});

it("pagina, combina filtros y vuelve a la primera página al buscar o limpiar", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (path: string) => {
    const params = new URL(path, "http://test").searchParams;
    if (params.get("q")) return Response.json(history([], 1, 0));
    return Response.json(history([entry], Number(params.get("page")), 8));
  });
  show();
  await screen.findByText("8 evaluaciones · Página 1 de 2");
  await user.click(screen.getByRole("button", { name: "Siguiente" }));
  await screen.findByText("8 evaluaciones · Página 2 de 2");
  await user.click(screen.getByText("Filtros por fecha, método y horizonte"));
  await user.type(screen.getByLabelText("Buscar evaluaciones"), "Montecarlo");
  await user.selectOptions(screen.getByLabelText("Método guardado"), "monte_carlo");
  await user.type(screen.getByLabelText("Horizonte guardado"), "30");
  fireEvent.change(screen.getByLabelText("Creada desde"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Creada hasta"), { target: { value: "2026-11-01" } });
  await user.selectOptions(screen.getByLabelText("Unidad del horizonte"), "calendar_days");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByText(/No hay evaluaciones que coincidan/);
  const query = new URL(fetchMock.mock.calls.at(-1)![0], "http://test").searchParams;
  expect(Object.fromEntries(query)).toMatchObject({ page: "1", q: "Montecarlo",
    method: "monte_carlo", horizon: "30", start: "2026-01-01", end: "2026-11-01", unit: "calendar_days" });
  await user.click(screen.getByRole("button", { name: "Limpiar filtros" }));
  await screen.findByText("8 evaluaciones · Página 1 de 2");
  expect(screen.getByLabelText("Buscar evaluaciones")).toHaveValue("");
  await user.selectOptions(screen.getByLabelText("Evaluaciones por página"), "20");
  await waitFor(() => expect(fetchMock.mock.calls.at(-1)![0]).toContain("page_size=20"));
});

it("distingue un historial vacío de un error y permite reintentar", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Consulta fallida" } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(history([], 1, 0)));
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent("Consulta fallida");
  expect(screen.queryByText(/Aún no hay evaluaciones/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Reintentar consulta" }));
  await screen.findByText(/Aún no hay evaluaciones guardadas/);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("descarta una respuesta antigua cuando el usuario cambia la búsqueda", async () => {
  const user = userEvent.setup();
  let finish!: (response: Response) => void;
  fetchMock.mockResolvedValueOnce(Response.json(history([entry], 1, 8)))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(Response.json(history([], 1, 0)));
  show();
  await screen.findByText("8 evaluaciones · Página 1 de 2");
  await user.click(screen.getByRole("button", { name: "Siguiente" }));
  await user.type(screen.getByLabelText("Buscar evaluaciones"), "sin coincidencias");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByText(/No hay evaluaciones que coincidan/);
  await act(async () => finish(Response.json(history([entry], 2, 8))));
  expect(screen.queryByRole("button", { name: "Abrir resultados" })).not.toBeInTheDocument();
  expect(screen.getByText(/No hay evaluaciones que coincidan/)).toBeInTheDocument();
});

it("reutiliza la configuración histórica sin recalcular hasta solicitar una nueva evaluación", async () => {
  const user = userEvent.setup();
  const original = structuredClone(rolling);
  original.request = { ...original.request, unit: "transitions", last_cutoff: "2026-09-30",
    settings: { ...original.request.settings, method: "arima", training_records: 90,
      replicas: 300, seed: 41, volatility_scale: 1.5 } };
  const snapshot = JSON.stringify(original);
  fetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.includes("/validations/rolling?")) return Response.json(history([{ ...entry, request: original.request }]));
    return Response.json(options?.method === "POST" ? { ...original, id: "new-evaluation" } : original);
  });
  render(<RollingValidation available />);
  await user.click(await screen.findByRole("button", { name: "Abrir resultados" }));
  await screen.findByRole("heading", { name: "Errores por horizonte frente a persistencia" });
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  // Opening does not silently replace the form's current settings.
  expect(screen.getByLabelText("Método a evaluar")).toHaveValue("bootstrap");
  await user.click(screen.getByRole("button", { name: "Usar esta configuración" }));
  expect(screen.getByLabelText("Método a evaluar")).toHaveValue("arima");
  expect(screen.getByLabelText("Unidad de evaluación")).toHaveValue("transitions");
  expect(screen.getByLabelText(/Horizontes en transiciones/)).toHaveValue("7");
  expect(screen.getByLabelText("Ventana de entrenamiento (vigencias)")).toHaveValue(90);
  expect(screen.getByLabelText("Réplicas por corte")).toHaveValue(300);
  expect(screen.getByLabelText("Semilla por corte")).toHaveValue(41);
  expect(screen.getByLabelText("Factor de volatilidad")).toHaveValue(1.5);
  expect(screen.getByLabelText("Último corte histórico (opcional)")).toHaveValue("2026-09-30");
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Evaluar varios cortes" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
  const posted = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")![1];
  expect(JSON.parse(posted.body)).toEqual(original.request);
  expect(JSON.stringify(original)).toBe(snapshot);
});

it("permite abrir evaluaciones sin histórico local y conserva resultados ante un fallo", async () => {
  let attempts = 0;
  fetchMock.mockImplementation(async (path: string) => path.includes("/validations/rolling?")
    ? Response.json(history()) : ++attempts === 1 ? Response.json(rolling)
      : Response.json({ error: { message: "Evaluación no disponible" } }, { status: 404 }));
  render(<RollingValidation available={false} />);
  expect(screen.getByRole("button", { name: "Evaluar varios cortes" })).toBeDisabled();
  await userEvent.click(await screen.findByRole("button", { name: "Abrir resultados" }));
  await screen.findByRole("heading", { name: "Errores por horizonte frente a persistencia" });
  const saved = screen.getByRole("region", { name: "Métricas de validación desplazables" }).textContent;
  await userEvent.click(screen.getByRole("button", { name: "Ver resultados abiertos" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Evaluación no disponible");
  expect(screen.getByRole("region", { name: "Métricas de validación desplazables" }).textContent).toBe(saved);
});
