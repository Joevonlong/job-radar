import fs from "node:fs";
import path from "node:path";

import en from "../messages/en.json" with { type: "json" };
import zh from "../messages/zh.json" with { type: "json" };
import { expect, test, waitForServerActions, type Page } from "./fixtures";
import { listRows } from "./list-rows";

// Watching writes the shared interests.yaml: this spec belongs to the config chain in projects.ts.
test.describe.configure({ mode: "serial" });

async function open(page: Page, url = "/companies") {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

test("column headers sort the companies and keep the direction in the URL", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const header = page.getByRole("columnheader", { name: zh.companies.columns.score });
  const scores = async () => (await page.getByTestId("company-row").locator('[data-column="score"]').allTextContents()).filter((text) => text !== "—").map(Number);
  const names = () => page.getByTestId("company-row").getByRole("rowheader").allTextContents();
  await header.getByRole("link").click();
  await expect(page).toHaveURL((url) => url.searchParams.get("sort") === "score" && url.searchParams.get("dir") !== "asc");
  await expect(header).toHaveAttribute("aria-sort", "descending");
  const descending = await scores();
  const before = await names();
  expect(new Set(descending).size).toBeGreaterThan(1);
  expect(descending).toEqual([...descending].sort((a, b) => b - a));
  await header.getByRole("link").click();
  await expect(page).toHaveURL((url) => url.searchParams.get("sort") === "score" && url.searchParams.get("dir") === "asc");
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  expect(await scores()).toEqual([...descending].sort((a, b) => a - b));
  expect(await names()).not.toEqual(before);
});

test("searching a name and following its link opens only that company's jobs", async ({ page }) => {
  await open(page, "/companies?sort=recent&dir=asc&page=2");
  await page.getByRole("searchbox", { name: zh.companies.searchLabel }).fill("Brumbach");
  await page.getByRole("button", { name: zh.companies.search, exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === "Brumbach" && !url.searchParams.has("page") && url.searchParams.get("sort") === "recent" && url.searchParams.get("dir") === "asc");
  await expect(page.getByTestId("company-row")).toHaveCount(1);
  const company = "Brumbach Analytics GmbH";
  const expectedCount = Number(await page.getByTestId("company-row").locator('[data-column="jobs"]').textContent());
  await page.getByRole("table").getByRole("link", { name: company, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/jobs" && url.searchParams.get("company") === company);
  await expect(listRows(page)).toHaveCount(expectedCount);
  expect(expectedCount).toBeGreaterThan(0);
  for (const row of await listRows(page).all()) await expect(row.locator('[data-slot="company-link"]')).toHaveText(company);
});

test("watch and unwatch update the company row and Interests, restoring the watch list afterwards", async ({ page }) => {
  const configDir = process.env.E2E_CONFIG_DIR;
  if (!configDir || !path.isAbsolute(configDir)) throw new Error("E2E_CONFIG_DIR must name the disposable run's config directory");
  const file = path.join(configDir, "interests.yaml");
  const original = fs.readFileSync(file, "utf8");
  const company = "Brumbach Analytics GmbH";
  const row = page.getByTestId("company-row").filter({ hasText: company });
  try {
    await open(page);
    await row.getByRole("button", { name: zh.companies.watch, exact: true }).click();
    await expect(row.getByRole("button", { name: zh.companies.unwatch, exact: true })).toBeVisible();
    await open(page, "/interests");
    await expect(page.getByTestId("watched-item").filter({ hasText: company })).toHaveCount(1);
    await open(page);
    await row.getByRole("button", { name: zh.companies.unwatch, exact: true }).click();
    await expect(row.getByRole("button", { name: zh.companies.watch, exact: true })).toBeVisible();
    await open(page, "/interests");
    await expect(page.getByTestId("watched-item").filter({ hasText: company })).toHaveCount(0);
  } finally {
    await waitForServerActions(page);
    fs.writeFileSync(file, original);
  }
});

test("database-only watches cannot be removed here, and Exclude opens the profile field in view", async ({ page }) => {
  await open(page);
  const flagged = page.getByTestId("company-row").filter({ hasText: "Quillfeather Labs" });
  await expect(flagged.getByText(zh.companies.watchedByFlag)).toBeVisible();
  await expect(flagged.getByRole("button")).toHaveCount(0);
  await flagged.getByRole("link", { name: zh.companies.exclude, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/me" && url.hash === "#exclude-companies");
  const field = page.locator("#exclude-companies");
  await expect(field).toBeInViewport();
  await expect(field.getByRole("textbox")).toBeInViewport();
  await page.reload();
  await expect(field.getByRole("textbox")).toBeInViewport();
});

for (const [locale, theme] of [["en", "light"], ["zh", "dark"]] as const) {
  test(`390px cards and sort controls fit in ${locale}, ${theme} theme`, async ({ page, context, baseURL }) => {
    if (!baseURL) throw new Error("The e2e run must configure baseURL");
    const messages = locale === "en" ? en : zh;
    await page.setViewportSize({ width: 390, height: 844 });
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await open(page);
    await expect(page.getByTestId("company-card").first()).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noOverflow()).toBe(true);
    await page.getByRole("combobox", { name: messages.companies.sort, exact: true }).selectOption("score");
    await expect(page).toHaveURL((url) => url.searchParams.get("sort") === "score");
    await page.getByRole("button", { name: messages.companies.dirDescLabel }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("dir") === "asc");
    expect(await noOverflow()).toBe(true);
  });
}

test("Companies is available in the sidebar, command palette and mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await expect(page.getByRole("complementary").getByRole("link", { name: zh.nav.companies, exact: true })).toHaveAttribute("href", "/companies");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette.getByRole("option", { name: /公司/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: zh.shell.openMenu }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: zh.nav.companies, exact: true })).toHaveAttribute("href", "/companies");
});
