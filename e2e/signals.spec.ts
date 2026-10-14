import { expect, test, type Page } from "./fixtures";
import { listRows } from "./list-rows";
import { EXCLUSIVE_TAG } from "./projects";

/**
 * Pay and benefit signals on the seeded e2e database. Fictional seed job used here:
 *  - "Applied Scientist, Clinical NLP": T1 salary range + T2 equity (stock options), both quoted from its JD
 * The UI is Chinese by default.
 */

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("signals", () => {
  // counts the whole /jobs table before and after clearing a filter: other specs that close and reopen seeded jobs must not run meanwhile
  test("rows carry category tags, and the high-value filter keeps only jobs with an amount or equity (the default high-value categories)", { tag: EXCLUSIVE_TAG }, async ({ page }) => {
    await open(page, "/jobs");
    const total = await listRows(page).count();
    expect(total).toBeGreaterThan(3);

    await page.getByTestId("filter-high").click();
    await expect(page).toHaveURL(/high=true/);
    await expect(page.getByTestId("filter-high")).toHaveAttribute("aria-pressed", "true");
    const rows = listRows(page);
    // the server re-renders after the URL changes
    await expect.poll(() => rows.count()).toBeLessThan(total);
    const filtered = await rows.count();
    expect(filtered).toBeGreaterThan(0);
    for (let i = 0; i < filtered; i += 1) {
      // T2 is a tag; T1 (a stated amount) has no tag, it is the salary on the mini axis
      const tiers = await rows.nth(i).locator("[data-slot=signal-tag]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tier")));
      const salaryStates = await rows.nth(i).locator("[data-salary-state]").evaluateAll((els) => els.map((e) => e.getAttribute("data-salary-state")));
      expect(tiers.includes("T2") || salaryStates.some((state) => state !== "none")).toBe(true);
    }

    await page.reload();
    await expect(page.getByTestId("filter-high")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("filter-clear").click();
    await expect(page).not.toHaveURL(/high=/);
    await expect.poll(() => listRows(page).count()).toBe(total);
  });

  test("Today has the same quick filter", async ({ page }) => {
    await open(page, "/");
    const total = await listRows(page).count();
    await page.getByTestId("toggle-high").click();
    await expect(page).toHaveURL(/high=true/);
    await expect.poll(() => listRows(page).count()).toBeLessThan(total);
    expect(await listRows(page).count()).toBeGreaterThan(0);
    await expect(listRows(page).first()).toContainText("Applied Scientist, Clinical NLP");
  });

  test("on Today the three toggles (filtered, hide German, high value) keep each other", async ({ page }) => {
    await open(page, "/");
    await page.getByTestId("toggle-high").click();
    await expect(page).toHaveURL(/high=true/);
    await page.getByTestId("toggle-hide-german").click();
    await expect(page).toHaveURL(/high=true/);
    await expect(page).toHaveURL(/hideLang=true/);
    await page.getByTestId("toggle-filtered").click();
    await expect(page).toHaveURL(/filtered=true/);
    await expect(page).toHaveURL(/high=true/);
    await expect(page).toHaveURL(/hideLang=true/);
    await page.getByTestId("toggle-high").click();
    await expect(page).not.toHaveURL(/high=/);
    await expect(page).toHaveURL(/filtered=true/);
    await expect(page).toHaveURL(/hideLang=true/);
  });

  test("on /jobs the high-value filter combines with hide German and show filtered", async ({ page }) => {
    await open(page, "/jobs?filtered=true&hideLang=true");
    await page.getByTestId("filter-high").click();
    await expect(page).toHaveURL(/high=true/);
    await expect(page).toHaveURL(/filtered=true/);
    await expect(page).toHaveURL(/hideLang=true/);
    await expect(page.getByTestId("filter-high")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-hide-german")).toHaveAttribute("aria-pressed", "true");
  });

  test("old links: `?t12=true` gives the same list as `?high=true` on /jobs and Today, and the filter writes only `high`", async ({ page }) => {
    const ids = () => listRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-job-id")));
    for (const base of ["/jobs", "/"]) {
      await open(page, `${base}?high=true`);
      const high = await ids();
      expect(high.length).toBeGreaterThan(0);
      await open(page, `${base}?t12=true`);
      expect(await ids()).toEqual(high);
    }
    await open(page, "/jobs?t12=true");
    await expect(page.getByTestId("filter-high")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-high")).toHaveAttribute("title", /具体金额 \/ 股权/);
    await page.getByTestId("filter-salary").click();
    await expect(page).toHaveURL(/high=true/);
    await expect(page).not.toHaveURL(/t12=/);
  });

  test("the detail page lists signals with their quotes, the capped bonus, and highlights the quotes in the JD", async ({ page }) => {
    await open(page, "/");
    await page.getByRole("link", { name: /Applied Scientist, Clinical NLP/ }).click();
    await expect(page.getByTestId("job-title")).toHaveText("Applied Scientist, Clinical NLP");

    const items = page.getByTestId("signal-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute("data-tier", "T1");
    await expect(items.nth(0).getByTestId("signal-value")).toContainText("90–110k");
    await expect(items.nth(0).getByTestId("signal-points")).toContainText("+10");
    await expect(items.nth(0).getByTestId("signal-quote")).toContainText("Salary: EUR 90,000 to 110,000 per year.");
    await expect(items.nth(1)).toHaveAttribute("data-tier", "T2");
    await expect(items.nth(1).getByTestId("signal-quote")).toContainText("Stock options (ESOP)");
    // 10 + 8 = 18, capped at 15
    await expect(page.getByTestId("bonus-line")).toContainText("加分 18");
    await expect(page.getByTestId("bonus-line")).toContainText("封顶 15");

    // the signal quotes (the JD's visa sentence has its own mark, see visa.spec.ts)
    const marks = page.locator('[data-testid="jd-body"] mark:not([data-tier="visa"])');
    await expect(marks).toHaveCount(2);
    // in the order the sentences appear in the JD
    expect(await marks.evaluateAll((els) => els.map((e) => e.getAttribute("data-tier")).sort())).toEqual(["T1", "T2"]);
    await expect(page.getByTestId("jd-legend")).toContainText("T1");
  });
});
