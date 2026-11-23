import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../App";
import { latest, projection, status } from "./projectionFixtures";
vi.mock("../useLocalData", () => ({
  default: () => ({
    status,
    latest,
    years: [2026, 2025],
    today: latest.today,
    revision: 0,
    metadataError: "",
  }),
}));
vi.mock("../PlotChart", () => ({
  default: () => <div role="img" aria-label="Gráfico de prueba" />,
}));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (path: string) => {
    if (path.includes("/validations/rolling?")) return Response.json({items: [], total: 0, page: 1, page_size: 5, pages: 0});
    if (path.includes("/history"))
      return Response.json({
        items: [latest.record],
        total: 21,
        page:
          new URL(path, "http://test").searchParams.get("page") === "2" ? 2 : 1,
        page_size: 20,
        pages: 2,
      });
    if (path.endsWith("/experiments")) return Response.json([]);
    return Response.json(projection);
  });
  vi.stubGlobal("fetch", fetchMock);
});
it("la navegación contiene únicamente el flujo de proyección, validación y datos", () => {
  render(<App />);
  const nav = screen.getByRole("navigation");
  expect(nav.querySelectorAll("button")).toHaveLength(3);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Proyección de la TRM",
  );
  expect(screen.queryByText("Comparar periodos")).not.toBeInTheDocument();
  expect(screen.queryByText("Exportaciones")).not.toBeInTheDocument();
});
it("consulta datos oficiales, filtra y pagina sin pantallas históricas obsoletas", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    screen.getByRole("button", { name: "Datos oficiales" }),
  );
  await screen.findByText("21 registros · Página 1 de 2");
  await user.selectOptions(screen.getByLabelText("Año"), "2025");
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([path]) => String(path).includes("year=2025")),
    ).toBe(true),
  );
  await user.click(
    screen.getByRole("button", { name: "Siguiente" }),
  );
  await screen.findByText("21 registros · Página 2 de 2");
  fireEvent.change(screen.getByLabelText("Desde"), {
    target: { value: "2026-02-01" },
  });
  fireEvent.change(screen.getByLabelText("Hasta"), {
    target: { value: "2026-01-01" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("fecha inicial");
});
it("actualiza la fuente y comunica fallos de conexión", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    screen.getByRole("button", { name: "Datos oficiales" }),
  );
  await user.click(screen.getByText("Actualizar histórico oficial"));
  fetchMock.mockImplementation(async (path: string) =>
    path.endsWith("/sync")
      ? Response.json(
          { error: { message: "Fuente oficial no disponible" } },
          { status: 502 },
        )
      : Response.json({ items: [], total: 0, page: 1, pages: 0 }),
  );
  await user.click(
    screen.getByRole("button", { name: "Comprobar nuevas publicaciones" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Fuente oficial no disponible",
  );
});
it("un hash de una pantalla retirada vuelve a la proyección", () => {
  window.history.replaceState(null, "", "/#comparison");
  render(<App />);
  expect(window.location.hash).toBe("#home");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Proyección de la TRM",
  );
});
