import { test, expect } from "@playwright/test";

test("el zoom temporal conserva el experimento y las tablas", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Calcular proyección", exact: true })
    .click();
  const chart = page.locator(".projection-page .temporal-chart").first();
  await expect(chart.locator(".main-svg").first()).toBeVisible();
  const before = await page.locator(".requested-projection").textContent();
  const original = await chart.evaluate(
    (element) =>
      (element as unknown as { layout: { xaxis: { range: string[] } } }).layout
        .xaxis.range,
  );
  await page
    .getByRole("button", { name: "Ampliar vista", exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      chart.evaluate(
        (element) =>
          (element as unknown as { layout: { xaxis: { range: string[] } } })
            .layout.xaxis.range,
      ),
    )
    .not.toEqual(original);
  expect(await page.locator(".requested-projection").textContent()).toBe(
    before,
  );
  await page
    .getByRole("button", { name: "Restablecer vista", exact: true })
    .first()
    .click();
  expect(await page.locator(".requested-projection").textContent()).toBe(
    before,
  );
});

test.describe("gestos táctiles de la proyección", () => {
  test.use({ hasTouch: true });
  test("amplía y consulta sin modificar la proyección", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Calcular proyección", exact: true })
      .click();
    const chart = page.locator(".projection-page .temporal-chart").first();
    await expect(chart.locator(".main-svg").first()).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const before = await page.locator(".projection-result h2").textContent();
    const box = (await chart.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    expect(await page.locator(".projection-result h2").textContent()).toBe(
      before,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  });
});
