import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Projection, RollingEvaluation } from "../src/types";
import { money } from "../src/format";
import { afterDays } from "../src/projectionSettings";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const collected: string[] = [];
  errors.set(page, collected);
  page.on("pageerror", error => collected.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") collected.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Proyección de la TRM");
  await expect(page.getByRole("button", { name: "Calcular proyección", exact: true })).toBeEnabled();
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function download(page: Page, name: string, file: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const result = await pending;
  expect(result.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(await result.failure()).toBeNull();
  await result.saveAs(test.info().outputPath(file));
}

async function run(page: Page, date: string) {
  await page.getByLabel("Fecha de proyección", { exact: true }).fill(date);
  const pending = page.waitForResponse(r => r.url().endsWith("/projections") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Calcular proyección", exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  const result = await response.json() as Projection;
  await expect(page.locator(".projection-result h2")).toContainText(money(result.estimate));
  const chart = page.locator(".projection-page .temporal-chart").first();
  await expect(chart.locator(".main-svg").first()).toBeVisible();
  const end = await chart.evaluate(element => {
    const traces = (element as unknown as { data: { y: number[] }[] }).data;
    return traces[3].y.at(-1);
  });
  expect(end).toBe(result.estimate);
  await test.info().attach(`projection-${result.id}`, { body: JSON.stringify(result), contentType: "application/json" });
  return result;
}

test("HTTPS: modelos reales, probabilidades, escenarios, Excel y privacidad", async ({ page, browser }, info) => {
  const api = page.context().request;
  const latest = await (await api.get("/api/v1/trm/latest")).json();
  await page.getByText("Parámetros del modelo", { exact: true }).click();
  await page.getByLabel("Réplicas de proyección", { exact: true }).fill("200");
  const bootstrap = await run(page, afterDays(latest.today, 7));
  expect(bootstrap.request.method).toBe("bootstrap");
  await download(page, "Descargar Excel", "bootstrap.xlsx");

  await page.getByLabel("Método de proyección", { exact: true }).selectOption("monte_carlo");
  const monte = await run(page, afterDays(latest.today, 90));
  expect(monte.request.method).toBe("monte_carlo");
  expect(monte.points!.length).toBeGreaterThan(bootstrap.points!.length);
  await download(page, "Descargar Excel", "monte-carlo.xlsx");

  await page.getByLabel("Método de proyección", { exact: true }).selectOption("arima");
  await page.getByLabel("Periodo histórico", { exact: true }).selectOption("dates");
  await page.getByLabel("Entrenamiento desde", { exact: true }).fill("2025-01-01");
  await page.getByLabel("Entrenamiento hasta", { exact: true }).fill("2025-12-31");
  await page.getByText("Probabilidades para la fecha elegida", { exact: true }).click();
  await page.getByLabel("Umbral COP/USD", { exact: true }).fill("3500");
  await page.getByLabel("Límite inferior COP/USD", { exact: true }).fill("3000");
  await page.getByLabel("Límite superior COP/USD", { exact: true }).fill("3800");
  const first = await run(page, afterDays(latest.today, 30));
  expect(first.experiment.training.first_date).toBe("2025-01-01");
  const model = first.experiment.methods[0];
  const probability = model.probabilities.find(p => p.event === "above_threshold")!;
  expect(probability.count).toBe(model.terminal_values.filter(v => v > 3500).length);
  await expect(page.locator(".probability-results > div")).toHaveCount(3);
  await page.getByRole("button", { name: "Añadir a comparación", exact: true }).click();
  await page.getByLabel("Factor de volatilidad", { exact: false }).first().fill("1.5");
  const second = await run(page, first.target_date!);
  expect(second.upper - second.lower).toBeGreaterThan(first.upper - first.lower);
  await page.getByRole("button", { name: "Añadir a comparación", exact: true }).click();
  const compared = page.getByRole("group", { name: "Comparación de medianas por fecha", exact: true });
  await expect(compared.locator(".main-svg").first()).toBeVisible();
  const endpoints = await compared.evaluate(element => (element as unknown as { data: { y: number[] }[] }).data.map(t => t.y.at(-1)));
  expect(endpoints).toEqual([first.estimate, second.estimate]);
  await download(page, "Excel de la comparación", "scenarios.xlsx");
  await page.getByLabel("Incluir trayectorias en Excel", { exact: true }).check();
  await download(page, "Descargar Excel", "arima-paths.xlsx");

  const replay = await api.post(`/api/v1/projections/${second.id}/replay`);
  expect(replay.status(), await replay.text()).toBe(201);
  expect((await replay.json()).experiment.numeric_fingerprint).toBe(second.experiment.numeric_fingerprint);
  await page.getByText("Experimentos guardados", { exact: true }).click();
  await page.getByLabel("Identificador de experimento", { exact: true }).fill(bootstrap.id);
  await page.getByRole("button", { name: "Recuperar experimento", exact: true }).click();
  await expect(page.locator(".projection-result h2")).toContainText(money(bootstrap.estimate));
  const isolated = await browser.newContext({ baseURL: "https://simtrm-production.up.railway.app" });
  expect((await isolated.request.get(`/api/v1/projections/${bootstrap.id}`)).status()).toBe(404);
  expect(await (await isolated.request.get("/api/v1/experiments")).json()).toEqual([]);
  await isolated.close();
  await page.context().storageState({ path: info.outputPath("session-state.json") });
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations.map(v => v.id)).toEqual([]);
  await page.screenshot({ path: info.outputPath("production-mobile.png"), fullPage: true });
});

test("HTTPS: validación retrospectiva, recuperación original y reutilización", async ({ page }, info) => {
  await page.getByRole("navigation").getByRole("button", { name: "Validación del modelo", exact: true }).click();
  await page.getByLabel("Ventana de entrenamiento (vigencias)", { exact: true }).fill("64");
  await page.getByLabel("Réplicas por corte", { exact: true }).fill("100");
  await page.getByLabel(/Horizontes en días calendario/).fill("7,30");
  await page.getByLabel("Cortes solicitados", { exact: true }).fill("2");
  const pending = page.waitForResponse(r => r.url().endsWith("/validations/rolling") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Evaluar varios cortes", exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  const original = await response.json() as RollingEvaluation;
  expect(original.cases).toHaveLength(4);
  expect(original.cases.every(c => c.cutoff < c.target && Number.isFinite(c.predicted))).toBe(true);
  await info.attach(`evaluation-${original.id}`, { body: JSON.stringify(original), contentType: "application/json" });
  await download(page, "Excel de la evaluación en varios cortes", "rolling.xlsx");
  const archive = page.getByRole("region", { name: "Mis evaluaciones", exact: true });
  const recovery = page.waitForResponse(r => r.url().endsWith(`/validations/rolling/${original.id}`));
  await archive.getByRole("button", { name: "Ver resultados abiertos", exact: true }).click();
  expect(await (await recovery).json()).toEqual(original);
  await page.getByRole("button", { name: "Usar esta configuración", exact: true }).click();
  await expect(page.getByLabel("Ventana de entrenamiento (vigencias)", { exact: true })).toHaveValue("64");
  await page.context().storageState({ path: info.outputPath("session-state.json") });
  await page.screenshot({ path: info.outputPath("production-validation.png"), fullPage: true });
});

test("HTTPS: histórico oficial, filtros y descarga completa del periodo", async ({ page }, info) => {
  const status = await (await page.context().request.get("/api/v1/data/status")).json();
  expect(status.total).toBeGreaterThan(8000);
  expect(status.last_success.status).toBe("success");
  expect(status.auto_sync_enabled).toBe(true);
  expect(status.manual_sync_available).toBe(false);
  await page.getByRole("navigation").getByRole("button", { name: "Datos oficiales", exact: true }).click();
  await page.getByLabel("Año", { exact: true }).selectOption("2025");
  await expect(page.locator(".pagination")).toContainText("Página 1");
  await page.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("Página 2");
  await download(page, "Excel del histórico consultado", "history.xlsx");
  await page.getByRole("button", { name: "Consultar rendimientos del periodo" }).click();
  await expect(page.getByRole("heading", { name: "Rendimientos para calibración" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Comprobar nuevas publicaciones" })).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations.map(v => v.id)).toEqual([]);
  await page.screenshot({ path: info.outputPath("production-data.png"), fullPage: true });
});
