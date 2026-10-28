import fs from "node:fs";
import path from "node:path";

import en from "../messages/en.json" with { type: "json" };
import zh from "../messages/zh.json" with { type: "json" };
import { expect, test } from "./fixtures";

// Run alone with E2E_INVALID_CONFIG=schedule: the web starts with invalid YAML and an empty config cache.
test.skip(process.env.E2E_INVALID_CONFIG !== "schedule", "requires a fresh web process with a broken schedule");
test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  if (process.env.E2E_INVALID_CONFIG !== "schedule") return;
  const dir = process.env.E2E_CONFIG_DIR ?? "";
  fs.renameSync(path.join(dir, ".schedule.valid-e2e"), path.join(dir, "schedule.yaml"));
});

for (const { locale, messages } of [{ locale: "en", messages: en }, { locale: "zh", messages: zh }]) {
  test(`a cold invalid config has the right explanation and repair path in ${locale}`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL! }]);
    await page.goto("/jobs");
    const error = page.getByTestId("page-error");
    await expect(error.getByRole("heading")).toHaveText(messages.dashboard.error.configTitle);
    await expect(error).toContainText("schedule.yaml");
    await expect(error).not.toContainText(/database|数据库/);
    await error.getByRole("link", { name: messages.dashboard.error.repair }).click();
    await expect(page).toHaveURL(/\/settings\?tab=advanced/);
    await expect(page.getByTestId("page-error")).toHaveCount(0);
    await expect(page.getByTestId("advanced-card")).toBeVisible();
  });
}

test("retry fetches the page again after the invalid schedule has been repaired", async ({ page }) => {
  await page.goto("/jobs");
  const error = page.getByTestId("page-error");
  await expect(error).toContainText("schedule.yaml");
  const dir = process.env.E2E_CONFIG_DIR ?? "";
  fs.copyFileSync(path.join(dir, ".schedule.valid-e2e"), path.join(dir, "schedule.yaml"));
  await error.getByRole("button", { name: zh.dashboard.error.retry }).click();
  await expect(page.getByTestId("page-error")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: zh.pages.jobs.title, exact: true })).toBeVisible();
});
