import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";

/**
 * The visa check on the seeded e2e database (the seed runs it, like the cycle's signals step). Fictional seed jobs:
 * "Machine Learning Engineer, Perception" (Tidewater Robotics) offers relocation support → offered; "Research Engineer,
 * Evaluation" (Nebelhorn AI) asks for a valid EU work permit → not offered (permit required); "Applied Scientist, Clinical
 * NLP" (Mosaik Health AI) mentions sponsorship without saying more → unclear.
 * The list badge and the filter show only for a user who needs sponsorship (ui.yaml `badges: auto`): the tests write
 * me.yaml `needs_visa_sponsorship` and put the template back. Rewrites me.yaml: a project of the serial chain (e2e/projects.ts).
 */
const PROFILE_DIR = process.env.E2E_PROFILE_DIR ?? "";
const ME_FILE = path.join(PROFILE_DIR, "me.yaml");

const OFFERED = /Machine Learning Engineer, Perception/;
const PERMIT = /Research Engineer, Evaluation/;
const UNCLEAR = /Applied Scientist, Clinical NLP/;

test.describe.configure({ mode: "serial" });
test.afterAll(() => fs.rmSync(ME_FILE, { force: true }));

/** me.yaml from the template (opening /me writes it), with `needs_visa_sponsorship` set. */
async function needsSponsorship(page: Page, value: boolean) {
  fs.rmSync(ME_FILE, { force: true });
  await page.goto("/me");
  await page.waitForLoadState("networkidle");
  await expect.poll(() => fs.existsSync(ME_FILE)).toBe(true);
  const text = fs.readFileSync(ME_FILE, "utf8");
  expect(text).toMatch(/^needs_visa_sponsorship: (?:true|false)$/m);
  fs.writeFileSync(ME_FILE, text.replace(/^needs_visa_sponsorship: (?:true|false)$/m, `needs_visa_sponsorship: ${value}`));
}

async function openJobs(page: Page, query = "") {
  await page.goto(`/jobs${query}`);
  await page.waitForLoadState("networkidle");
}

const row = (page: Page, title: RegExp) => page.locator(".jb-row[data-job-id]").filter({ has: page.getByRole("link", { name: title }) }).first();

test("for a user who needs sponsorship: list badges, the filter and its chip", async ({ page }) => {
  await needsSponsorship(page, true);
  await openJobs(page, "?filtered=true");
  await expect(row(page, OFFERED).getByTestId("visa-badge")).toHaveText("提到签证支持");
  const permit = row(page, PERMIT).getByTestId("visa-badge");
  await expect(permit).toHaveText("要求已有工作许可");
  await expect(permit).toHaveAttribute("data-kind", "permit_required");
  await expect(row(page, UNCLEAR).getByTestId("visa-badge")).toHaveCount(0);

  await page.getByTestId("filter-visa-offered").click();
  await expect(page).toHaveURL(/visa=offered/);
  await expect(page.getByRole("link", { name: OFFERED }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: PERMIT })).toHaveCount(0);
  await expect(page.getByRole("link", { name: UNCLEAR })).toHaveCount(0);
  await expect(page.locator('[data-testid="filter-chip"][data-key="visa"]')).toContainText("签证：提到支持");

  await page.getByTestId("filter-visa-not_denied").click();
  await expect(page).toHaveURL(/visa=not_denied/);
  await expect(page.getByRole("link", { name: UNCLEAR }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: PERMIT })).toHaveCount(0);

  await page.locator('[data-testid="filter-chip"][data-key="visa"]').getByRole("button").click();
  await expect(page).not.toHaveURL(/visa=/);
});

test("the detail page: the checks row quotes the JD and jumps to its mark", async ({ page }) => {
  await needsSponsorship(page, true);
  await openJobs(page, "?filtered=true");
  await page.getByRole("link", { name: PERMIT }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
  const check = page.getByTestId("visa-check");
  await expect(check.getByTestId("visa-check-state")).toHaveAttribute("data-state", "not_offered");
  await expect(check.getByTestId("visa-check-state")).toHaveAttribute("data-kind", "permit_required");
  await expect(check.getByTestId("visa-check-state")).toHaveAttribute("data-tone", "bad");
  await expect(check.getByTestId("visa-check-quote")).toContainText("Applicants must already hold a valid EU work permit.");
  await check.getByTestId("visa-check-jump").click();
  const mark = page.getByTestId("jd-visa-mark").filter({ hasText: "work permit" });
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("title", "JD 里关于签证赞助的说法");
  await expect(page.getByTestId("jd-legend-visa")).toBeVisible();
});

test("for a user who does not need it: no badge, no filter, a saved visa= is ignored but kept; the detail row stays, in grey", async ({ page }) => {
  await needsSponsorship(page, false);
  await openJobs(page, "?filtered=true&visa=offered");
  await expect(page).toHaveURL(/visa=offered/);
  await expect(page.getByTestId("filter-visa")).toHaveCount(0);
  await expect(page.locator('[data-testid="filter-chip"][data-key="visa"]')).toHaveCount(0);
  await expect(page.getByTestId("visa-badge")).toHaveCount(0);
  // the filter does nothing: the refusing job is listed
  await expect(page.getByRole("link", { name: PERMIT }).first()).toBeVisible();
  // clearing the filters leaves it for when the control is back
  const clear = page.getByTestId("filter-clear");
  if ((await clear.count()) > 0 && (await clear.isVisible())) {
    await clear.click();
    await expect(page).toHaveURL(/visa=offered/);
  }

  await page.getByRole("link", { name: PERMIT }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await expect(page.getByTestId("visa-check-state")).toHaveAttribute("data-state", "not_offered");
  await expect(page.getByTestId("visa-check-state")).toHaveAttribute("data-tone", "dim");
});

test("390px and the dark theme: the list and the detail row fit without a horizontal scroll", async ({ page }) => {
  await needsSponsorship(page, true);
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await openJobs(page, "?filtered=true&visa=offered");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("visa-badge").first()).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: OFFERED }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("visa-check-state")).toHaveAttribute("data-state", "offered");
  expect(await overflow()).toBeLessThanOrEqual(0);
});
