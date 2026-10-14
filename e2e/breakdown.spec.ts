import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";

/**
 * The job breakdown card on the seeded e2e database. "Forward Deployed Engineer" (Quillfeather Labs) has a
 * fictional stored breakdown; "LLM Engineer" (Brumbach Analytics) has none. breakdown.yaml of the e2e config copy is
 * switched on by scripts/e2e-prepare.ts; the e2e runner stands in for the ai-worker and answers `breakdown_job` with a
 * one-item breakdown.
 */

async function openJob(page: Page, name: RegExp) {
  await page.goto("/jobs");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
}

const panel = (page: Page) => page.getByTestId("jd-breakdown-panel");

test.describe("breakdown card", () => {
  test("a stored breakdown shows its groups, and a tag jumps to the highlighted JD sentence", async ({ page }) => {
    await openJob(page, /Forward Deployed Engineer/);
    await expect(panel(page)).toHaveAttribute("data-state", "done");
    await expect(panel(page).getByText("技术栈", { exact: true })).toBeVisible();
    const tech = page.getByTestId("jd-breakdown-tech");
    await expect(tech.getByText("编程语言")).toBeVisible();
    await expect(tech.getByText("Python")).toBeVisible();
    await expect(page.getByTestId("jd-breakdown-meta")).toContainText("seed · seed · breakdown-v1");
    await tech.getByRole("button", { name: /Kubernetes|Python/ }).first().click();
    const mark = page.locator("mark[data-tier='breakdown']").filter({ hasText: "Our stack" });
    await expect(mark).toBeVisible();
    await expect(mark).toContainText("Our stack");
    await expect(mark).toHaveClass(/jr-flash/);
    // the legend names the new mark
    await expect(page.getByTestId("jd-legend-breakdown")).toBeVisible();
  });

  test("reloading while the request is queued never falls back to the ready card", async ({ page }) => {
    await openJob(page, /Senior Backend Engineer/);
    if ((await panel(page).getAttribute("data-state")) !== "ready") test.skip(true, "this seeded job already has a breakdown");
    await page.getByTestId("jd-breakdown-button").click();
    await expect(panel(page)).toHaveAttribute("data-state", "waiting");
    await page.reload();
    // the stub answers after 0.8 s: the card is waiting (or already done), but never "ready" again
    await expect(panel(page)).not.toHaveAttribute("data-state", "ready");
    await expect(panel(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
  });

  test("a job without a breakdown: click, waiting, then the stubbed result", async ({ page }) => {
    await openJob(page, /LLM Engineer/);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await page.getByTestId("jd-breakdown-button").click();
    await expect(panel(page)).toHaveAttribute("data-state", "waiting");
    await expect(page.getByTestId("jd-breakdown-loading")).toBeVisible();
    await expect(panel(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(panel(page)).toContainText("（e2e）阅读并拆解 JD");
    await expect(page.getByTestId("jd-breakdown-meta")).toContainText("e2e · e2e-model");
    // it survives a reload
    await page.reload();
    await expect(panel(page)).toHaveAttribute("data-state", "done");
  });
});

test.describe("English and light theme", () => {
  test("renders the card in English", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    await openJob(page, /Forward Deployed Engineer/);
    await expect(page.getByRole("heading", { name: "Job breakdown" })).toBeVisible();
    await expect(page.getByTestId("jd-breakdown-tech").getByText("Languages", { exact: true })).toBeVisible();
    await expect(page.locator("section", { has: page.locator("#h-breakdown") }).getByTestId("language-tag")).toBeVisible();
  });
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the card does not scroll horizontally", async ({ page }) => {
    for (const name of [/Forward Deployed Engineer/, /LLM Engineer/]) {
      await openJob(page, name);
      await expect(panel(page)).toBeVisible();
      const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(widths[0]).toBeLessThanOrEqual(widths[1] ?? 390);
    }
  });
});

test.describe("settings tab", () => {
  test("the breakdown tab saves the mode and keeps the comments", async ({ page }) => {
    await page.goto("/settings?tab=breakdown");
    await expect(page.getByTestId("tab-breakdown")).toBeVisible();
    const configDir = process.env.E2E_CONFIG_DIR;
    const file = configDir ? path.join(configDir, "breakdown.yaml") : null;
    const mode = page.getByRole("combobox", { name: /^方式$|^Mode$/ });
    await expect(mode).toBeVisible();
    // the options read as words, not as the raw yaml values
    await expect(mode.locator("option")).toHaveText([/^手动（|^Manual \(/, /^自动（|^Automatic \(/]);
    await mode.selectOption("auto");
    await page.getByRole("button", { name: /^保存$|^Save$/ }).first().click();
    await expect(page.getByText(/已保存|Saved/).first()).toBeVisible();
    if (file) {
      await expect.poll(() => fs.readFileSync(file, "utf8")).toMatch(/^mode: auto/m);
      expect(fs.readFileSync(file, "utf8")).toContain("# 总开关");
    }
    // back to manual so the other tests see the shipped behaviour
    await mode.selectOption("manual");
    await page.getByRole("button", { name: /^保存$|^Save$/ }).first().click();
    if (file) await expect.poll(() => fs.readFileSync(file, "utf8")).toMatch(/^mode: manual/m);
  });
});
