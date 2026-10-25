import path from "node:path";

import { expect, test, type Page } from "./fixtures";

/**
 * Salary benchmark and lookup on the seeded e2e database. The e2e salary.yaml turns the lookup on and uses
 * min_sample 2, so the seeded ML postings form a posting-only group. "Forward Deployed Engineer" (Quillfeather Labs)
 * shares a fictional lookup made on an earlier, closed posting; "LLM Engineer" (Brumbach Analytics) has none:
 * clicking asks the stand-in runner, which answers with
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
  await expect(level.getByTestId("salary-level-group-line")).toContainText(/ · 样本 \d+$/);
  await expect(level.getByTestId("salary-level-group-line")).not.toContainText(/JD\s*\d+|查询\s*\d+/);
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

test("a shared lookup labels every estimate and links to the posting that started it without asking again", async ({ page }) => {
  await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
  const card = page.getByTestId("salary-lookup-card");
  await expect(card).toHaveAttribute("data-state", "done");
  await expect(card.getByTestId("salary-lookup-ai-badge")).toHaveText("AI 查询");
  await expect(card.getByTestId("salary-lookup-confidence")).toContainText("AI 自评置信度");
  await expect(card.getByTestId("salary-lookup-role")).toBeVisible();
  for (const id of ["salary-lookup-role", "salary-lookup-related-0", "salary-lookup-related-1", "salary-lookup-company"]) {
    await expect(card.getByTestId(`${id}-unverified`)).toHaveText("AI 估计（未核对）");
  }
  await expect(card.getByRole("heading", { name: "AI 给出的来源（未核对）" })).toBeVisible();
  await expect(card.getByTestId("salary-lookup-other-source")).toHaveText("不在薪资网站列表中");
  await expect(card.getByTestId("salary-lookup-disclaimer")).toContainText("也不计入薪资基准和任何筛选");
  await expect(card.getByTestId("salary-lookup-scope")).toContainText("不是根据这条 JD");
  await expect(card).not.toContainText(/已核对|已验证|\bverified\b/i);
  const source = card.getByTestId("salary-lookup-source").first().getByRole("link");
  await expect(source).toHaveAttribute("href", /^https:\/\//);
  await expect(source).toHaveAttribute("rel", /nofollow/);
  const origin = card.getByTestId("salary-lookup-origin");
  await expect(origin).toContainText("这次查询是在另一条岗位上发起的");
  const originLink = origin.getByRole("link", { name: "Forward Deployed Engineer", exact: true });
  await expect(originLink).toHaveAttribute("href", /^\/jobs\/\d+$/);
  const originHref = await originLink.getAttribute("href");
  expect(originHref).not.toBe(`/jobs/${await card.getAttribute("data-job-id")}`);
  await originLink.click();
  await expect(page).toHaveURL(new RegExp(`${originHref}$`));
  await expect(page.getByTestId("job-title")).toHaveText("Forward Deployed Engineer");
  await expect(page.getByTestId("salary-lookup-card")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("salary-lookup-origin")).toHaveCount(0);
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

for (const locale of ["en", "zh"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`390 px, ${locale}, ${theme}: the salary cards fit without horizontal scroll`, async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL ?? "http://127.0.0.1" }]);
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const card = page.getByTestId("salary-lookup-card");
      await expect(card.getByTestId("salary-lookup-ai-badge")).toHaveText(locale === "en" ? "AI lookup" : "AI 查询");
      await expect(card.getByTestId("salary-lookup-confidence")).toContainText(locale === "en" ? "AI's own confidence" : "AI 自评置信度");
      await expect(card.getByTestId("salary-lookup-scope")).toBeVisible();
      await expect(card.getByTestId("salary-lookup-origin")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await card.screenshot({ path: path.resolve(process.env.E2E_SHOTS_DIR ?? "test-results", `salary-lookup-390-${locale}-${theme}.png`) });
    });
  }
}
