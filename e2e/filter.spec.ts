import axe from "axe-core";

import { expect, test, type Page } from "./fixtures";

import { EXCLUSIVE_TAG } from "./projects";
import { listRows } from "./list-rows";

/**
 * Hard filter in the dashboard, on the seeded e2e database. Fictional seed jobs used here:
 *  - "Site Reliability Engineer": filtered out, reason `salary_below_floor:58000`, first seen today
 *  - "Werkstudent Data Science (m/w/d)": filtered out, reason `student_role`
 * Read-only: nothing here changes data.
 */

declare global {
  interface Window { axe: typeof axe }
}

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


test.describe("/jobs date filter", () => {
  const checked = (page: Page, group: string) => page.getByTestId(group).locator('[role="radio"][aria-checked="true"]');
  const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test("a quick range writes the URL and a chip, narrows the list, switches the compared date and clears from the chip", async ({ page }) => {
    await open(page, "/jobs");
    const all = await listRows(page).count();
    await expect(checked(page, "date-filter-field")).toHaveText("发布日期");
    await expect(checked(page, "date-filter-range")).toHaveText("不限");

    await page.getByTestId("date-filter-range-1d").click();
    await expect(page).toHaveURL(/within=1d/);
    await expect(page).toHaveURL(/dateBy=posted/);
    await expect(page.getByTestId("filter-chip")).toHaveText(/发布 · 1 天内/);
    const posted = await expect.poll(() => listRows(page).count()).toBeLessThan(all).then(() => listRows(page).count());

    await page.getByTestId("date-filter-field-seen").click();
    await expect(page).toHaveURL(/dateBy=seen/);
    await expect(page.getByTestId("filter-chip")).toHaveText(/首次发现 · 1 天内/);
    expect(await listRows(page).count()).toBeGreaterThan(0);
    expect(posted).toBeGreaterThan(0);

    // a reload keeps it
    await page.reload();
    await expect(checked(page, "date-filter-range")).toHaveText("1 天内");
    await expect(checked(page, "date-filter-field")).toHaveText("首次发现");

    await page.getByTestId("date-filter-range-month").click();
    await expect(page).toHaveURL(/within=month/);
    await expect(page.getByTestId("filter-chip")).toHaveText(/首次发现 · 本月/);

    await page.getByRole("button", { name: /移除日期筛选/ }).click();
    await expect(page).not.toHaveURL(/within|dateBy/);
    await expect(page.getByTestId("filter-chip")).toHaveCount(0);
    await expect(checked(page, "date-filter-range")).toHaveText("不限");
    await expect.poll(() => listRows(page).count()).toBe(all);
  });

  test("custom dates replace the range, an old from / to link reads as first seen, and Clear filters removes the date", async ({ page }) => {
    await open(page, "/jobs?from=2026-10-01&to=2026-10-15");
    await expect(checked(page, "date-filter-field")).toHaveText("首次发现");
    await expect(checked(page, "date-filter-range")).toHaveText("自定义…");
    await expect(page.getByTestId("filter-from")).toHaveValue("2026-10-01");
    await expect(page.getByTestId("filter-to")).toHaveValue("2026-10-15");
    await expect(page.getByTestId("filter-chip")).toHaveText(/首次发现 · 10-01 – 10-15/);

    await page.getByTestId("date-filter-range-7d").click();
    await expect(page).toHaveURL(/within=7d/);
    await expect(page).not.toHaveURL(/from=|to=/);

    await page.getByTestId("date-filter-range-custom").click();
    await page.getByTestId("filter-from").fill("2026-10-02");
    await expect(page).toHaveURL(/from=2026-10-02/);
    await expect(page).not.toHaveURL(/within=/);

    await page.getByTestId("filter-clear").click();
    await expect(page).not.toHaveURL(/from=|within=|dateBy=/);
    await expect(checked(page, "date-filter-range")).toHaveText("不限");
  });

  test("the date counts as one filter in Filters (n)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/jobs?from=2026-10-01&to=2026-10-15&dateBy=seen");
    await expect(page.getByTestId("filter-toggle")).toHaveText("筛选 (1)");
  });

  test("a range that is not offered still filters and highlights nothing", async ({ page }) => {
    await open(page, "/jobs?within=30d&dateBy=posted");
    await expect(page.getByTestId("filter-chip")).toHaveText(/发布 · 30 天内/);
    await expect(checked(page, "date-filter-range")).toHaveCount(0);
  });

  test("on a phone the groups scroll inside themselves, the buttons are 44px tall and the page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, "/jobs");
    await page.getByTestId("filter-toggle").click();
    const range = page.getByTestId("date-filter-range");
    await expect(range).toBeVisible();
    // the sheet opens with a short animation: measure once it has settled
    for (const id of ["date-filter-field-posted", "date-filter-range-any", "date-filter-range-month"]) {
      await expect.poll(async () => (await page.getByTestId(id).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(await noSideScroll(page)).toBe(true);
    // a group wider than the sheet (long labels) scrolls inside its own box instead of widening the page
    expect(await range.evaluate((el) => el.parentElement ? getComputedStyle(el.parentElement).overflowX : "")).toBe("auto");
    expect((await range.locator("..").boundingBox())!.x + (await range.locator("..").boundingBox())!.width).toBeLessThanOrEqual(375);
    await page.getByTestId("date-filter-range-custom").scrollIntoViewIfNeeded();
    await page.getByTestId("date-filter-range-custom").click();
    await expect(page.getByTestId("filter-from")).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    const from = await page.getByTestId("filter-from").boundingBox();
    const to = await page.getByTestId("filter-to").boundingBox();
    expect(to!.y).toBeGreaterThan(from!.y);
  });

  test("the segmented groups work from the keyboard, are named, and axe finds nothing in the filters", async ({ page }) => {
    await open(page, "/jobs?within=7d&dateBy=posted");
    await expect(page.getByTestId("date-filter-field")).toHaveAccessibleName("按");
    await expect(page.getByTestId("date-filter-range")).toHaveAccessibleName("范围");
    await page.getByTestId("date-filter-range-7d").focus();
    // held for a moment like a real key press: the radio group selects the item that arrow focuses while the key is down
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(100);
    await page.keyboard.up("ArrowRight");
    await expect(page).toHaveURL(/within=14d/);
    await expect(checked(page, "date-filter-range")).toHaveText("2 周内");
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run('[data-testid="jobs-filters"]', { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
      return result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }));
    });
    expect(violations).toEqual([]);
  });
});
