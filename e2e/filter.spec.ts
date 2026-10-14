import { expect, test, type Page } from "./fixtures";

import { EXCLUSIVE_TAG } from "./projects";
import { listRows } from "./list-rows";

/**
 * Hard filter in the dashboard, on the seeded e2e database. Fictional seed jobs used here:
 *  - "Site Reliability Engineer": filtered out, reason `salary_below_floor:58000`, first seen today
 *  - "Werkstudent Data Science (m/w/d)": filtered out, reason `student_role`
 * Read-only: nothing here changes data.
 */

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("Today", () => {
  test("hides filtered jobs; the toggle shows them with a localized reason and hides them again", async ({ page }) => {
    await open(page, "/");
    const sre = page.getByRole("link", { name: /Site Reliability Engineer/ });
    await expect(sre).toHaveCount(0);

    await page.getByTestId("toggle-filtered").click();
    await expect(page).toHaveURL(/[?&]filtered=true/);
    const row = listRows(page).filter({ hasText: "Site Reliability Engineer" });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-slot="filter-reasons"]')).toContainText("写明的薪资上限 €58k 低于年薪底线");
    await expect(row).toContainText("已过滤");

    // a reload keeps the switch
    await page.reload();
    await expect(listRows(page).filter({ hasText: "Site Reliability Engineer" })).toBeVisible();

    await page.getByTestId("toggle-filtered").click();
    await expect(page.getByRole("link", { name: /Site Reliability Engineer/ })).toHaveCount(0);
    await expect(page).not.toHaveURL(/filtered/);
  });
});

test.describe("/jobs", () => {
  test("filtered jobs are hidden by default and shown by the toggle, which the URL carries", async ({ page }) => {
    await open(page, "/jobs?q=Werkstudent");
    await expect(page.getByTestId("job-list-empty")).toBeVisible();

    await page.getByTestId("toggle-filtered").click();
    await expect(page).toHaveURL(/filtered=true/);
    await expect(page).toHaveURL(/q=Werkstudent/);
    const row = listRows(page).filter({ hasText: "Werkstudent Data Science" });
    await expect(row.locator('[data-slot="filter-reasons"]')).toHaveText("学生 / 实习岗位");

    await page.reload();
    await expect(listRows(page).filter({ hasText: "Werkstudent Data Science" })).toBeVisible();

    await page.getByTestId("toggle-filtered").click();
    await expect(page.getByTestId("job-list-empty")).toBeVisible();
  });

  // counts the whole list, which other specs change while the parallel project runs: one at a time, after it (e2e/projects.ts)
  test("the toggle changes the result count", { tag: EXCLUSIVE_TAG }, async ({ page }) => {
    await open(page, "/jobs");
    const count = async () => Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    const hidden = await count();
    await page.getByTestId("toggle-filtered").click();
    await expect(page).toHaveURL(/filtered=true/);
    await expect.poll(count).toBeGreaterThanOrEqual(hidden + 2);
  });
});

test.describe("detail", () => {
  test("a filtered job says why, in Chinese and in English", async ({ page, context, baseURL }) => {
    await open(page, "/jobs?q=Site+Reliability&filtered=true");
    await page.getByRole("link", { name: /Site Reliability Engineer/ }).click();
    // the "keep anyway" button sits among the header actions, not in the banner
    const sentence = page.getByTestId("filter-banner").locator("span").first();
    await expect(sentence).toHaveText("该岗位被硬过滤：写明的薪资上限 €58k 低于年薪底线。");
    await expect(page.getByTestId("detail-header").getByRole("button", { name: "仍然保留" })).toBeVisible();

    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.reload();
    await expect(sentence).toHaveText("Hard-filtered: Stated salary cap €58k is below your floor.");
  });
});

test.describe("sort on a phone", () => {
  test("the drop-down offers the salary sort and the button next to it flips the direction; no column head, no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/jobs");
    await expect(page.locator('[data-slot="list-head"]')).toBeHidden();
    await page.getByTestId("filter-toggle").click();
    await page.getByTestId("filter-sort").click();
    await page.locator('[data-testid="filter-sort-option"][data-value="salary"]').click();
    await expect(page).toHaveURL(/sort=salary/);
    await expect(page.getByTestId("filter-sort-dir")).toHaveAttribute("data-dir", "desc");
    await page.getByTestId("filter-sort-dir").click();
    await expect(page).toHaveURL(/sort=salary&dir=asc/);
    await expect(page.getByTestId("filter-sort-dir")).toHaveAttribute("data-dir", "asc");
    await page.getByTestId("filter-apply").click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

