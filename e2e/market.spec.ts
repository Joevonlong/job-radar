import fs from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";

// Switching the market on /me. The seeded instance is German (the fixture template); the generic pack with the
// United States drops the local-language step, writes amounts in dollars and folds the German job boards away.
const PROFILE_DIR = process.env.E2E_PROFILE_DIR ?? "";
const PREFS_FILE = path.join(PROFILE_DIR, "preferences.yaml");

test.describe.configure({ mode: "serial" });

// every test starts from the German template, and the next spec file finds it again
test.beforeEach(() => fs.rmSync(PREFS_FILE, { force: true }));
test.afterAll(() => fs.rmSync(PREFS_FILE, { force: true }));

test("the German market: language step on, euro, German boards in the source list", async ({ page }) => {
  await page.goto("/me");
  const block = page.getByTestId("market-block");
  await expect(block).toBeVisible();
  await expect(page.getByTestId("market-language-step")).toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("market-language-step")).toContainText("德语");
  await expect(page.getByTestId("preferences-card").getByText("€", { exact: true })).toBeVisible();
  // the remote scope says what the home-country choice keeps, and a line under the select explains the chosen kind
  const scope = page.getByTestId("remote-scope-kind");
  await expect(scope.locator("option[value=home_country]")).toHaveText("能从德国远程（含面向欧盟 / 欧洲 / EMEA / 全球的远程岗）");
  await scope.selectOption("home_country");
  await expect(page.getByTestId("remote-scope-hint")).toContainText("保留：地点在德国");
  await scope.selectOption("none");
  await expect(page.getByTestId("remote-scope-hint")).toContainText("不收远程岗");

  await page.goto("/");
  await expect(page.getByTestId("toggle-hide-german")).toContainText("德语");
  await page.goto("/sources");
  await expect(page.getByTestId("other-market-channels")).toHaveCount(0);
});

test("switching to the generic pack in the US: no German filter, dollars, the German boards fold away", async ({ page }) => {
  await page.goto("/me");
  const prefs = page.getByTestId("preferences-card");
  await page.getByTestId("market-pack").selectOption("generic");
  await expect(page.getByTestId("market-reprocess-note")).toContainText("pnpm reprocess");
  // the generic pack names no country: saving without one is refused, field by field
  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect(prefs.getByRole("alert").first()).toBeVisible();
  expect(fs.readFileSync(PREFS_FILE, "utf8")).toMatch(/pack: de/);

  await page.getByTestId("market-country").selectOption("US");
  // no home region in this market: the choice names the country only
  await expect(page.getByTestId("remote-scope-kind").locator("option[value=home_country]")).toHaveText("能从美国远程");
  await page.getByTestId("market-currency").selectOption("USD");
  await page.getByTestId("market-language").fill("en");
  await expect(page.getByTestId("market-language-step")).toHaveAttribute("data-on", "false");
  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => fs.readFileSync(PREFS_FILE, "utf8")).toMatch(/pack: generic/);
  expect(fs.readFileSync(PREFS_FILE, "utf8")).toMatch(/country: US/);

  await page.reload();
  await expect(page.getByTestId("preferences-card").getByText("$", { exact: true })).toBeVisible();

  await page.goto("/");
  await expect(page.getByTestId("toggle-hide-german")).toHaveCount(0);
  await page.goto("/jobs");
  await expect(page.getByTestId("filter-hide-german")).toHaveCount(0);
  await page.goto("/sources");
  await expect(page.getByTestId("other-market-channels")).toBeVisible();
  await expect(page.getByTestId("other-market-channels")).toContainText("arbeitsagentur");
  await expect(page.getByTestId("other-market-channels")).toContainText("arbeitnow");
});
