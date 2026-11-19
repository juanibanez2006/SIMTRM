import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { downloadWorkbook } from "../api";
import ExportButton from "../ExportButton";

const mime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function response() {
  return new Response(new Uint8Array([80, 75, 3, 4, 0, 0]), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": 'attachment; filename="SIMTRM_prueba.xlsx"',
    },
  });
}
function browserDownload() {
  const create = vi.fn(() => "blob:synthetic-workbook");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: create,
      revokeObjectURL: revoke,
    }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  return { create, revoke, click };
}
afterEach(() => vi.useRealTimers());

it("descarga un XLSX con nombre seguro y libera el objeto temporal", async () => {
  vi.useFakeTimers();
  const browser = browserDownload();
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetch);
  await downloadWorkbook("/exports/history?year=2024", "fallback.xlsx");
  expect(fetch).toHaveBeenCalledWith("/api/v1/exports/history?year=2024", {});
  expect(browser.click).toHaveBeenCalledOnce();
  expect(browser.create).toHaveBeenCalledOnce();
  expect(document.querySelector("a[download]")).toBeNull();
  vi.advanceTimersByTime(1000);
  expect(browser.revoke).toHaveBeenCalledWith("blob:synthetic-workbook");
});

it("no descarga respuestas fallidas ni CSV o archivos sin firma ZIP", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Fuente local cambió" } },
          { status: 409 },
        ),
      ),
  );
  await expect(
    downloadWorkbook("/exports/history", "bad.xlsx"),
  ).rejects.toThrow("Fuente local cambió");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("a,b", { headers: { "Content-Type": "text/csv" } }),
      ),
  );
  await expect(
    downloadWorkbook("/exports/history", "bad.xlsx"),
  ).rejects.toThrow("Excel válido");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("not-a-zip", { headers: { "Content-Type": mime } }),
      ),
  );
  await expect(
    downloadWorkbook("/exports/history", "bad.xlsx"),
  ).rejects.toThrow("El archivo recibido no es válido");
});

it("el botón maneja errores, reintento y cuerpo de exportación de simulaciones", async () => {
  browserDownload();
  const user = userEvent.setup();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: "Experimento no encontrado" } },
        { status: 404 },
      ),
    )
    .mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", fetch);
  render(
    <ExportButton
      path="/exports/simulation"
      filename="SIMTRM.xlsx"
      body={{ experiment_id: "synthetic-id", include_paths: true }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Descargar Excel" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Experimento no encontrado",
  );
  await user.click(screen.getByRole("button", { name: "Descargar Excel" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  const options = fetch.mock.calls.at(-1)![1] as RequestInit;
  expect(options.method).toBe("POST");
  expect(JSON.parse(String(options.body))).toEqual({
    experiment_id: "synthetic-id",
    include_paths: true,
  });
});
