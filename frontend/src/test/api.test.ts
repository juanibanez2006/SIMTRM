import { expect, it, vi } from "vitest";
import { queryString, request } from "../api";
import { money, shortDate } from "../format";

it("codifica parámetros y excluye filtros vacíos", () => {
  expect(
    queryString({ year: "2024", month: "", start: "2024-01-01", page: 2 }),
  ).toBe("year=2024&start=2024-01-01&page=2");
});

it("expone un error HTTP comprensible incluso sin JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("bad", { status: 502 })),
  );
  await expect(request("/trm/history")).rejects.toThrow(
    "No fue posible completar la consulta",
  );
});

it("formatea dinero y fechas sin desplazar la fecha por zona horaria", () => {
  expect(money("1234.50")).toBe("1.234,50");
  expect(shortDate("2024-01-01")).toContain("01");
  expect(money(null)).toBe("—");
});

it("explica una desconexión del backend en español", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
  );
  await expect(request("/trm/latest")).rejects.toThrow(
    "No fue posible consultar la información",
  );
});

it("conserva las cancelaciones y rechaza respuestas exitosas que no son JSON", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new DOMException("Canceled", "AbortError");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
  await expect(
    request("/trm/latest", { signal: controller.signal }),
  ).rejects.toBe(aborted);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("<html>proxy</html>")),
  );
  await expect(request("/trm/latest")).rejects.toThrow("No fue posible interpretar la información");
});

it.each([
  [500, "Error interno del servicio"],
  [502, "Traceback: RuntimeError en C:\\app\\source.py"],
  [502, "La fuente devolvió JSON inválido"],
  [422, { detail: "unexpected response" }],
])("presenta un aviso comprensible ante HTTP %s sin exponer detalles internos", async (status, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    Response.json({ error: { message } }, { status }),
  ));
  await expect(request("/data/sync")).rejects.toThrow(
    "No fue posible completar la consulta. Inténtelo de nuevo en unos momentos.",
  );
});

it("conserva la indicación necesaria para corregir los parámetros del análisis", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    Response.json({ error: { message: "La fecha inicial no puede superar la final" } }, { status: 422 }),
  ));
  await expect(request("/statistics")).rejects.toThrow("La fecha inicial no puede superar la final");
});

it("explica cómo continuar cuando la reproducción exacta no es posible", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    Response.json({ error: { message: "El entorno numérico o el algoritmo cambió; no se garantiza reproducción exacta" } }, { status: 422 }),
  ));
  await expect(request("/simulations/example/replay")).rejects.toThrow("Puede consultar o descargar el resultado guardado");
});

it.each([
  ["Base de datos no disponible", "Los datos no están disponibles"],
  ["Token administrativo requerido", "Revise la clave de actualización"],
  ["Sincronización restringida al equipo local", "No tiene autorización para actualizar"],
])("orienta al usuario ante %s", async (message, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    Response.json({ error: { message } }, { status: 403 }),
  ));
  await expect(request("/data/sync")).rejects.toThrow(expected);
});
