import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import SimulationPage from "../SimulationPage";
import type {
  DataStatus,
  Latest,
  Simulation,
  SimulationMethodResult,
} from "../types";
import fixture from "./simulation-synthetic.json";

vi.mock("../SimulationChart", () => ({
  default: ({
    kind,
    result,
  }: {
    kind: string;
    result: SimulationMethodResult;
  }) => <div role="img" aria-label={`${kind} ${result.method}`} />,
}));

const latest: Latest = {
  today: "2026-11-05",
  state: "stale",
  previous: null,
  delta: null,
  variation_pct: null,
  record: {
    id: 1,
    value: "120.00",
    unit: "COP",
    valid_from: "2024-01-08",
    valid_to: "2024-01-08",
    source: "synthetic-test",
    source_id: "synthetic-1",
    obtained_at: "2026-11-05T09:00:00-05:00",
    validation_state: "validated",
    fingerprint: "synthetic",
    extended: false,
  },
};
const status: DataStatus = {
  total: 5,
  first: latest.record,
  last: latest.record,
  source: "synthetic-test",
  source_url: "https://example.test",
  timezone: "America/Bogota",
  state: "local",
  last_attempt: null,
  last_success: null,
  dataset_fingerprint: "synthetic",
  stored_versions: 5,
};
let failure = false;
let pending = false;
let fetchMock: Mock<
  (input: string, options?: RequestInit) => Promise<Response>
>;
beforeEach(() => {
  failure = false;
  pending = false;
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    if (pending) return new Promise<Response>(() => {});
    if (failure)
      return Response.json(
        { error: { message: "No hay rendimientos suficientes para calibrar" } },
        { status: 422 },
      );
    const result = structuredClone(fixture) as Simulation;
    if (input.endsWith("/replay")) {
      result.id = "00000000-0000-4000-8000-000000000002";
      result.replay_of = fixture.id;
    }
    if (options?.body) {
      const sent = JSON.parse(String(options.body));
      if (sent.method !== "both") {
        result.methods = result.methods.filter(
          (method) => method.method === sent.method,
        );
        result.request.method = sent.method;
      }
    }
    return Response.json(result, {
      status: options?.method === "POST" ? 201 : 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

function setup() {
  render(
    <SimulationPage latest={latest} status={status} prepareData={() => {}} />,
  );
}

it("conserva el experimento y el borrador cuando se actualizan los metadatos locales", async () => {
  const { rerender } = render(
    <SimulationPage latest={latest} status={status} prepareData={() => {}} />,
  );
  await execute();
  fireEvent.change(screen.getByLabelText("Semilla aleatoria"), {
    target: { value: "777" },
  });
  const calls = fetchMock.mock.calls.length;
  rerender(
    <SimulationPage
      latest={{ ...latest, today: "2026-11-06" }}
      status={{
        ...status,
        dataset_fingerprint: "new-synthetic-version",
        total: 6,
      }}
      prepareData={() => {}}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Resultado del experimento" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Semilla aleatoria")).toHaveValue(777);
  expect(screen.getByDisplayValue(fixture.id)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});
async function execute() {
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Ejecutar simulación" }));
  return screen.findByRole("heading", { name: "Resultado del experimento" });
}

it("no ejecuta sin solicitarlo y envía parámetros, semilla y corte reales", async () => {
  setup();
  expect(fetchMock).not.toHaveBeenCalled();
  await execute();
  const config = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(config).toMatchObject({
    method: "both",
    replicas: 1000,
    horizon: 30,
    seed: 2026,
    training_start: "2024-01-01",
    training_end: "2024-01-08",
    cutoff_date: "2026-11-05",
    initial_price: null,
  });
  expect(
    screen.getByRole("img", { name: "paths monte_carlo" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", {
      name: "Probabilidades terminales empíricas",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Se dibujan 3 de 8 trayectorias/),
  ).toBeInTheDocument();
});

it("permite cambiar de método visible sin volver a ejecutar", async () => {
  const user = userEvent.setup();
  setup();
  await execute();
  const count = fetchMock.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Bootstrap histórico" }));
  expect(
    screen.getByRole("img", { name: "paths bootstrap" }),
  ).toBeInTheDocument();
  expect(fetchMock.mock.calls).toHaveLength(count);
  expect(
    screen.getByRole("button", { name: "Bootstrap histórico" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("configura un método, precio, semilla, umbral e intervalo de interés", async () => {
  const user = userEvent.setup();
  setup();
  await user.selectOptions(
    screen.getByLabelText("Método de simulación"),
    "bootstrap",
  );
  for (const [label, value] of [
    ["Precio inicial opcional · COP/USD", "150.50"],
    ["Semilla aleatoria", "0"],
    ["Umbral terminal opcional · COP/USD", "160"],
    ["Límite inferior del intervalo · COP/USD", "140"],
    ["Límite superior del intervalo · COP/USD", "180"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await execute();
  const config = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(config).toMatchObject({
    method: "bootstrap",
    initial_price: "150.50",
    seed: 0,
    threshold: "160",
    interval_low: "140",
    interval_high: "180",
  });
  expect(
    screen.getByRole("img", { name: "paths bootstrap" }),
  ).toBeInTheDocument();
});

it("rechaza entrenamiento posterior al corte antes de consultar", () => {
  setup();
  fireEvent.change(screen.getByLabelText("Fecha de corte"), {
    target: { value: "2024-01-05" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "El entrenamiento no puede terminar después del corte",
  );
  expect(
    screen.getByRole("button", { name: "Ejecutar simulación" }),
  ).toBeDisabled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("valida consumo de recursos e intervalos incompletos", () => {
  setup();
  fireEvent.change(screen.getByLabelText("Horizonte en pasos"), {
    target: { value: "365" },
  });
  fireEvent.change(screen.getByLabelText("Número de réplicas"), {
    target: { value: "50000" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("2.000.000 de valores simulados");
  fireEvent.change(screen.getByLabelText("Número de réplicas"), {
    target: { value: "100" },
  });
  fireEvent.change(
    screen.getByLabelText("Límite inferior del intervalo · COP/USD"),
    { target: { value: "100" } },
  );
  expect(screen.getByRole("alert")).toHaveTextContent("ambos límites");
});

it("reproduce un resultado guardado usando su instantánea", async () => {
  const user = userEvent.setup();
  setup();
  await execute();
  await user.click(
    screen.getByRole("button", { name: "Reproducir experimento" }),
  );
  expect(
    await screen.findByText(
      /El experimento se reprodujo con los mismos resultados/,
    ),
  ).toBeInTheDocument();
  expect(fetchMock.mock.calls.at(-1)![0]).toBe(
    `/api/v1/simulations/${fixture.id}/replay`,
  );
});

it("recupera un experimento por identificador sin recalcularlo", async () => {
  const user = userEvent.setup();
  setup();
  await user.type(
    screen.getByLabelText("Identificador de experimento guardado"),
    fixture.id,
  );
  await user.click(screen.getByRole("button", { name: "Abrir experimento" }));
  expect(
    await screen.findByText(
      "Experimento recuperado.",
    ),
  ).toBeInTheDocument();
  expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/simulations/${fixture.id}`);
  expect(fetchMock.mock.calls[0][1]).toEqual({});
});

it("muestra carga y errores sin inventar escenarios", async () => {
  const user = userEvent.setup();
  setup();
  failure = true;
  await user.click(screen.getByRole("button", { name: "Ejecutar simulación" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No hay rendimientos suficientes",
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  failure = false;
  pending = true;
  await user.click(screen.getByRole("button", { name: "Ejecutar simulación" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Calculando escenarios",
  );
  expect(screen.getByLabelText("Semilla aleatoria")).toBeDisabled();
});

it("exige datos oficiales y enlaza a su preparación", async () => {
  const prepare = vi.fn();
  const user = userEvent.setup();
  render(
    <SimulationPage
      latest={{ ...latest, record: null, state: "empty" }}
      status={{ ...status, total: 0 }}
      prepareData={prepare}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Ejecutar simulación" }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Preparar datos del simulador" }),
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("identifica los parámetros modificados sin atribuirlos al resultado anterior", async () => {
  setup();
  await execute();
  fireEvent.change(screen.getByLabelText("Semilla aleatoria"), {
    target: { value: "42" },
  });
  expect(
    screen.getByText(/Parámetros modificados: ejecute de nuevo/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Resultado del experimento" }),
  ).toBeInTheDocument();
});

it("integra el simulador en la navegación principal", async () => {
  const App = (await import("../App")).default;
  const simulationFetch = fetchMock;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      if (input.includes("/simulations"))
        return simulationFetch(input, options);
      if (input.includes("/latest")) return Response.json(latest);
      if (input.includes("/status")) return Response.json(status);
      if (input.includes("/years")) return Response.json([2024]);
      if (input.includes("/series"))
        return Response.json({ count: 0, points: [] });
      return Response.json({ total: 0, items: [], pages: 0, page: 1 });
    }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Simulador" }));
  expect(
    await screen.findByRole("heading", { name: "Configurar experimento" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Ejecutar simulación" }));
  expect(
    await screen.findByRole("heading", { name: "Resultado del experimento" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(simulationFetch).toHaveBeenCalled());
});
