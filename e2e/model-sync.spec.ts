import { expect, test } from "./fixtures";

/**
 * "Refresh available models" on the OpenRouter card of the AI tab. The stand-in runner answers the `models_sync` request with a fixed
 * list (scripts/e2e-runner.ts); nothing is added here, so the shared models.yaml is left alone.
 */
test.describe.configure({ mode: "serial" });

// The same request is refused for min_interval_seconds after it finished, so each viewport asks with words of its own
for (const viewport of [{ width: 1280, height: 800, all: "e2e", narrow: "fresh" }, { width: 390, height: 844, all: "e2e/", narrow: "fresh-" }]) {
  test(`refresh shows the list, the filter narrows it and only addable models can be ticked (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings?tab=ai");
    await page.waitForLoadState("networkidle");
    const panel = page.getByTestId("model-sync-openrouter");
    await expect(panel).toHaveAttribute("data-state", "idle");
    await expect(page.getByTestId("model-sync-result")).toHaveCount(0);

    await panel.getByTestId("model-sync-filter").fill(viewport.all);
    await panel.getByTestId("model-sync-button").click();
    await expect(panel).toHaveAttribute("data-state", "done", { timeout: 20_000 });
    const rows = panel.getByTestId("model-sync-row");
    await expect(rows).toHaveCount(3);
    await expect(panel.locator('[data-model="e2e/fresh-model"]')).toHaveAttribute("data-addable", "1");
    await expect(panel.locator('[data-model="e2e/no-json"]')).toHaveAttribute("data-addable", "0");
    await expect(panel.locator('[data-model="e2e/maybe-json"]')).toHaveAttribute("data-addable", "0");
    await expect(panel.getByTestId("model-sync-add")).toBeDisabled();

    // only a model that can be added has a checkbox that works
    await panel.locator('[data-model="e2e/fresh-model"]').getByRole("checkbox").check();
    await expect(panel.getByTestId("model-sync-add")).toBeEnabled();
    await expect(panel.locator('[data-model="e2e/no-json"]').getByRole("checkbox")).toBeDisabled();

    // E2E_SHOTS=<dir>: keep pictures of the result for a visual check, light and dark
    const shots = process.env.E2E_SHOTS;
    if (shots) {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await panel.screenshot({ path: `${shots}/model-sync-${viewport.width}-${scheme}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }

    // a narrower filter asks again and shows fewer rows
    await panel.getByTestId("model-sync-filter").fill(viewport.narrow);
    await panel.getByTestId("model-sync-button").click();
    await expect(panel).toHaveAttribute("data-state", "done", { timeout: 20_000 });
    await expect(rows).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
