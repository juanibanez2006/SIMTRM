import { test, expect, type Locator, type Page } from "@playwright/test";

async function range(plot: Locator) {
  return plot.evaluate((element) => {
    const gd = element as unknown as { layout: { xaxis: { range: string[] } } };
    return gd.layout.xaxis.range.map((value) => Date.parse(value));
  });
}
const width = async (plot: Locator) => {
  const [a, b] = await range(plot);
  return b - a;
};
async function openHistory(page: Page) {
  await page.goto("/");
  const plot = page.locator(".temporal-chart").first();
  await expect(plot.locator(".main-svg").first()).toBeVisible();
  await plot.locator(".nsewdrag").scrollIntoViewIfNeeded();
  return plot;
}

test("rueda protegida, arrastre horizontal, selección y vista persistente", async ({
  page,
}) => {
  await page.clock.install();
  let changed = false;
  await page.route("**/api/v1/data/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    if (changed) status.dataset_fingerprint += ":isolated-interaction-test";
    await route.fulfill({ response, json: status });
  });
  const plot = await openHistory(page);
  const original = await width(plot);
  let box = (await plot.locator(".nsewdrag").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scroll = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scroll);
  expect(await width(plot)).toBe(original);
  await plot.locator(".nsewdrag").scrollIntoViewIfNeeded();
  box = (await plot.locator(".nsewdrag").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -250);
  await page.keyboard.up("Control");
  await expect.poll(() => width(plot)).toBeLessThan(original * 0.9);
  const beforePan = await range(plot);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(async () => (await range(plot))[0]).not.toBe(beforePan[0]);
  const zoomed = await range(plot);
  changed = true;
  const refreshed = page.waitForResponse((response) =>
    response.url().includes("/trm/series?"),
  );
  await page.clock.fastForward(60_000);
  await refreshed;
  await expect.poll(() => range(plot)).toEqual(zoomed);
  await page
    .getByRole("button", { name: "Restablecer vista", exact: true })
    .first()
    .click();
  await expect.poll(() => width(plot)).toBeGreaterThan(original * 0.99);
  const position = await plot.evaluate((element) => {
    const gd = element as unknown as {
      data: { x: string[]; y: number[] }[];
      layout: { xaxis: { range: string[] }; yaxis: { range: number[] } };
    };
    const index = Math.floor(gd.data[0].x.length * 0.6);
    const rect = element.querySelector(".nsewdrag")!.getBoundingClientRect();
    const [a, b] = gd.layout.xaxis.range.map((value) => Date.parse(value)),
      [lo, hi] = gd.layout.yaxis.range;
    return {
      x:
        rect.left +
        ((Date.parse(gd.data[0].x[index]) - a) / (b - a)) * rect.width,
      y: rect.bottom - ((gd.data[0].y[index] - lo) / (hi - lo)) * rect.height,
    };
  });
  await page.mouse.move(position.x, position.y);
  await expect(plot.locator(".hoverlayer")).not.toBeEmpty();
  await page.mouse.click(position.x, position.y);
  await expect(page.locator(".point-inspector")).toContainText("Vigencia:");
  await expect(page.locator(".point-inspector")).toContainText(
    "Anterior comparable",
  );
  const selected = await page.getByLabel("Observación histórica").inputValue();
  await page.getByLabel("Observación histórica").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByLabel("Observación histórica")).toHaveValue(String(Number(selected) - 1));
  await expect(page.locator(".point-inspector")).toContainText("Vigencia:");
});

test("periodos rápidos actualizan cálculos y transfieren fechas a otros módulos", async ({
  page,
}) => {
  await openHistory(page);
  const result = page.waitForResponse((response) =>
    response.url().includes("/trm/series?start="),
  );
  await page.getByRole("button", { name: "3 meses", exact: true }).click();
  const response = await result;
  const data = await response.json();
  const parameters = new URL(response.url()).searchParams;
  await expect(page.locator(".chart-panel .section-heading p").first()).toContainText("Desde");
  await expect(page.locator(".chart-panel .section-heading p").first()).not.toContainText("Todo el histórico");
  await expect(page.getByLabel("Desde", { exact: true })).toHaveValue(
    parameters.get("start")!,
  );
  await expect(page.getByLabel(/^Año/).filter({ visible: true })).toHaveValue("");
  await expect(page.locator(".metric-grid .metric strong").first()).toHaveText(
    new Intl.NumberFormat("es-CO", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(data.mean)),
  );
  await page
    .getByRole("button", { name: "Simular con este periodo", exact: true })
    .click();
  await expect(
    page.getByLabel("Inicio del entrenamiento", { exact: true }),
  ).toHaveValue(parameters.get("start")!);
  await expect(
    page.getByLabel("Fin del entrenamiento", { exact: true }),
  ).toHaveValue(parameters.get("end")!);
  await expect(
    page.getByRole("heading", { name: "Resultado del experimento" }),
  ).toHaveCount(0);
});

test.describe("gestos táctiles", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  for (const viewportWidth of [390, 768]) {
    test(`pinza, arrastre horizontal, toque y desplazamiento vertical a ${viewportWidth}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewportWidth, height: 1024 });
      const plot = await openHistory(page);
      const session = await page.context().newCDPSession(page);
      const box = (await plot.locator(".nsewdrag").boundingBox())!;
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      const send = (
        type: "touchStart" | "touchMove" | "touchEnd",
        points: { x: number; y: number; id: number }[],
      ) =>
        session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      const original = await width(plot);
      await send("touchStart", [
        { x: x - 25, y, id: 0 },
        { x: x + 25, y, id: 1 },
      ]);
      await send("touchMove", [
        { x: x - 55, y, id: 0 },
        { x: x + 55, y, id: 1 },
      ]);
      await send("touchEnd", []);
      await expect.poll(() => width(plot)).toBeLessThan(original * 0.7);
      const enlarged = await width(plot);
      await send("touchStart", [
        { x: x - 55, y, id: 0 },
        { x: x + 55, y, id: 1 },
      ]);
      await send("touchMove", [
        { x: x - 25, y, id: 0 },
        { x: x + 25, y, id: 1 },
      ]);
      await send("touchEnd", []);
      await expect.poll(() => width(plot)).toBeGreaterThan(enlarged * 1.5);
      const beforePan = await range(plot);
      await send("touchStart", [{ x, y, id: 0 }]);
      await send("touchMove", [{ x: x + 35, y, id: 0 }]);
      await send("touchEnd", []);
      await expect
        .poll(async () => (await range(plot))[0])
        .not.toBe(beforePan[0]);
      await page.touchscreen.tap(x, y);
      await expect(page.locator(".point-inspector")).toContainText("Vigencia:");
      const scroll = await page.evaluate(() => scrollY);
      await send("touchStart", [{ x, y, id: 0 }]);
      for (const delta of [15, 35, 70, 100])
        await send("touchMove", [{ x, y: y - delta, id: 0 }]);
      await send("touchEnd", []);
      await expect
        .poll(() => page.evaluate(() => scrollY))
        .toBeGreaterThan(scroll);
      await session.detach();
    });
  }
});
