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
    "El servicio respondió con error 502",
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
    "Compruebe que el backend esté iniciado",
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
  await expect(request("/trm/latest")).rejects.toThrow("respuesta no válida");
});
