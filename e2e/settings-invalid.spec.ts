import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/** A save that fails validation brings the first invalid field into view and focuses it (own spec: it edits the shared notify.yaml copy only while restoring it). */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(() => {
  fs.copyFileSync(path.join(process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults"), "notify.yaml"), path.join(CONFIG_DIR, "notify.yaml"));
});

test("an invalid value far down the form is scrolled to and focused after Save", async ({ page }) => {
  await page.goto("/settings?tab=notify");
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("settings-card-notify");
  const field = card.getByRole("textbox", { name: "每轮最多推送条数" });
  await field.fill("-5");

  // the save bar floats at the bottom of the viewport: scroll to the end of the form first, so the field is off-screen when the save fails
  const save = card.getByRole("button", { name: "保存", exact: true });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(field).not.toBeInViewport();
  await save.click();

  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeInViewport({ ratio: 1 });
  await expect(field).toBeFocused();
  await expect(card.getByRole("alert").first()).toBeInViewport({ ratio: 1 });
  // nothing was written
  expect(fs.readFileSync(path.join(CONFIG_DIR, "notify.yaml"), "utf8")).not.toContain("-5");
});
