import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";
import { parse, stringify } from "yaml";

/**
 * The ghost job check on the seeded e2e database (the seed runs it). Fictional seed job: "Data Engineer (Talent Pool)" at
 * Lindwurm Data Systems: posted 200 days ago, relisted under a new id, says it is a talent pool, and its JD is short → likely.
 * The check is off by default: the specs turn it on in ui.yaml and put the default back. Rewrites ui.yaml: a project of the serial
 * chain (e2e/projects.ts).
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const UI_FILE = path.join(CONFIG_DIR, "ui.yaml");
const GHOST = /Data Engineer \(Talent Pool\)/;

test.describe.configure({ mode: "serial" });

function ghostCheck(enabled: boolean) {
  const doc = parse(fs.readFileSync(path.join(DEFAULTS_DIR, "ui.yaml"), "utf8")) as Record<string, Record<string, unknown> | undefined>;
  doc.job_checks = { ...doc.job_checks, ghost: { enabled, trusted_companies: [] } };
  fs.writeFileSync(UI_FILE, stringify(doc));
}

test.beforeEach(() => ghostCheck(true));
test.afterAll(() => fs.copyFileSync(path.join(DEFAULTS_DIR, "ui.yaml"), UI_FILE));

async function openJobs(page: Page, query = "") {
  await page.goto(`/jobs${query}`);
  await page.waitForLoadState("networkidle");
}

const row = (page: Page, title: RegExp) => page.locator(".jb-row[data-job-id]").filter({ has: page.getByRole("link", { name: title }) }).first();

test("the list mark, the filter and its chip", async ({ page }) => {
  await openJobs(page, "?filtered=true");
  const mark = row(page, GHOST).getByTestId("ghost-mark");
  await expect(mark).toHaveText("疑似幽灵");
  await expect(mark).toHaveAttribute("data-level", "likely");
  await expect(mark).toHaveAttribute("title", /分数不受影响/);

  await page.getByTestId("filter-ghost-only").click();
  await expect(page).toHaveURL(/ghost=only/);
  await expect(page.getByRole("link", { name: GHOST }).first()).toBeVisible();
  await expect(page.locator('[data-testid="filter-chip"][data-key="ghost"]')).toContainText("幽灵岗位：只看疑似");

  await page.getByTestId("filter-ghost-hide").click();
  await expect(page).toHaveURL(/ghost=hide/);
  await expect(page.getByRole("link", { name: GHOST })).toHaveCount(0);

  await page.getByTestId("filter-ghost-all").click();
  await expect(page).not.toHaveURL(/ghost=/);
  await expect(page.locator('[data-testid="filter-chip"][data-key="ghost"]')).toHaveCount(0);
});

test("the detail page: reasons, the quote with its JD mark, dismiss and undo", async ({ page }) => {
  await openJobs(page, "?filtered=true&ghost=only");
  await page.getByRole("link", { name: GHOST }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("ghost-mark")).toHaveAttribute("href", "#h-checks");
  const check = page.getByTestId("ghost-check");
  await expect(check).toContainText("疑似幽灵（7 分）");
  await expect(check.getByTestId("ghost-check-reason")).toHaveCount(4);
  // channels by their display names, not their ids
  await expect(check).toContainText("Greenhouse");
  await expect(check.getByTestId("ghost-check-quote")).toContainText("talent pool");
  await check.getByTestId("ghost-check-jump").click();
  const mark = page.getByTestId("jd-ghost-mark");
  await expect(mark).toBeVisible();
  await expect(page.getByTestId("jd-legend-ghost")).toBeVisible();

  await check.getByTestId("ghost-dismiss").click();
  await expect(check).toContainText("已忽略");
  await expect(page.getByTestId("ghost-mark")).toHaveCount(0);
  // the JD mark goes with it
  await expect(page.getByTestId("jd-ghost-mark")).toHaveCount(0);
  await openJobs(page, "?filtered=true&ghost=only");
  await expect(page.getByRole("link", { name: GHOST })).toHaveCount(0);

  await openJobs(page, "?filtered=true");
  await page.getByRole("link", { name: GHOST }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.getByTestId("ghost-undo").click();
  await expect(page.getByTestId("ghost-dismiss")).toBeVisible();
  await expect(page.getByTestId("ghost-mark")).toBeVisible();
});

test("a relisted job: the posted date stays the same on the list and the detail page, the repost has a chip of its own", async ({ page }) => {
  await openJobs(page, "?filtered=true");
  const listed = row(page, GHOST).locator('[data-slot="row-posted"]');
  await expect(listed).toHaveAttribute("data-known", "true");
  const listDay = /^(\S+) · /.exec((await listed.locator("span[aria-hidden]").first().textContent()) ?? "")?.[1];
  expect(listDay).toBeTruthy();
  await page.getByRole("link", { name: GHOST }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
  const posted = page.getByTestId("posted-date");
  await expect(posted).toContainText(/^发布 \S+ 周[一二三四五六日]（\d+ 天前）/);
  expect(((await posted.textContent()) ?? "").split(" ")[1]).toBe(listDay);
  const repost = page.getByTestId("repost-date");
  await expect(repost).toContainText(/^↻重发 · 新链接 \S+（我们首次看到，\d+ 天前）/);
  await expect(repost).toHaveAttribute("title", /不是来源给的日期/);
  await expect(repost).not.toContainText("发布");
  await expect(repost.locator(".sr-only")).toContainText("旧链接最早见于");
});

test("off: no mark, no filter, no checks row; a ghost= in the URL is ignored but kept", async ({ page }) => {
  ghostCheck(false);
  await openJobs(page, "?filtered=true&ghost=hide");
  await expect(page).toHaveURL(/ghost=hide/);
  await expect(page.getByTestId("filter-ghost")).toHaveCount(0);
  await expect(page.getByTestId("ghost-mark")).toHaveCount(0);
  // the filter does nothing: the likely job is listed
  await page.getByRole("link", { name: GHOST }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("ghost-check")).toHaveCount(0);
  // the repost chip reads the stored result, so it is off with the check; the posted date stays
  await expect(page.getByTestId("repost-date")).toHaveCount(0);
  await expect(page.getByTestId("posted-date")).toContainText(/^发布 /);
});

test("390px and the dark theme: the list and the detail row fit without a horizontal scroll", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await openJobs(page, "?filtered=true&ghost=only");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("ghost-mark").first()).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: GHOST }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("ghost-check")).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
