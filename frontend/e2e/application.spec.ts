import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Simulation, Backtest } from "../src/types";

const pages = [
  "Vista general",
  "Histórico de TRM",
  "Análisis estadístico",
  "Comparar periodos",
  "Simulador",
  "Validación retrospectiva",
  "Exportaciones",
  "Calidad de datos",
  "Metodología y fuentes",
];

const externalRequests = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const requests: string[] = [];
  externalRequests.set(page, requests);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname !== "127.0.0.1"
    )
      requests.push(url.origin);
  });
  // All tested flows must work with the validated local history alone.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) =>
    route.abort(),
  );
});
test.afterEach(async ({ page }) => {
  expect(externalRequests.get(page)).toEqual([]);
});

test("refresca estado local y vigencia al cambiar el día sin perder filtros", async ({
  page,
  request,
}) => {
  const latest = await (await request.get("/api/v1/trm/latest")).json();
  const years = (await (
    await request.get("/api/v1/trm/years")
  ).json()) as number[];
  await page.clock.install({
    time: new Date(`${latest.record.valid_to}T23:59:30-05:00`),
  });
  let changed = false;
  await page.route("**/api/v1/data/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    if (changed) {
      // Isolated metadata failure/version double; historical records stay real and unchanged.
      status.dataset_fingerprint += ":synthetic-refresh-test";
      status.state = "source_error";
    }
    await route.fulfill({ response, json: status });
  });
  await page.goto("/");
  await expect(page.getByText("Vigente hoy", { exact: true })).toBeVisible();
  await page.getByLabel(/^Año/).selectOption(String(years[1] ?? years[0]));
  await expect(page.locator(".js-plotly-plot .main-svg").first()).toBeVisible();
  const update = page.waitForResponse((response) =>
    response.url().includes(`/trm/series?year=${years[1] ?? years[0]}`),
  );
  changed = true;
  await page.clock.fastForward(60_000);
  await update;
  await expect(
    page.getByText("Último dato · desactualizado", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Año/)).toHaveValue(
    String(years[1] ?? years[0]),
  );
  await expect(page.locator(".update-warning")).toContainText(
    "Se conserva el último histórico local validado",
  );
  await expect(page.locator(".js-plotly-plot .main-svg").first()).toBeVisible();
  await expect(page.locator(".latest-card .price")).not.toContainText("—");
});

async function navigate(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    page.getByRole("navigation").getByRole("button", { name, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator("h1")).toBeFocused();
}

async function accessible(page: Page) {
  await expect(page.locator(".loading")).toHaveCount(0);
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
  ).toEqual([]);
}

async function xlsx(page: Page, button: string) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^SIMTRM_.*\.xlsx$/);
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  if (!stream) throw new Error("No se recibió el contenido de Excel");
  let size = 0;
  let signature: number[] = [];
  for await (const chunk of stream) {
    if (!size) signature = [...new Uint8Array(chunk as Uint8Array).slice(0, 4)];
    size += (chunk as Uint8Array).length;
  }
  expect(signature).toEqual([80, 75, 3, 4]);
  expect(size).toBeGreaterThan(1000);
}

test("histórico real: filtros, paginación eficiente y descarga Excel", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const years = (await (
    await request.get("/api/v1/trm/years")
  ).json()) as number[];
  let seriesCalls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/trm/series?")) seriesCalls++;
  });
  await page.goto("/");
  await expect(page.locator(".js-plotly-plot .main-svg").first()).toBeVisible();
  await page.getByLabel(/^Año/).selectOption(String(years[1] ?? years[0]));
  await expect(page.locator(".pagination")).toContainText("Página 1");
  const callsBefore = seriesCalls;
  await page
    .locator(".js-plotly-plot")
    .evaluate((element) => element.setAttribute("data-retained", "true"));
  await page.getByRole("button", { name: "Siguiente →", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("Página 2");
  expect(seriesCalls).toBe(callsBefore);
  await expect(
    page.locator('.js-plotly-plot[data-retained="true"]'),
  ).toHaveCount(1);
  await xlsx(page, "Excel del histórico seleccionado");
  await accessible(page);
  expect(errors).toEqual([]);
});

test("navegación por teclado, historial y recuperación del backend", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Ir al contenido" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await navigate(page, "Metodología y fuentes");
  await navigate(page, "Calidad de datos");
  await page.goBack();
  await expect(page).toHaveURL(/#method$/);
  await expect(page.locator("h1")).toHaveText("Metodología y fuentes");
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Metodología y fuentes");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page).toHaveURL(/#method$/);
  await page.route("**/api/v1/trm/series?**", (route) =>
    route.abort("connectionrefused"),
  );
  await navigate(page, "Histórico de TRM");
  await expect(page.getByRole("alert")).toContainText(
    "Compruebe que el backend esté iniciado",
  );
  await page.unroute("**/api/v1/trm/series?**");
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  await expect(page.locator(".js-plotly-plot .main-svg").first()).toBeVisible();
});

test("todos los módulos: accesibilidad y diseño a 1280, 768, 390 y 320 píxeles", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.locator(".js-plotly-plot .main-svg").first(),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`inicio-${width}.png`),
      fullPage: true,
    });
    for (const name of pages) {
      if (name !== "Vista general") await navigate(page, name);
      await expect(page.locator(".loading")).toHaveCount(0);
      if (width !== 320) await accessible(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${name}, ${width}px: desbordamiento horizontal`,
      ).toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath(`metodologia-${width}.png`),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test("Montecarlo y bootstrap: semilla, reproducción, gráficos y Excel", async ({
  page,
  request,
}) => {
  const years = (await (
    await request.get("/api/v1/trm/years")
  ).json()) as number[];
  const year = years[1] ?? years[0];
  await page.goto("/#simulation");
  await page
    .getByLabel("Inicio del entrenamiento", { exact: true })
    .fill(`${year}-01-01`);
  await page
    .getByLabel("Fin del entrenamiento", { exact: true })
    .fill(`${year}-12-31`);
  await page
    .getByLabel("Fecha de corte", { exact: true })
    .fill(`${year}-12-31`);
  await page.getByLabel("Horizonte en pasos", { exact: true }).fill("5");
  await page.getByLabel("Número de réplicas", { exact: true }).fill("200");
  const run = async () => {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/simulations") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Ejecutar simulación", exact: true })
      .click();
    const result = await response;
    expect(result.status()).toBe(201);
    await expect(
      page.getByRole("heading", {
        name: "Resultado del experimento",
        exact: true,
      }),
    ).toBeVisible();
    return (await result.json()) as Simulation;
  };
  const original = await run();
  expect(original.methods.map((method) => method.method)).toEqual([
    "monte_carlo",
    "bootstrap",
  ]);
  await expect(page.locator(".js-plotly-plot")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Bootstrap histórico", exact: true })
    .click();
  await accessible(page);
  await xlsx(page, "Excel del experimento completo");
  const replayed = page.waitForResponse((response) =>
    response.url().endsWith(`/simulations/${original.id}/replay`),
  );
  await page
    .getByRole("button", { name: "Reproducir desde instantánea", exact: true })
    .click();
  const replay = (await (await replayed).json()) as Simulation;
  expect(replay.numeric_fingerprint).toBe(original.numeric_fingerprint);
  await expect(page.locator(".simulation-message")).toContainText(
    "Reproducción verificada",
  );
  await page.getByLabel("Semilla aleatoria", { exact: true }).fill("2027");
  const changed = await run();
  expect(changed.methods[0].terminal_values).not.toEqual(
    original.methods[0].terminal_values,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await accessible(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("comparación, análisis y validación retrospectiva con datos locales", async ({
  page,
  request,
}) => {
  await page.goto("/#comparison");
  await expect(page.locator(".js-plotly-plot")).toHaveCount(2);
  await xlsx(page, "Excel de la comparación aplicada");
  await navigate(page, "Análisis estadístico");
  await page.getByLabel(/^Variable de análisis/).selectOption("log_return");
  await expect(page.locator(".js-plotly-plot")).toHaveCount(5);
  await xlsx(page, "Excel del análisis estadístico");
  await navigate(page, "Validación retrospectiva");
  await page.getByLabel("Pasos a evaluar", { exact: true }).fill("5");
  await page.getByLabel("Réplicas por modelo", { exact: true }).fill("200");
  const evaluated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/backtests") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", {
      name: "Ejecutar validación retrospectiva",
      exact: true,
    })
    .click();
  const response = await evaluated;
  expect(response.status()).toBe(201);
  const result = (await response.json()) as Backtest;
  expect(result.status).toBe("complete");
  expect(result.evaluated_steps).toBe(5);
  expect(
    result.observations.every((row) => row.date > result.request.cutoff_date),
  ).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Resultado retrospectivo", exact: true }),
  ).toBeVisible();
  await xlsx(page, "Excel de la validación");
  await accessible(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await accessible(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect((await request.get(`/api/v1/backtests/${result.id}`)).ok()).toBe(true);
});
