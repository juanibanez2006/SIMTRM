import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { shortDate, timestamp } from "../format";
import type { DataStatus, History, Latest, Series, TrmRecord } from "../types";

vi.mock("../HistoryChart", () => ({
  default: ({ series }: { series: Series }) => (
    <div
      role="img"
      aria-label={`Gráfico de prueba: ${series.count} registros`}
    />
  ),
}));

// Synthetic fixtures are used only by this isolated test suite.
const record: TrmRecord = {
  id: 1,
  value: "121.00",
  unit: "COP",
  valid_from: "2024-01-04",
  valid_to: "2024-01-07",
  extended: true,
  source: "synthetic-test",
  source_id: "test-1",
  obtained_at: "2024-01-08T10:00:00-05:00",
  validation_state: "validated",
  fingerprint: "test-hash",
};
const status: DataStatus = {
  total: 5,
  first: record,
  last: record,
  source: "Fuente sintética de prueba",
  source_url: "https://example.test",
  timezone: "America/Bogota",
  state: "local",
  last_attempt: null,
  last_success: null,
  dataset_fingerprint: "synthetic-fingerprint",
  stored_versions: 5,
};
const latest: Latest = {
  record,
  previous: record,
  state: "stale",
  today: "2026-11-05",
  delta: "-1",
  variation_pct: "-0.82",
};
let failHistory = false;
let failSync = false;
let empty = false;
let pendingHistory = false;
let freshData = false;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  failHistory = false;
  failSync = false;
  empty = false;
  pendingHistory = false;
  freshData = false;
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const path = url.pathname;
    if (path.endsWith("/status"))
      return Response.json(
        empty
          ? { ...status, total: 0 }
          : {
              ...status,
              dataset_fingerprint: freshData
                ? "new-synthetic-fingerprint"
                : status.dataset_fingerprint,
            },
      );
    if (path.endsWith("/latest"))
      return Response.json(
        empty ? { ...latest, record: null, state: "empty" } : latest,
      );
    if (path.endsWith("/years")) return Response.json([2024, 2023]);
    if (path.endsWith("/sync")) {
      return failSync
        ? Response.json(
            { error: { message: "Fuente temporalmente no disponible" } },
            { status: 502 },
          )
        : Response.json({
            status: "success",
            mode: JSON.parse(String(options?.body)).mode,
          });
    }
    if (pendingHistory) return new Promise<Response>(() => {});
    if (failHistory)
      return Response.json(
        { error: { message: "Error de consulta de prueba" } },
        { status: 503 },
      );
    const count = empty
      ? 0
      : (url.searchParams.get("year") === "2023" ? 2 : 5) + (freshData ? 1 : 0);
    if (path.endsWith("/series"))
      return Response.json({
        count,
        points: count
          ? [
              {
                date: record.valid_from,
                valid_to: record.valid_to,
                value: record.value,
                extended: true,
              },
            ]
          : [],
        mean: count ? (freshData ? "113.20" : "112.20") : null,
        minimum: count ? "100" : null,
        maximum: count ? "121" : null,
        convention: "Convención sintética de prueba.",
      } satisfies Series);
    return Response.json({
      items: count ? [record] : [],
      total: count,
      page: Number(url.searchParams.get("page") || 1),
      pages: 2,
      page_size: 20,
    } satisfies History);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("SIMTRM, base funcional", () => {
  it("distingue la comprobación fallida de la última actualización válida sin exponer su error interno", async () => {
    const defaultFetch = fetchMock.getMockImplementation() as (
      input: string, options?: RequestInit,
    ) => Promise<Response>;
    const successful = {
      id: 1, mode: "incremental", status: "success",
      started_at: "2024-01-08T10:00:00-05:00",
      finished_at: "2024-01-08T10:01:00-05:00",
      expected: 5, received: 5, inserted: 5, revised: 0, removed: 0,
      error: null, audit: {},
    };
    const failed = {
      ...successful, id: 2, status: "failed",
      started_at: "2024-01-09T10:00:00-05:00",
      finished_at: "2024-01-09T10:01:00-05:00",
      error: "Traceback: RuntimeError en app/source.py",
    };
    fetchMock.mockImplementation((input: string, options?: RequestInit) =>
      input.endsWith("/status")
        ? Promise.resolve(Response.json({
            ...status, state: "source_error", last_success: successful,
            last_attempt: failed, checked_at: "2024-01-10T10:00:00-05:00",
          }))
        : defaultFetch(input, options),
    );
    render(<App />);
    await screen.findByRole("img");
    const update = screen.getByLabelText("Estado de actualización");
    expect(update).toHaveTextContent(timestamp(successful.finished_at));
    expect(update).toHaveTextContent(timestamp(failed.finished_at));
    expect(update).not.toHaveTextContent(timestamp("2024-01-10T10:00:00-05:00"));
    expect(update).toHaveTextContent(`con vigencia hasta el ${shortDate(record.valid_to)}`);
    expect(screen.getByText("Último dato · desactualizado")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Calidad de datos" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Intente actualizar la información más tarde");
    expect(document.body).not.toHaveTextContent("Traceback");
    expect(document.body).not.toHaveTextContent("source.py");
  });

  it("no anuncia una actualización satisfactoria cuando todavía no hay comprobaciones", async () => {
    render(<App />);
    await screen.findByRole("img");
    expect(screen.getByLabelText("Estado de actualización")).toHaveTextContent("Sin actualización registrada");
    expect(screen.getByLabelText("Estado de actualización")).toHaveTextContent("Sin comprobaciones registradas");
  });

  it("informa que conserva los datos al perder la conexión después de una consulta válida", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("img")).toBeInTheDocument();
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.getByRole("alert")).toHaveTextContent("Se muestran los últimos datos disponibles con las fechas de vigencia indicadas");
      expect(screen.getByRole("img")).toBeInTheDocument();
      expect(screen.getByText("Último dato · desactualizado")).toBeInTheDocument();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("incorpora novedades detectadas automáticamente conservando filtros y orden", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByLabelText("Año"), {
        target: { value: "2023" },
      });
      fireEvent.change(screen.getByLabelText("Mes"), {
        target: { value: "2" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByLabelText("Ordenar registros"), {
        target: { value: "value" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByRole("img", { name: "Gráfico de prueba: 2 registros" }),
      ).toBeInTheDocument();
      freshData = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(
        screen.getByRole("img", { name: "Gráfico de prueba: 3 registros" }),
      ).toBeInTheDocument();
      expect(screen.getByText("113,20")).toBeInTheDocument();
      expect(screen.getByLabelText("Año")).toHaveValue("2023");
      expect(screen.getByLabelText("Mes")).toHaveValue("2");
      expect(screen.getByLabelText("Ordenar registros")).toHaveValue("value");
      expect(
        fetchMock.mock.calls.some(
          ([url, options]) =>
            String(url).endsWith("/sync") && options?.method === "POST",
        ),
      ).toBe(false);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
  it("muestra datos y distingue un dato desactualizado", async () => {
    render(<App />);
    expect(
      await screen.findByRole("img", {
        name: "Gráfico de prueba: 5 registros",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Último dato · desactualizado"),
    ).toBeInTheDocument();
    expect(screen.getByText("112,20")).toBeInTheDocument();
    expect(screen.getByText("Extendida")).toBeInTheDocument();
  });

  it("cambia filtros, gráfico y tabla; restablece el periodo", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("img");
    await user.selectOptions(screen.getByLabelText("Año"), "2023");
    expect(
      await screen.findByRole("img", {
        name: "Gráfico de prueba: 2 registros",
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/history?year=2023"),
      ),
    ).toBe(true);
    await user.selectOptions(screen.getByLabelText("Mes"), "2");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("year=2023&month=2"),
        ),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "Restablecer" }));
    expect(
      await screen.findByRole("img", {
        name: "Gráfico de prueba: 5 registros",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Mes")).toBeDisabled();
  });

  it("navega entre módulos implementados", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("img");
    await user.click(screen.getByRole("button", { name: "Calidad de datos" }));
    expect(
      screen.getByText("Procedencia y cobertura de la información"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Metodología y fuentes" }),
    );
    expect(
      screen.getByRole("heading", { name: "Conceptos y criterios del análisis" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Histórico de TRM" }));
    expect(
      screen.getByRole("heading", { name: "Registros históricos" }),
    ).toBeInTheDocument();
  });

  it("muestra carga sin valores ficticios", async () => {
    pendingHistory = true;
    render(<App />);
    expect(
      screen.getByText("Consultando registros…"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("muestra ausencia de datos y acceso a sincronización", async () => {
    empty = true;
    render(<App />);
    expect(
      await screen.findByText("El análisis comienza con datos reales"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preparar datos oficiales" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("permite recuperar una consulta fallida", async () => {
    failHistory = true;
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Error de consulta de prueba",
    );
    failHistory = false;
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
  });

  it("valida rangos invertidos y oculta los resultados anteriores", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("img");
    // Native date controls accept ISO dates through their change event.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("Desde"), {
      target: { value: "2024-02-01" },
    });
    fireEvent.change(screen.getByLabelText("Hasta"), {
      target: { value: "2024-01-01" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La fecha inicial",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restablecer" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
  });

  it("pagina y cambia el orden de consulta", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("img");
    const seriesCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/series?"))
        .length;
    const before = seriesCalls();
    await user.click(screen.getByRole("button", { name: "Siguiente →" }));
    expect(
      await screen.findByText("5 registros · Página 2 de 2"),
    ).toBeInTheDocument();
    expect(seriesCalls()).toBe(before);
    await user.selectOptions(
      screen.getByLabelText("Ordenar registros"),
      "value",
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("sort=value"),
        ),
      ).toBe(true),
    );
    expect(seriesCalls()).toBe(before);
  });

  it("ejecuta sincronización y presenta sus errores", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("img");
    await user.click(screen.getByRole("button", { name: "Calidad de datos" }));
    await user.selectOptions(
      screen.getByLabelText("Alcance de la actualización"),
      "full",
    );
    await user.click(
      screen.getByRole("button", { name: /Comprobar nuevas publicaciones/ }),
    );
    expect(
      await screen.findByText(
        "Consulta completada. Puede revisar los registros disponibles.",
      ),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, options]) => options?.body === '{"mode":"full"}',
      ),
    ).toBe(true);
    failSync = true;
    await user.click(
      screen.getByRole("button", { name: /Comprobar nuevas publicaciones/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Fuente temporalmente no disponible",
    );
  });
});
