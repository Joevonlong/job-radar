
import postgres from "postgres";
import { expect, test, type Page } from "./fixtures";
import { listRows } from "./list-rows";
import { EXCLUSIVE_TAG } from "./projects";

const query = "Searchfixture AI";
const url = (extra = "") => `/jobs?q=${encodeURIComponent(query)}${extra}`;
const option = (page: Page, code: string) => page.locator(`[data-testid="filter-country-option"][data-value="${code}"]`);
const connect = () => {
  const address = process.env.E2E_DATABASE_URL;
  if (!address || !new URL(address).pathname.startsWith("/jobradar_e2e")) throw new Error("A disposable E2E_DATABASE_URL is required");
  return postgres(address, { max: 1, onnotice: () => {} });
};
let companyId: number;
let engineerId: number;
let maintenanceId: number;
let analystId: number;

test.describe("precise job search", { tag: EXCLUSIVE_TAG }, () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    const sql = connect();
    try {
      const [company] = await sql<{ id: number }[]>`insert into companies (name, name_norm) values ('Searchfixture Works', 'searchfixture-works') returning id`;
      companyId = Number(company!.id);
      const ids: number[] = [];
      for (const [title, code, description] of [
        ["AI Engineer", "DE", "Fixture duties"],
        ["Maintenance Technician", "DE", "AI tooling; Searchdescriptionneedle"],
        ["AI Analyst", "FR", "Fixture duties"],
        ["Archived Engineer", "PT", "Fixture duties"],
      ]) {
        const locations = [{ city: null, label: "", countryCode: code ?? null, isPrimary: true }];
        const [job] = await sql<{ id: number }[]>`insert into jobs (company_id, title, title_norm, description, locations_json, first_seen_at, last_seen_at, status)
          values (${companyId}, ${title!}, ${title!.toLowerCase()}, ${description!}, ${sql.json(locations)}, now(), now(), 'active') returning id`;
        const id = Number(job!.id);
        ids.push(id);
        await sql`insert into scores (job_id, filter_result, score, rank_value) values (${id}, 'passed', 50, 50)`;
      }
      engineerId = ids[0]!;
      maintenanceId = ids[1]!;
      analystId = ids[2]!;
      await sql`insert into job_closure_overrides (job_id, action) values (${ids[3]!}, 'closed')`;
    } finally { await sql.end(); }
  });
  test.afterAll(async () => {
    if (!companyId) return;
    const sql = connect();
    try {
      await sql`delete from jobs where company_id = ${companyId}`;
      await sql`delete from companies where id = ${companyId}`;
    } finally { await sql.end(); }
  });

  for (const locale of ["en", "zh"] as const) {
    test(`description scope, countries and zero-result recovery (${locale})`, async ({ page, context, baseURL }) => {
      if (!baseURL) throw new Error("baseURL is required");
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
      await page.goto(url());
      await expect(listRows(page)).toHaveCount(2);
      await expect(listRows(page, `[data-job-id="${maintenanceId}"]`)).toHaveCount(0);
      await expect(page.getByTestId("search-relevance")).toContainText(locale === "en" ? "Sorted by relevance" : "按相关度排序");
      await expect(page.getByTestId("filter-sort-dir")).toHaveCount(0);
      const order = await listRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-job-id")));
      await page.goto(url("&dir=asc"));
      await expect(listRows(page)).toHaveCount(2);
      expect(await listRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-job-id")))).toEqual(order);
      await expect(page.getByTestId("search-relevance").getByRole("link")).not.toHaveAttribute("href", /dir=/);
      await page.getByTestId("search-relevance").getByRole("link").click();
      await expect(page).toHaveURL(/sort=rank/);
      await expect(page.getByTestId("filter-sort-dir")).toBeVisible();

      const toggle = page.getByTestId("filter-search-in");
      await toggle.click();
      await expect(page).toHaveURL(/searchIn=all/);
      await expect(listRows(page)).toHaveCount(3);
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(listRows(page, `[data-job-id="${maintenanceId}"]`)).toBeVisible();
      await toggle.click();
      await expect(page).not.toHaveURL(/searchIn=/);
      await expect(listRows(page)).toHaveCount(2);

      await page.getByTestId("filter-country").click();
      await expect(option(page, "FR")).toBeVisible();
      await option(page, "DE").click();
      await expect(page.getByTestId("filter-country")).toHaveAttribute("aria-expanded", "true");
      await option(page, "FR").click();
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).searchParams.getAll("country")).toEqual(["DE", "FR"]);
      await expect(page.getByTestId("filter-chips")).toContainText(locale === "en" ? "Germany" : "德国");
      await expect(listRows(page)).toHaveCount(2);
      await page.reload();
      await page.locator('[data-testid="filter-chip"][data-value="DE"] button').click();
      await expect(listRows(page)).toHaveCount(1);
      await expect(listRows(page, `[data-job-id="${analystId}"]`)).toBeVisible();

      await page.goto("/jobs?q=Searchdescriptionneedle");
      await expect(page.getByTestId("job-list-empty")).toBeVisible();
      await page.getByTestId("search-descriptions").click();
      await expect(page).toHaveURL(/searchIn=all/);
      await expect(listRows(page, `[data-job-id="${maintenanceId}"]`)).toBeVisible();
    });
  }

  test("country options follow the scope and selected absent countries remain removable", async ({ page }) => {
    await page.goto("/jobs?country=PT");
    await expect(page.getByTestId("save-view")).toBeDisabled();
    const hintId = await page.getByTestId("save-view").getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    await expect(page.locator(`[id="${hintId}"]`)).toHaveText("国家与搜索范围不保存进视图");
    await expect(page.getByTestId("save-view")).toHaveAttribute("title", "国家与搜索范围不保存进视图");
    await page.getByTestId("filter-country").click();
    await expect(option(page, "PT").locator('[data-slot="option-count"]')).toHaveText("0");
    await page.keyboard.press("Escape");
    await page.getByTestId("scope-archive").click();
    await expect(listRows(page).filter({ hasText: "Archived Engineer" })).toBeVisible();
    await page.getByTestId("filter-country").click();
    await expect(option(page, "PT").locator('[data-slot="option-count"]')).toHaveText("1");
    await page.keyboard.press("Escape");
    await page.getByTestId("scope-current").click();
    await page.locator('[data-testid="filter-chip"][data-value="PT"] button').click();
    await expect(page).not.toHaveURL(/country=/);
  });

  test("saving explains excluded search settings", async ({ page }) => {
    await page.goto(url("&country=DE&searchIn=all"));
    await page.getByTestId("save-view").click();
    await expect(page.getByTestId("save-view-search-hint")).toHaveText("国家与搜索范围不保存进视图");
    await page.keyboard.press("Escape");
    await page.goto("/jobs?searchIn=all");
    await expect(page.getByTestId("save-view")).toBeDisabled();
  });

  test("jump results keep server order, link to all results, and Esc restores focus", async ({ page }) => {
    await page.goto("/jobs");
    const trigger = page.getByRole("button", { name: /^跳转/ });
    await trigger.click();
    await expect(page.getByTestId("palette-jobs")).toHaveCount(0);
    const response = page.waitForResponse((r) => r.url().includes("/api/search?q="));
    await page.getByRole("combobox").fill(query);
    const body: { jobs: { id: number }[] } = await (await response).json();
    await expect(page.getByTestId("palette-job")).toHaveCount(body.jobs.length);
    expect(await page.getByTestId("palette-job").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-value")))).toEqual(body.jobs.map((job) => `job-${job.id}`));
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByTestId("palette-view-all").click();
    await expect(page).toHaveURL(url());
    await expect(listRows(page, `[data-job-id="${engineerId}"]`)).toBeVisible();
  });

  for (const width of [1280, 390]) {
    test(`search controls fit without horizontal scrolling at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url("&country=DE"));
      await expect(listRows(page)).toHaveCount(1);
      await expect(page.getByTestId("filter-search-in")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
});
