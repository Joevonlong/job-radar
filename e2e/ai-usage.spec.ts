import fs from "node:fs";

import { expect, test, type Page } from "./fixtures";

/**
 * /sources/ai-usage on the seeded e2e database (src/lib/db/seed.ts: eight ai_usage rows). Other specs may write `probe` rows
 * in parallel, so every assertion goes through the `task` / `provider` filters of the seeded calls. The UI is Chinese by default.
 */
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

test("the sources sub-navigation leads to the page; the range lives in the URL", async ({ page }) => {
  await open(page, "/sources");
  await page.getByTestId("sources-subnav").getByRole("link", { name: "AI 用量" }).click();
  await expect(page).toHaveURL(/\/sources\/ai-usage/);
  await expect(page.getByRole("heading", { level: 1, name: "AI 用量" })).toBeVisible();
  await expect(page.getByTestId("sources-subnav").getByRole("link", { name: "AI 用量" })).toHaveAttribute("aria-current", "location");
  await page.getByTestId("ai-usage-range").locator('[data-range="7d"]').click();
  await expect(page).toHaveURL(/range=7d/);
  await page.reload();
  await expect(page.getByTestId("ai-usage")).toHaveAttribute("data-range", "7d");
});

test("figures under the translate filter match the seeded rows; chips remove filters", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d&task=translate");
  await expect(page.getByTestId("ai-kpi-calls")).toHaveAttribute("data-value", "3");
  await expect(page.getByTestId("ai-kpi-equivalent")).toContainText("$0.0079");
  await expect(page.getByTestId("ai-kpi-actual")).toContainText("$0.0016");
  await expect(page.getByTestId("ai-kpi-unknown-tokens")).toHaveAttribute("data-count", "1");
  const byModel = page.getByTestId("ai-by-model");
  for (const key of ["claude-cli|claude-haiku-4-5", "deepseek|deepseek-v4-flash", "codex-cli|gpt-6.1-sol"]) {
    await expect(byModel.locator(`[data-key="${key}"]`)).toHaveCount(1);
  }
  const chip = page.getByTestId("ai-usage-filter");
  await expect(chip).toContainText("任务：翻译");
  await chip.click();
  await expect(page).not.toHaveURL(/task=/);
});

test("a click on a provider row filters the whole page; the job link opens the job", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d");
  await page.getByTestId("ai-by-provider").locator('[data-key="deepseek"]').getByTestId("ai-breakdown-link").click();
  await expect(page).toHaveURL(/provider=deepseek/);
  const rows = page.getByTestId("ai-call-row");
  await expect(rows.first()).toHaveAttribute("data-provider", "deepseek");
  expect(await rows.evaluateAll((els) => els.every((e) => e.getAttribute("data-provider") === "deepseek"))).toBe(true);
  const link = rows.first().getByTestId("ai-call-job");
  await expect(link).toHaveAttribute("href", /^\/jobs\/\d+$/);
  await link.click();
  await expect(page).toHaveURL(/\/jobs\/\d+/);
});

test("a failed call says why and has unknown tokens; an invalid-output call is listed", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d&provider=codex-cli");
  const failed = page.locator('[data-testid="ai-call-row"][data-outcome="failed"]').first();
  await expect(failed).toContainText("超时");
  await expect(failed.getByTestId("ai-call-input").locator("[data-unknown]")).toBeVisible();
  await expect(page.locator('[data-testid="ai-call-row"][data-outcome="invalid_output"]').first()).toBeVisible();
});

test("an invalid custom range falls back to the default with a hint", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=custom&from=2020-01-01&to=2019-01-01");
  await expect(page.getByTestId("ai-usage-invalid")).toContainText("日期范围无效");
  await expect(page.getByTestId("ai-usage")).toHaveAttribute("data-range", "30d");
});

test("the custom range picker applies two dates and keeps them in the URL", async ({ page }) => {
  await open(page, "/sources/ai-usage");
  await page.getByTestId("ai-usage-range").locator('[data-range="custom"]').click();
  await page.getByTestId("ai-usage-from").fill("2026-01-01");
  await page.getByTestId("ai-usage-to").fill("2026-01-31");
  await page.getByTestId("ai-usage-apply").click();
  await expect(page).toHaveURL(/range=custom&from=2026-01-01&to=2026-01-31/);
  await expect(page.getByTestId("ai-usage-window")).toContainText("2026-01-01");
});

test("the metric switch changes the chart and the URL", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d");
  await expect(page.getByTestId("ai-daily-chart")).toHaveAttribute("data-metric", "tokens");
  await page.getByTestId("ai-usage-metric").locator('[data-metric="calls"]').click();
  await expect(page).toHaveURL(/metric=calls/);
  await expect(page.getByTestId("ai-daily-chart")).toHaveAttribute("data-metric", "calls");
});

test("export CSV downloads the calls of the current filters", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d&task=translate");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("ai-usage-export").click()]);
  expect(download.suggestedFilename()).toMatch(/^ai-usage-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  const path = await download.path();
  const text = fs.readFileSync(path, "utf8");
  expect(text.startsWith("﻿at,task,provider,model")).toBe(true);
  expect(text.trim().split("\r\n")).toHaveLength(1 + 3);
});

test("English, terminal theme, phone: no sideways scroll and stacked tables", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ["/sources/ai-usage?range=30d", "/sources/ai-usage?range=custom&from=2026-01-01&to=2026-01-31", "/sources/ai-usage?range=today"]) {
    await open(page, url);
    await expect(page.getByRole("heading", { level: 1, name: "AI usage" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), url).toBeLessThanOrEqual(0);
  }
  await open(page, "/sources/ai-usage?range=30d&task=translate");
  await expect(page.getByTestId("ai-call-row").first().locator("td[data-label]").first()).toHaveAttribute("data-label", "Time");
  await expect(page.getByTestId("ai-call-row").first().locator('td[data-label="In / cached"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the desktop width fits too, in both themes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/sources/ai-usage?range=30d");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the custom range starts from the window the page shows, not from a made-up week", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d");
  const window30 = (await page.getByTestId("ai-usage-window").textContent()) ?? "";
  const [from, to] = window30.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  await page.getByTestId("ai-usage-range").locator('[data-range="custom"]').click();
  await expect(page.getByTestId("ai-usage-from")).toHaveValue(from ?? "");
  await expect(page.getByTestId("ai-usage-to")).toHaveValue(to ?? "");
});

test("axis ticks are whole numbers; money is written with a plain $ on both pages", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d&task=signals");
  const ticks = await page.getByTestId("ai-daily-chart-plot").locator(".ins-chart__y span").allTextContents();
  for (const tick of ticks) expect(tick, tick).toMatch(/^[\d.,]+[KM]?$/);
  expect(ticks.every((tick) => !/\.\d{2,}/.test(tick))).toBe(true);
  expect(await page.locator("body").innerText()).not.toContain("US$");
  await open(page, "/sources");
  expect(await page.getByTestId("ai-usage-card").innerText()).not.toContain("US$");
});

test("old rows without a cached-token count say unknown, not 0", async ({ page }) => {
  await open(page, "/sources/ai-usage?range=30d");
  await expect(page.getByTestId("ai-kpi-tokens")).toContainText("未知");
  await expect(page.getByTestId("ai-kpi-tokens")).not.toContainText("缓存 0");
});
