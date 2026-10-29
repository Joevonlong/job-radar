import { expect, test, type Page } from "./fixtures";
import { listRows } from "./list-rows";
import { EXCLUSIVE_TAG } from "./projects";

const GONE = "Platform Engineer, Search Infrastructure";
const RELISTED = "Software Engineer, Search Quality";
const DORMANT = "Research Engineer, Document Retrieval";

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

async function pick(page: Page, key: string, value: string) {
  await page.getByTestId(`filter-${key}`).click();
  await page.locator(`[data-testid="filter-${key}-option"][data-value="${value}"]`).click();
  await page.keyboard.press("Escape");
}

for (const locale of ["en", "zh"] as const) {
  test.describe(`archive scope (${locale})`, { tag: EXCLUSIVE_TAG }, () => {
    test.beforeEach(async ({ context, baseURL }) => {
      if (!baseURL) throw new Error("The e2e run must configure baseURL");
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    });

    test("a direct archive link orders by source time, reason narrows it, and current clears last-listed sorting", async ({ page }) => {
      await open(page, "/jobs?scope=archive&q=Maplewick&sort=last_listed");
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Archive|历史库)/ })).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("filter-sort")).toContainText(locale === "en" ? "Last listed" : "最后列出");
      await expect(listRows(page)).toHaveCount(2);
      await expect(listRows(page).nth(0)).toContainText(GONE);
      await expect(listRows(page).nth(1)).toContainText(DORMANT);
      for (const row of await listRows(page).all()) await expect(row.getByTestId("row-last-listed")).toContainText(locale === "en" ? "Last listed" : "最后列出");
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Archive|历史库)/ })).toContainText("2");

      await pick(page, "reason", "gone");
      await expect(page).toHaveURL(/reason=gone/);
      await expect(listRows(page)).toHaveCount(1);
      await expect(listRows(page).first()).toContainText(GONE);
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Archive|历史库)/ })).toContainText("1");
      await page.getByTestId("filter-clear").click();
      await expect(page).toHaveURL(/scope=archive/);
      await expect(page).not.toHaveURL(/reason=|q=/);

      await open(page, "/jobs?scope=archive&sort=last_listed&dir=asc&reason=gone");
      await page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Current|当前)$/ }).click();
      await expect(page).toHaveURL(/scope=current/);
      await expect(page).not.toHaveURL(/sort=|dir=|reason=/);
      await expect(page.getByTestId("filter-reason")).toHaveCount(0);
    });

    test("legacy closed-status links resolve to All and still include undormant possibly-closed jobs", async ({ page }) => {
      await open(page, "/jobs?status=closed&status=possibly_closed");
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(All|全部)$/ })).toHaveAttribute("aria-current", "true");
      await expect(page).not.toHaveURL(/scope=/);
      await expect(listRows(page).filter({ hasText: "Security Engineer, Cloud" })).toHaveCount(1);
      await expect(listRows(page).filter({ hasText: DORMANT })).toHaveCount(1);
      await expect(listRows(page).filter({ hasText: GONE })).toHaveCount(1);
    });

    test("All remains selected after choosing Closed then clearing filters", async ({ page }) => {
      await open(page, "/jobs?filtered=true");
      await page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(All|全部)$/ }).click();
      await expect(page).toHaveURL(/scope=all/);
      const count = await page.getByTestId("result-count").textContent();
      await pick(page, "status", "closed");
      await expect(page).toHaveURL(/status=closed/);
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(All|全部)$/ })).toHaveAttribute("aria-current", "true");
      await page.getByTestId("filter-clear").click();
      await expect(page).toHaveURL(/scope=all/);
      await expect(page).not.toHaveURL(/status=/);
      await expect(page.getByTestId("result-count")).toHaveText(count!);
      await expect(listRows(page).filter({ hasText: DORMANT })).toHaveCount(1);
      await expect(listRows(page).filter({ hasText: GONE })).toHaveCount(1);
    });

    test("Current intersects Closed to an empty list and its status chip is removable", async ({ page }) => {
      await open(page, "/jobs");
      await page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Current|当前)$/ }).click();
      await pick(page, "status", "closed");
      await expect(page).toHaveURL(/scope=current/);
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Current|当前)$/ })).toHaveAttribute("aria-current", "true");
      await expect(listRows(page)).toHaveCount(0);
      await page.locator('[data-testid="filter-chip"][data-key="status"]').getByRole("button").click();
      await expect(page).not.toHaveURL(/status=/);
      await expect(page).toHaveURL(/scope=current/);
      await expect.poll(() => listRows(page).count()).toBeGreaterThan(0);
    });

    test("seen-again tags and filtering agree with the count, survive reload and clear within the scope", async ({ page }) => {
      await open(page, "/jobs?scope=current&q=Maplewick");
      const row = listRows(page).filter({ hasText: RELISTED });
      await expect(row.getByTestId("relisted-tag")).toContainText(locale === "en" ? "Seen again" : "再次出现");
      await expect(row.getByTestId("relisted-tag")).toHaveAttribute("title", locale === "en" ? /First seen .*Seen again #2.*Collected again by this tool/ : /首次发现 .*第 2 次再次出现.*本工具再次采集到/);
      await page.getByTestId("toggle-relisted").click();
      await expect(page).toHaveURL(/relisted=true/);
      await expect(page.getByTestId("toggle-relisted")).toHaveAttribute("data-active", "true");
      await expect(listRows(page)).toHaveCount(1);
      await expect(page.getByTestId("result-count")).toHaveText(locale === "en" ? "Results: 1" : "共 1 条");
      await page.reload();
      await expect(page.getByTestId("toggle-relisted")).toHaveAttribute("data-active", "true");
      await expect(listRows(page)).toHaveCount(1);
      await page.getByTestId("filter-clear").click();
      await expect(page).not.toHaveURL(/relisted=|q=/);
      await expect(page).toHaveURL(/scope=current/);
      await expect(page.getByTestId("toggle-relisted")).toHaveAttribute("data-active", "false");
    });

    test("Today links its seen-again note to the seeded job, whose detail keeps the date", async ({ page }) => {
      await open(page, "/?view=all&filtered=true&hideLang=false&high=false");
      await expect(page.getByTestId("relisted-note")).toHaveAttribute("data-count", "1");
      await expect(page.getByTestId("relisted-note")).toContainText(locale === "en" ? "1 job seen again" : "1 个岗位再次出现");
      // The old first-seen date keeps the relist out of Today's new-job list.
      await expect(listRows(page).filter({ hasText: RELISTED })).toHaveCount(0);
      await page.getByTestId("relisted-note-link").click();
      await expect(page).toHaveURL(/scope=current/);
      await expect(page).toHaveURL(/relisted=true/);
      const query = new URL(page.url()).searchParams;
      expect(query.get("filtered")).toBe("true");
      expect(query.get("hideLang")).toBe("false");
      expect(query.get("high")).toBe("false");
      const row = listRows(page).filter({ hasText: RELISTED });
      await expect(row).toHaveCount(1);
      await expect(listRows(page)).toHaveCount(1);
      await row.getByRole("link", { name: RELISTED, exact: true }).click();
      await expect(page.getByTestId("relisted-detail")).toContainText(locale === "en" ? "seen again" : "再次出现");
    });

    test("the switch fits 390px in both themes and can be operated with the keyboard", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, "/jobs?scope=current");
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.classList.remove("light", "dark"); document.documentElement.classList.add(value); }, theme);
        await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ })).toBeVisible();
        for (const scope of ["current", "archive", "all"]) {
          const box = await page.getByTestId(`scope-${scope}`).boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Current|当前)$/ }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("group", { name: /^(Job scope|岗位范围)$/ }).getByRole("link", { name: /^(Archive|历史库)/ })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/scope=archive/);
      await expect(page.getByRole("group", { name: locale === "en" ? "Job scope" : "岗位范围" }).getByRole("link", { name: /^(Archive|历史库)/ })).toHaveAttribute("aria-current", "true");
    });
  });
}
