import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { RollingEvaluation } from "../src/types";

test("historial completo, filtros, resultados originales, Excel y reutilización", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const seed = testInfo.project.name === "chrome" ? 39112001 : 39112002;
  const originals: RollingEvaluation[] = [];
  // Actual calculations in the isolated database, exceeding the old twenty-result limit.
  for (let i = 0; i < 23; i++) {
    const response = await request.post("/api/v1/validations/rolling", { data: {
      settings: { method: i === 0 ? "arima" : i % 2 ? "bootstrap" : "monte_carlo",
        training_records: 31 + i, replicas: 100, seed, volatility_scale: i === 0 ? 0.75 : 1 },
      horizons: [1, 5], folds: 2, unit: i === 0 ? "transitions" : "calendar_days",
      last_cutoff: i === 0 ? "2025-12-31" : null,
    } });
    expect(response.status()).toBe(201);
    originals.push(await response.json());
  }
  let calculationRequests = 0;
  page.on("request", r => {
    if (r.method() === "POST" && r.url().endsWith("/validations/rolling")) calculationRequests++;
  });
  await page.goto("/#backtest");
  const archive = page.getByRole("region", { name: "Mis evaluaciones", exact: true });
  await expect(archive.getByRole("heading", { name: "Mis evaluaciones" })).toBeVisible();
  await expect(page.getByLabel("Identificador de evaluación", { exact: true })).toHaveCount(0);
  await archive.getByLabel("Buscar evaluaciones", { exact: true }).fill(String(seed));
  await archive.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(archive).toContainText("23 evaluaciones · Página 1 de 5");
  for (let pageIndex = 2; pageIndex <= 5; pageIndex++) {
    await archive.getByRole("button", { name: "Siguiente", exact: true }).click();
    await expect(archive).toContainText(`23 evaluaciones · Página ${pageIndex} de 5`);
  }
  const original = originals[0];
  const oldest = archive.getByRole("row").filter({ hasText: "Ventana: 31 vigencias" });
  await expect(oldest).toContainText("ARIMA(1,1,0)");
  await expect(oldest).toContainText("transiciones");
  const pendingDownload = page.waitForEvent("download");
  await oldest.getByRole("button", { name: "Descargar Excel", exact: true }).click();
  const download = await pendingDownload;
  expect(await download.failure()).toBeNull();
  await download.saveAs(testInfo.outputPath("selected-evaluation.xlsx"));
  await testInfo.attach("selected-evaluation", { body: JSON.stringify(original), contentType: "application/json" });

  const recovery = page.waitForResponse(r => r.url().endsWith(`/validations/rolling/${original.id}`));
  await oldest.getByRole("button", { name: "Abrir resultados", exact: true }).click();
  expect(await (await recovery).json()).toEqual(original);
  expect(calculationRequests).toBe(0);
  const chart = page.getByRole("group", { name: "Proyecciones retrospectivas frente a TRM observada", exact: true });
  await expect(chart.locator(".main-svg").first()).toBeVisible();
  const plotted = await chart.evaluate(element => {
    const data = (element as unknown as { data: { y: number[] }[] }).data;
    return data.map(trace => trace.y);
  });
  const cases = original.cases.filter(c => c.horizon === original.summaries[0].horizon);
  expect(plotted).toEqual([cases.map(c => c.predicted), cases.map(c => c.actual), cases.map(c => c.initial)]);
  await page.getByRole("button", { name: "Usar esta configuración", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Método a evaluar", exact: true })).toHaveValue("arima");
  await expect(page.getByRole("combobox", { name: "Unidad de evaluación", exact: true })).toHaveValue("transitions");
  await expect(page.getByLabel("Ventana de entrenamiento (vigencias)", { exact: true })).toHaveValue("31");
  await expect(page.getByLabel("Factor de volatilidad", { exact: true })).toHaveValue("0.75");
  await expect(page.getByLabel("Último corte histórico (opcional)", { exact: true })).toHaveValue("2025-12-31");
  expect(calculationRequests).toBe(0);
  const execution = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/validations/rolling"));
  await page.getByRole("button", { name: "Evaluar varios cortes", exact: true }).click();
  const next = await (await execution).json() as RollingEvaluation;
  expect(next.id).not.toBe(original.id);
  expect(next.request).toEqual(original.request);
  expect(next.summaries).toEqual(original.summaries);
  expect(calculationRequests).toBe(1);
  expect(await (await request.get(`/api/v1/validations/rolling/${original.id}`)).json()).toEqual(original);
  await expect(archive).toContainText("24 evaluaciones · Página 5 de 5");

  const today = (await (await request.get("/api/v1/trm/latest")).json()).today as string;
  await archive.getByText("Filtros por fecha, método y horizonte", { exact: true }).click();
  await archive.getByRole("combobox", { name: "Método guardado", exact: true }).selectOption("monte_carlo");
  await archive.getByLabel("Horizonte guardado", { exact: true }).fill("5");
  await archive.getByRole("combobox", { name: "Unidad del horizonte", exact: true }).selectOption("calendar_days");
  await archive.getByLabel("Creada desde", { exact: true }).fill(today);
  await archive.getByLabel("Creada hasta", { exact: true }).fill(today);
  await archive.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(archive).toContainText("11 evaluaciones · Página 1 de 3");
  await archive.getByLabel("Buscar evaluaciones", { exact: true }).fill(`sin-resultados-${seed}`);
  await archive.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(archive).toContainText("No hay evaluaciones que coincidan");
  await archive.getByRole("button", { name: "Limpiar filtros", exact: true }).click();
  await expect(archive.getByLabel("Buscar evaluaciones", { exact: true })).toHaveValue("");
  await expect(archive.getByRole("button", { name: "Actualizar lista", exact: true })).toBeEnabled();
  await page.route("**/api/v1/validations/rolling?**", route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Consulta temporalmente no disponible" } }),
  }));
  await archive.getByRole("button", { name: "Actualizar lista", exact: true }).click();
  await expect(archive.getByRole("alert")).toContainText("Consulta temporalmente no disponible");
  await page.unroute("**/api/v1/validations/rolling?**");
  await archive.getByRole("button", { name: "Reintentar consulta", exact: true }).click();
  await expect(archive.getByRole("button", { name: "Actualizar lista", exact: true })).toBeEnabled();
  await expect(archive.getByRole("alert")).toHaveCount(0);
  await archive.getByText("Filtros por fecha, método y horizonte", { exact: true }).click();
  await page.getByRole("heading", { level: 1 }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("mis-evaluaciones-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations.map(v => v.id)).toEqual([]);
  await page.getByRole("heading", { level: 1 }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("mis-evaluaciones-mobile.png"), fullPage: true });
});

test("un historial vacío ofrece crear una evaluación sin mostrar códigos técnicos", async ({ page }) => {
  await page.route("**/api/v1/validations/rolling?**", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, page: 1, page_size: 5, pages: 0 }),
  }));
  await page.goto("/#backtest");
  const archive = page.getByRole("region", { name: "Mis evaluaciones", exact: true });
  await expect(archive).toContainText("Aún no hay evaluaciones guardadas");
  await archive.getByRole("button", { name: "Nueva evaluación", exact: true }).click();
  await expect(page.getByRole("form", { name: "Configurar evaluación", exact: true })).toBeFocused();
});
