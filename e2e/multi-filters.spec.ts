import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";
import { expectNoLeavingRows, listRows } from "./list-rows";

/**
 * Multi-select filters of /jobs on the seeded e2e database. Seed facts: today's jobs are in Berlin (4) and
 * München (1, "Machine Learning Engineer, Perception"). The UI is Chinese by default.
 * The file also saves views, so it rewrites interests.yaml of the run and puts the shipped one back (a project of its own
 * runs it after the other specs, see playwright.config.ts).
 */

const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const INTERESTS_FILE = path.join(CONFIG_DIR, "interests.yaml");
const SHIPPED_FILE = path.join(process.env.E2E_DEFAULTS_DIR ?? path.resolve(import.meta.dirname, "../tests/fixtures/config/defaults"), "interests.yaml");
const read = (): string => fs.readFileSync(INTERESTS_FILE, "utf8");

test.describe.configure({ mode: "serial" });
test.beforeAll(() => fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE));
test.afterAll(() => fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE));

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

const resultCount = async (page: Page) => Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
const option = (page: Page, testId: string, value: string) => page.locator(`[data-testid="${testId}-option"][data-value="${value}"]`);

test("pick two cities in the popover: button, URL, list and count follow; a reload keeps them", async ({ page }) => {
  await open(page, "/jobs?city=Berlin");
  const berlin = await resultCount(page);
  await open(page, "/jobs?city=M%C3%BCnchen");
  const munich = await resultCount(page);
  expect(berlin).toBeGreaterThanOrEqual(4);
  expect(munich).toBeGreaterThanOrEqual(1);

  await open(page, "/jobs");
  const all = await resultCount(page);
  await page.getByTestId("filter-city").click();
  await expect(page.getByPlaceholder("搜索城市…")).toBeFocused();
  await option(page, "filter-city", "Berlin").click();
  await option(page, "filter-city", "München").click();
  // the popover stays open while picking; the button already shows both
  await expect(page.getByTestId("filter-city")).toHaveText(/Berlin \+1/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("filter-city")).toBeFocused();

  await expect(page).toHaveURL(/[?&]city=Berlin&city=M(%C3%BC|ü)nchen/);
  await expect.poll(() => resultCount(page)).toBe(berlin + munich);
  expect(berlin + munich).toBeLessThan(all);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);

  await page.reload();
  await expect(page.getByTestId("filter-city")).toHaveText(/Berlin \+1/);
  expect(await resultCount(page)).toBe(berlin + munich);

  // × on a chip removes just that value
  await page.getByRole("button", { name: "移除筛选 城市：Berlin" }).click();
  await expect(page).toHaveURL(/city=M(%C3%BC|ü)nchen/);
  await expect(page).not.toHaveURL(/city=Berlin/);
  await expect.poll(() => resultCount(page)).toBe(munich);
  await expect(page.getByTestId("filter-chip")).toHaveCount(1);

  // the filter bar's clear empties the picks
  await page.getByTestId("filter-clear").click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(0);
  await expect.poll(() => resultCount(page)).toBe(all);
});

test("different filters combine with AND: two cities + remote is within both", async ({ page }) => {
  await open(page, "/jobs?city=Berlin&city=M%C3%BCnchen&workplace=remote");
  const andCount = await resultCount(page);
  await open(page, "/jobs?city=Berlin&city=M%C3%BCnchen");
  expect(andCount).toBeLessThanOrEqual(await resultCount(page));
  await open(page, "/jobs?workplace=remote");
  expect(andCount).toBeLessThanOrEqual(await resultCount(page));
});

test("old single-value links keep working: ?city=Berlin shows one selected city", async ({ page }) => {
  await open(page, "/jobs?city=Berlin");
  await expect(page.getByTestId("filter-city")).toHaveText("Berlin");
  await expect(page.getByTestId("filter-chip")).toHaveCount(1);
});

test("keyboard only: open with Enter, type to search, Enter ticks, Esc closes and keeps the focus", async ({ page }) => {
  await open(page, "/jobs");
  await page.getByTestId("filter-city").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("搜索城市…")).toBeFocused();
  await page.keyboard.type("munc");
  await expect(page.getByTestId("filter-city-option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(option(page, "filter-city", "München")).toHaveAttribute("aria-checked", "true");
  // j / k / x belong to the list; inside the popover they are not shortcuts
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("filter-city")).toBeFocused();
  await expect(page).toHaveURL(/city=M(%C3%BC|ü)nchen/);
  await expect(page.locator("[data-job-id]:focus")).toHaveCount(0);
  // ArrowDown opens it again
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("filter-city")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.type("jk");
  await expect(page.getByPlaceholder("搜索城市…")).toHaveValue("jk");
  await expect(page.locator("[data-job-id]:focus")).toHaveCount(0);
});

test("save a two-city view: the file holds a list, Today has a tab with the same count, /interests names both cities", async ({ page }) => {
  await open(page, "/jobs?city=Berlin&city=M%C3%BCnchen");
  const expected = await resultCount(page);
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("两个城市");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByText("已保存视图「两个城市」")).toBeVisible();
  await expect.poll(read).toContain("两个城市");
  expect(read()).toMatch(/city:\s*\n\s+- Berlin\n\s+- München\n/);
  expect(read()).toContain("# 保存的筛选视图");

  // a single value still writes a scalar, as before
  await open(page, "/jobs?city=M%C3%BCnchen");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("只有慕尼黑");
  await page.getByTestId("save-view-submit").click();
  await expect.poll(read).toContain("只有慕尼黑");
  expect(read()).toMatch(/city: München\n/);

  await open(page, "/");
  const tab = page.getByTestId("view-tabs").getByRole("radio", { name: /两个城市/ });
  await tab.click();
  await expect(page).toHaveURL(/view=/);
  const rows = listRows(page);
  // the tab's number and the list agree (Berlin 4 + München 1 in the seed)
  const shown = Number(((await tab.textContent()) ?? "").replace(/\D/g, ""));
  expect(shown).toBeGreaterThanOrEqual(5);
  await expect(rows).toHaveCount(shown);
  // the rows of the other tab do finish leaving
  await expectNoLeavingRows(page);
  expect(shown).toBeLessThanOrEqual(expected);

  await open(page, "/interests");
  await expect(page.getByTestId("view-row").first()).toContainText("Berlin或München");
  // "open in /jobs" carries both values
  const link = page.getByTestId("view-row").first().getByRole("link", { name: /在岗位页打开|岗位/ }).first();
  await expect(link).toHaveAttribute("href", /city=Berlin&city=M%C3%BCnchen/);

  // reopen it from Today after a reload
  await open(page, "/");
  await page.getByTestId("view-tabs").getByRole("radio", { name: /两个城市/ }).click();
  await expect(listRows(page)).toHaveCount(shown);
  await expectNoLeavingRows(page);
});

test("a hand-written scalar view (city: München) still applies on Today", async ({ page }) => {
  const text = fs.readFileSync(SHIPPED_FILE, "utf8").replace("views: []", "views:\n  - id: muc\n    name: 慕尼黑手写\n    default: false\n    filters:\n      city: München\n");
  fs.writeFileSync(INTERESTS_FILE, text);
  await open(page, "/?view=muc");
  await expect(listRows(page).filter({ hasText: "Machine Learning Engineer, Perception" })).toBeVisible();
  await expect(listRows(page)).toHaveCount(1);
  await open(page, "/interests");
  await expect(page.getByTestId("view-row").first()).toContainText("München");
  fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE);
});

test.describe("phone, English, terminal theme", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the city list unfolds in the sheet, searches, ticks, no sideways scroll, chips outside the sheet", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await open(page, "/jobs");
    const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noSideScroll()).toBe(true);

    await page.getByTestId("filter-toggle").click();
    await page.getByTestId("filter-city").click();
    await expect(page.getByTestId("filter-city")).toHaveAttribute("aria-expanded", "true");
    const row = option(page, "filter-city", "Berlin");
    expect((await row.locator("xpath=ancestor::label").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.getByTestId("filter-city-search").fill("munc");
    await expect(page.getByTestId("filter-city-option")).toHaveCount(1);
    await option(page, "filter-city", "München").click();
    await page.getByTestId("filter-city-search").fill("");
    await row.click();
    await expect(page.getByTestId("filter-city")).toContainText("München +1");
    // one list at a time
    await page.getByTestId("filter-workplace").click();
    await expect(page.getByTestId("filter-city-option")).toHaveCount(0);
    await expect(page.getByTestId("filter-workplace-option")).toHaveCount(4);
    expect(await noSideScroll()).toBe(true);

    await page.getByTestId("filter-apply").click();
    await expect(page).toHaveURL(/city=/);
    await expect(page.getByTestId("filter-toggle")).toContainText("Filters (1)");
    await expect(page.getByTestId("filter-chip")).toHaveCount(2);
    expect(await noSideScroll()).toBe(true);
    await page.getByRole("button", { name: "Remove filter City: München" }).click();
    await expect(page.getByTestId("filter-chip")).toHaveCount(1);
  });
});
