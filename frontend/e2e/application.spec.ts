import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Projection, RollingEvaluation, Simulation } from "../src/types";
import { money } from "../src/format";
import { afterDays } from "../src/projectionSettings";

const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) =>
    route.abort(),
  );
});
test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
});
async function run(page: Page, target?: string) {
  if (target)
    await page.getByLabel("Fecha de proyección", { exact: true }).fill(target);
  const pending = page.waitForResponse(
    (r) => r.url().endsWith("/projections") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Calcular proyección", exact: true })
    .click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const result = (await response.json()) as Projection;
  await expect(page.locator(".projection-result h2")).toContainText(
    money(result.estimate),
  );
  await expect(
    page
      .locator(".projection-page .temporal-chart")
      .first()
      .locator(".main-svg")
      .first(),
  ).toBeVisible();
  return result;
}
async function navigate(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.locator("h1")).toHaveText(name);
}
async function accessible(page: Page) {
  await expect(page.locator(".loading:visible")).toHaveCount(0);
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        failure: n.failureSummary,
      })),
    })),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}
async function xlsx(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(await download.failure()).toBeNull();
  await download.saveAs(test.info().outputPath(`${name}-${download.suggestedFilename()}`));
}

test("fecha futura, ancla oficial, tabla, gráfico, Excel y reproducción", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const latest = await (await request.get("/api/v1/trm/latest")).json();
  await page.goto("/");
  const target =
    latest.today < "2026-12-05" ? "2026-12-05" : afterDays(latest.today, 30);
  const result = await run(page, target);
  if (target === "2026-12-05") {
    expect(result.projected_from).toBe("2026-12-05");
    expect(result.projected_to).toBe("2026-12-07");
  }
  const row = page.locator('.requested-projection[aria-current="date"]');
  await expect(row).toContainText(money(result.estimate));
  await expect(row).toContainText(money(result.lower));
  await expect(row).toContainText(money(result.upper));
  const plotted = await page
    .locator(".projection-page .temporal-chart")
    .first()
    .evaluate((element) => {
      const traces = (
        element as unknown as {
          data: { x: string[]; y: number[]; line: { color: string } }[];
        }
      ).data;
      return {
        initial: traces[3].y[0],
        median: traces[3].y.at(-1),
        historical: traces[0].y.at(-1),
        color: traces[3].line.color,
        date: traces[3].x.at(-1),
      };
    });
  expect(plotted).toEqual({
    initial: result.experiment.initial_price,
    median: result.estimate,
    historical: result.experiment.initial_price,
    color: "#bc5f16",
    date: target,
  });
  await xlsx(page, "Descargar Excel");
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await accessible(page);
    await page.screenshot({
      path: testInfo.outputPath(`proyeccion-${width}.png`),
      fullPage: true,
    });
  }
  await page
    .getByText("Metodología y datos del experimento", { exact: true })
    .click();
  const pending = page.waitForResponse((r) =>
    r.url().endsWith(`/projections/${result.id}/replay`),
  );
  await page
    .getByRole("button", {
      name: "Reproducir proyección guardada",
      exact: true,
    })
    .click();
  const replay = (await (await pending).json()) as Projection;
  expect(replay.points).toEqual(result.points);
  expect(replay.experiment.numeric_fingerprint).toBe(
    result.experiment.numeric_fingerprint,
  );
  await page
    .getByText("Trayectorias y descarga técnica", { exact: true })
    .click();
  await xlsx(page, "Descargar trayectorias completas");
});

test("Montecarlo, fin de semana, fecha festiva y parámetros modificados", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const latest = await (await request.get("/api/v1/trm/latest")).json();
  await page.goto("/");
  await page.getByText("Parámetros del modelo", { exact: true }).click();
  await page
    .getByLabel("Método de proyección", { exact: true })
    .selectOption("monte_carlo");
  await page.getByLabel("Réplicas de proyección", { exact: true }).fill("300");
  const saturday =
    latest.today < "2026-12-05" ? "2026-12-05" : afterDays(latest.today, 30);
  const first = await run(page, saturday);
  expect(first.request.method).toBe("monte_carlo");
  const same = await run(page, first.projected_to!);
  expect(same.estimate).toBe(first.estimate);
  expect(same.request.horizon).toBe(first.request.horizon);
  const holiday =
    latest.today < "2026-12-08" ? "2026-12-08" : afterDays(latest.today, 40);
  const following = await run(page, holiday);
  if (holiday === "2026-12-08")
    expect(following.projected_to).toBe("2026-12-09");
  await page.getByLabel("Semilla de proyección", { exact: true }).fill("2027");
  await expect(
    page.locator(".projection-page .comparison-draft"),
  ).toBeVisible();
});

test("validación por fechas: datos posteriores, errores y recuperación", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/#backtest");
  await page.getByLabel("Réplicas por corte", { exact: true }).fill("300");
  const pending = page.waitForResponse(
    (r) =>
      r.url().endsWith("/validations/rolling") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Evaluar varios cortes", exact: true })
    .click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const result = (await response.json()) as RollingEvaluation;
  expect(result.request.unit).toBe("calendar_days");
  expect(new Set(result.cases.map((c) => c.cutoff)).size).toBeGreaterThan(1);
  expect(result.cases.every((c) => c.target > c.cutoff)).toBe(true);
  await page
    .getByText("Valores por corte y trazabilidad", { exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "Error porcentual", exact: true }),
  ).toBeVisible();
  await xlsx(page, "Excel de la evaluación en varios cortes");
  await navigate(page, "Datos oficiales");
  await navigate(page, "Validación del modelo");
  await expect(
    page.getByRole("heading", {
      name: "Errores por horizonte frente a persistencia",
    }),
  ).toBeVisible();
  const recovered = page.waitForResponse(r => r.url().endsWith(`/validations/rolling/${result.id}`));
  await page.getByRole("region", {name: "Mis evaluaciones", exact: true})
    .getByRole("button", {name: "Ver resultados abiertos", exact: true}).click();
  expect(await (await recovered).json()).toEqual(result);
  await expect(page.locator(".evaluation-output")).toBeFocused();
  await accessible(page);
});

test("datos oficiales: filtros, actualización fallida, rendimientos y navegación", async ({
  page,
  request,
}) => {
  const years = (await (
    await request.get("/api/v1/trm/years")
  ).json()) as number[];
  await page.goto("/#data");
  await page
    .getByLabel("Año", { exact: true })
    .selectOption(String(years[1] ?? years[0]));
  await expect(page.locator(".pagination")).toContainText("Página 1");
  await page.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("Página 2");
  await xlsx(page, "Excel del histórico consultado");
  await page
    .getByRole("button", { name: "Consultar rendimientos del periodo" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Rendimientos para calibración" }),
  ).toBeVisible();
  await page.route("**/api/v1/data/sync", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Fuente oficial no disponible" },
      }),
    }),
  );
  await page.getByText("Actualizar histórico oficial", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Comprobar nuevas publicaciones",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Fuente oficial no disponible",
  );
  await navigate(page, "Proyección de la TRM");
  await navigate(page, "Datos oficiales");
  await expect(page.getByLabel("Año", { exact: true })).toHaveValue(
    String(years[1] ?? years[0]),
  );
  await accessible(page);
});

test("los tres módulos se adaptan a cuatro tamaños sin rutas obsoletas", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(
      3,
    );
    for (const name of [
      "Datos oficiales",
      "Validación del modelo",
      "Proyección de la TRM",
    ]) {
      await navigate(page, name);
      await accessible(page);
    }
    await page.screenshot({
      path: testInfo.outputPath(`inicio-${width}.png`),
      fullPage: true,
    });
  }
  await page.goto("/#comparison");
  await expect(page).toHaveURL(/#home$/);
  await expect(page.locator("h1")).toHaveText("Proyección de la TRM");
});

test("recupera experimentos anteriores sin inventar fechas y conserva reproducción", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const response = await request.post("/api/v1/simulations", {
    data: {
      training_start: "2025-01-01",
      training_end: "2025-12-31",
      cutoff_date: "2025-12-31",
      replicas: 100,
      horizon: 5,
      method: "both",
      seed: 2026,
    },
  });
  expect(response.status()).toBe(201);
  const original = (await response.json()) as Simulation;
  await page.goto("/");
  await page.getByText("Experimentos guardados", { exact: true }).click();
  await page
    .getByLabel("Tipo de experimento", { exact: true })
    .selectOption("simulation");
  await page
    .getByLabel("Identificador de experimento", { exact: true })
    .fill(original.id);
  await page
    .getByRole("button", { name: "Recuperar experimento", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Simulación guardada", exact: true }),
  ).toBeVisible();
  const pending = page.waitForResponse((r) =>
    r.url().endsWith(`/simulations/${original.id}/replay`),
  );
  await page
    .getByRole("button", {
      name: "Reproducir simulación guardada",
      exact: true,
    })
    .click();
  const replay = (await (await pending).json()) as Simulation;
  expect(replay.numeric_fingerprint).toBe(original.numeric_fingerprint);
  await xlsx(page, "Excel técnico del experimento");
});

test("errores de cálculo y fecha inválida no sustituyen los resultados por datos ficticios", async ({
  page,
}) => {
  await page.goto("/");
  await page.route("**/api/v1/projections", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Se requieren 252 vigencias de entrenamiento" },
      }),
    }),
  );
  await page
    .getByRole("button", { name: "Calcular proyección", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("252 vigencias");
  await expect(page.locator(".projection-result")).toHaveCount(0);
  await page
    .getByLabel("Fecha de proyección", { exact: true })
    .fill("2000-01-01");
  expect(
    await page
      .getByLabel("Fecha de proyección", { exact: true })
      .evaluate((input) => (input as HTMLInputElement).validity.rangeUnderflow),
  ).toBe(true);
});

test("ARIMA, periodo histórico, probabilidades y comparación exportable", async ({ page, request }) => {
  test.setTimeout(120_000);
  const latest = await (await request.get("/api/v1/trm/latest")).json();
  await page.goto("/");
  await page.getByText("Parámetros del modelo", {exact: true}).click();
  await page.getByLabel("Método de proyección", {exact: true}).selectOption("arima");
  await page.getByLabel("Periodo histórico", {exact: true}).selectOption("dates");
  await page.getByLabel("Entrenamiento desde", {exact: true}).fill("2025-01-01");
  await page.getByLabel("Entrenamiento hasta", {exact: true}).fill("2025-12-31");
  await page.getByLabel("Réplicas de proyección", {exact: true}).fill("200");
  await page.getByText("Probabilidades para la fecha elegida", {exact: true}).click();
  await page.getByLabel("Umbral COP/USD", {exact: true}).fill("3300");
  await page.getByLabel("Límite inferior COP/USD", {exact: true}).fill("3000");
  await page.getByLabel("Límite superior COP/USD", {exact: true}).fill("3600");
  const first = await run(page, afterDays(latest.today, 30));
  expect(first.request.method).toBe("arima");
  expect(first.experiment.training.first_date).toBe("2025-01-01");
  const model = first.experiment.methods[0];
  expect(model.probabilities.find(p => p.event === "above_threshold")?.count)
    .toBe(model.terminal_values.filter(v => v > 3300).length);
  await expect(page.locator(".probability-results > div")).toHaveCount(3);
  await page.getByRole("button", {name: "Añadir a comparación", exact: true}).click();
  await page.getByLabel("Factor de volatilidad", {exact: false}).first().fill("1.5");
  const second = await run(page, afterDays(latest.today, 30));
  expect(second.request.volatility_scale).toBe(1.5);
  expect(second.upper - second.lower).toBeGreaterThan(first.upper - first.lower);
  await page.getByRole("button", {name: "Añadir a comparación", exact: true}).click();
  await expect(page.getByRole("region", {name: "Escenarios comparados"}).getByRole("row")).toHaveCount(3);
  const comparison = page.getByRole("group", {name: "Comparación de medianas por fecha", exact: true});
  await expect(comparison.locator(".main-svg").first()).toBeVisible();
  const endpoints = await comparison.evaluate(element =>
    (element as unknown as {data: {x: string[]; y: number[]}[]}).data.map(trace =>
      ({date: trace.x.at(-1), value: trace.y.at(-1)})));
  expect(endpoints).toEqual([first, second].map(p => ({date: p.target_date, value: p.estimate})));
  await xlsx(page, "Excel de la comparación");
  await page.getByLabel("Incluir trayectorias en Excel", {exact: true}).check();
  await xlsx(page, "Descargar Excel");
  await page.setViewportSize({width: 390, height: 844});
  await accessible(page);
});
