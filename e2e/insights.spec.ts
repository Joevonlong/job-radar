import { expect, test, type Page } from "@playwright/test";

import { EXCLUSIVE_TAG } from "./projects";

/** /insights on the seeded e2e database (see src/lib/db/seed.ts). The UI is Chinese and paper (light) by default. */
async function open(page: Page, path = "/insights") {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

// The tests marked EXCLUSIVE compare a number of this page with the count of /jobs a moment later; other specs add,
// ignore and close jobs while the parallel project runs, so these run one at a time after it (see e2e/projects.ts).
const EXCLUSIVE = { tag: EXCLUSIVE_TAG };

const CARDS = ["card-daily", "card-conversion", "card-pass-rate", "card-disclosure", "card-salary", "card-sources", "card-cities", "card-scores", "card-signals", "card-funnel", "card-filters"];

test("the page shows the headline numbers and every card", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1, name: "统计" })).toBeVisible();
  await expect(page.getByTestId("insights")).toHaveAttribute("data-range", "30");
  await expect(page.getByTestId("kpi-strip")).toBeVisible();
  for (const card of CARDS) await expect(page.getByTestId(card)).toBeVisible();
  await expect(page.getByTestId("daily-chart").getByRole("listitem")).toHaveCount(30);
  await expect(page.getByTestId("scores-chart").getByRole("listitem")).toHaveCount(21);
});

test("the range switch is URL state", async ({ page }) => {
  await open(page);
  await page.getByTestId("range-switch").getByRole("radio", { name: "7 天" }).click();
  await expect(page).toHaveURL(/\/insights\?range=7$/);
  await expect(page.getByTestId("insights")).toHaveAttribute("data-range", "7");
  await expect(page.getByTestId("daily-chart").getByRole("listitem")).toHaveCount(7);
  await expect(page.getByTestId("range-switch").getByRole("radio", { name: "7 天" })).toBeChecked();

  await page.reload();
  await expect(page.getByTestId("insights")).toHaveAttribute("data-range", "7");

  await page.goto("/insights?range=90");
  await expect(page.getByTestId("daily-chart").getByRole("listitem")).toHaveCount(90);
  // a range the config does not offer falls back to the default
  await page.goto("/insights?range=5");
  await expect(page.getByTestId("insights")).toHaveAttribute("data-range", "30");
});

test("a headline number opens /jobs with the same count", EXCLUSIVE, async ({ page }) => {
  await open(page);
  // the pass rate is the number; the count of passed jobs is the link under it
  const shown = Number((await page.getByTestId("kpi-passed-count").innerText()).match(/\d[\d,]*/)?.[0].replace(/\D/g, ""));
  expect(shown).toBeGreaterThan(0);
  await page.getByTestId("kpi-passed-count").click();
  await expect(page).toHaveURL(/\/jobs\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&status=active&status=possibly_closed&status=closed$/);
  await expect(page.getByTestId("result-count")).toContainText(String(shown));
});

test("a source count opens /jobs with the same count", EXCLUSIVE, async ({ page }) => {
  await open(page);
  const first = page.getByTestId("sources-list").getByRole("listitem").first();
  const total = Number((await first.getByRole("link").first().innerText()).replace(/\D/g, ""));
  await first.getByRole("link").first().click();
  await expect(page).toHaveURL(/source=/);
  await expect(page.getByTestId("result-count")).toContainText(String(total));
});

test("a day's filtered-out count opens /jobs with only those jobs", EXCLUSIVE, async ({ page }) => {
  await open(page);
  const segment = page.getByTestId("daily-chart").locator('a[href*="filteredOnly=true"]').first();
  const label = (await segment.getAttribute("aria-label")) ?? "";
  const count = Number(label.match(/(\d+)\s*$/)?.[1]);
  expect(count).toBeGreaterThan(0);
  await segment.click();
  await expect(page).toHaveURL(/filteredOnly=true/);
  await expect(page.getByTestId("toggle-filtered-only")).toBeVisible();
  await expect(page.getByTestId("result-count")).toContainText(String(count));
});

test("English, terminal theme and a phone viewport: no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const range of [7, 30, 90]) {
    await open(page, `/insights?range=${range}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `range ${range} zh paper`).toBeLessThanOrEqual(0);
  }
  await page.getByRole("button", { name: "切换深浅主题" }).click();
  await page.getByRole("button", { name: "切换语言" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await open(page, "/insights?range=90");
  await expect(page.getByRole("heading", { level: 1, name: "Insights" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a desktop viewport fits too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("changing the range rolls the headline numbers and replays the charts", async ({ page }) => {
  await open(page);
  const before = Number(await page.getByTestId("kpi-new-value").locator("[data-value]").getAttribute("data-value"));
  await page.getByTestId("range-switch").getByRole("radio", { name: "90 天" }).click();
  await expect(page.getByTestId("insights")).toHaveAttribute("data-range", "90");
  // the number is the one of the new range (never a half-way value once the roll is over) and the charts are drawn again
  await expect(page.getByTestId("daily-chart").getByRole("listitem")).toHaveCount(90);
  const after = Number(await page.getByTestId("kpi-new-value").locator("[data-value]").getAttribute("data-value"));
  expect(after).toBeGreaterThanOrEqual(before);
  await expect(page.getByTestId("card-conversion").getByRole("group")).toBeVisible();
});

test("a chart column shows its values on hover", async ({ page }) => {
  await open(page);
  const column = page.getByTestId("daily-chart").getByRole("listitem").last();
  await expect(column).toHaveAttribute("data-tip", /通过 \d+，被过滤 \d+/);
  await column.hover();
  await expect(column).toBeVisible();
});

test("reduced motion shows the final state at once", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await open(page);
  await expect(page.getByTestId("card-pass-rate").locator('[data-played="true"]').first()).toBeVisible();
  await context.close();
});
