import { expect, test, type Page } from "./fixtures";

/**
 * The company background on the seeded e2e database. research.yaml of the e2e config copy is switched on by
 * scripts/e2e-prepare.ts; the e2e runner runs the real handler with a stand-in AI, so nothing goes out to the web. The
 * stand-in's answer has one field with an http source, which the check must drop.
 */

async function openJob(page: Page, name: RegExp) {
  await page.goto("/jobs");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
}

const panel = (page: Page) => page.getByTestId("company-research-panel");

test.describe("company background", () => {
  test("before a lookup the panel says what it would send", async ({ page }) => {
    await openJob(page, /Forward Deployed Engineer/);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("company-research-ready")).toContainText(/Quillfeather/);
    await expect(page.getByTestId("company-research-quota")).toBeVisible();
  });

  test("a manual lookup shows the checked fields with sources, marked as unverified", async ({ page }) => {
    await openJob(page, /LLM Engineer/);
    await expect(page.getByTestId("company-research-badge")).toBeVisible();
    // a retry finds the result of its first attempt: it looks up again
    await page.getByTestId("company-research-button").or(page.getByTestId("company-research-refresh")).click();
    await expect(page.getByTestId("company-research-field-summary")).toBeVisible({ timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });

    await expect(page.getByTestId("company-research-field-summary")).toContainText("Builds analytics software");
    await expect(page.getByTestId("company-research-field-recentNews")).toContainText("Opened a second office");
    // the http source took its field with it, and the panel says a field was dropped
    await expect(page.getByTestId("company-research-field-funding")).toHaveCount(0);
    await expect(page.getByTestId("company-research-dropped")).toBeVisible();

    const source = page.getByTestId("company-research-field-summary").getByTestId("company-research-source");
    await expect(source).toHaveAttribute("href", "https://www.example-analytics.de/about");
    await expect(source).toHaveAttribute("target", "_blank");
    await expect(source).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByTestId("company-research-meta")).toContainText("e2e-model");
    await expect(page.getByTestId("company-research-sent")).toBeVisible();

    await page.reload();
    await expect(panel(page)).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("company-research-field-summary")).toContainText("Builds analytics software");
    await expect(page.getByTestId("company-research-refresh")).toBeEnabled();
  });

  test("the panel fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openJob(page, /LLM Engineer/);
    await expect(panel(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("research settings", () => {
  test("the tab shows the switch and the limits", async ({ page }) => {
    await page.goto("/settings?tab=research");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("tab", { name: /Research|调研/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").getByText(/company name|公司名/).first()).toBeVisible();
  });
});
