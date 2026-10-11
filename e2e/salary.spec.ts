import { expect, test, type Page } from "@playwright/test";

/**
 * Salary benchmark and lookup on the seeded e2e database. The e2e salary.yaml turns the lookup on and uses
 * min_sample 2, so the seeded ML postings form a group. "Forward Deployed Engineer" (Quillfeather Labs) has a seeded,
 * fictional lookup; "LLM Engineer" (Brumbach Analytics) has none: clicking asks the stand-in runner, which answers with
 * a stub band of 90k-110k from levels.fyi. "AI Engineer (Agents)" states no salary. Nothing reaches a real site or AI.
 * The UI is Chinese by default.
 */

async function openJob(page: Page, query: string, title: string) {
  await page.goto(`/jobs?q=${encodeURIComponent(query)}`);
  await page.getByRole("link", { name: new RegExp(title.replace(/[()]/g, "\\$&")) }).first().click();
  await expect(page.getByTestId("job-title")).toHaveText(title);
}

test.describe.configure({ mode: "serial" });

test("a job with a salary: its percentile in the group, the band, the company and search links that open elsewhere", async ({ page }) => {
  await openJob(page, "LLM Engineer", "LLM Engineer");
  const level = page.getByTestId("salary-level-card");
  await expect(level.getByTestId("salary-level-group")).toBeVisible();
  await expect(level.getByTestId("salary-level-percentile")).toContainText("P");
  await expect(level.getByTestId("salary-level-marker")).toBeVisible();
  const link = level.locator('[data-testid^="salary-link-"]').first();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("href", /^https:\/\//);
});

test("a job without a salary still shows its group, without a position", async ({ page }) => {
  await openJob(page, "AI Engineer (Agents)", "AI Engineer (Agents)");
  const level = page.getByTestId("salary-level-card");
  await expect(level).toBeVisible();
  await expect(level.getByTestId("salary-level-marker")).toHaveCount(0);
});

test("a stored lookup shows its band, sources and the disclaimer without asking again", async ({ page }) => {
  await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
  const card = page.getByTestId("salary-lookup-card");
  await expect(card).toHaveAttribute("data-state", "done");
  await expect(card.getByTestId("salary-lookup-role")).toBeVisible();
  await expect(card.getByTestId("salary-lookup-disclaimer")).toBeVisible();
  const source = card.getByTestId("salary-lookup-source").first().getByRole("link");
  await expect(source).toHaveAttribute("href", /^https:\/\//);
  await expect(source).toHaveAttribute("rel", /nofollow/);
});

test("ask for a lookup: queued, answered by the runner, counted; the next visit reads the stored result", async ({ page }) => {
  await openJob(page, "LLM Engineer", "LLM Engineer");
  const card = page.getByTestId("salary-lookup-card");
  await expect(card).toHaveAttribute("data-state", "ready");
  await card.getByTestId("salary-lookup-button").click();
  await expect(card).toHaveAttribute("data-state", "done", { timeout: 30_000 });
  await expect(card.getByTestId("salary-lookup-role")).toContainText("€");

  // a reload is a cache hit: the stored lookup, no new request
  await page.reload();
  await expect(page.getByTestId("salary-lookup-card")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used", "1");
});

test("settings: the salary tab and the lookup's AI task", async ({ page }) => {
  await page.goto("/settings?tab=salary");
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("settings-card-salary");
  await expect(card.getByText("开启查薪资")).toBeVisible();
  await expect(card.getByText("每 24 小时最多查询")).toBeVisible();
  await page.goto("/settings?tab=ai");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("settings-card-ai").getByText("查薪资", { exact: true }).first()).toBeVisible();
});

test("390 px and English: the salary cards fit without horizontal scroll", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
  await expect(page.getByTestId("salary-lookup-card")).toContainText("Look up again");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
