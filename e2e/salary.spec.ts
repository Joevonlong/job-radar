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

test("a job with a salary: the three cells, the group row with its place, and search links that open elsewhere", async ({ page }) => {
  await openJob(page, "LLM Engineer", "LLM Engineer");
  const panel = page.getByTestId("salary-panel");
  await expect(page.getByRole("heading", { level: 2, name: "薪资 · 这个岗位给多少钱" })).toHaveAttribute("id", "h-pay");
  await expect(panel.getByTestId("salary-head-jd-figure")).toContainText("€");
  await expect(panel.getByTestId("salary-head-group-median")).toContainText("中位");
  await expect(panel.getByTestId("salary-head-group-position")).toContainText(/\d+%|最低|最高/);
  await expect(panel.getByTestId("salary-head-ai")).toContainText("还没查");
  await expect(panel.getByTestId("salary-lane-group")).toHaveAttribute("data-state", "drawn");
  await expect(panel.getByTestId("salary-lane-group-source")).toContainText(/ · 样本 \d+$/);
  await expect(panel.getByTestId("salary-lane-group-source")).not.toContainText(/JD\s*\d+|查询\s*\d+/);
  await expect(panel.getByTestId("salary-lane-jd-block")).toBeVisible();
  await expect(page.getByTestId("salary-level-card")).toHaveCount(0);
  await expect(page.getByTestId("salary-lookup-card")).toHaveCount(0);
  const link = panel.locator('[data-testid^="salary-link-"]').first();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("href", /^https:\/\//);
});

test("a job without a salary still shows its group, with nothing drawn for the posting", async ({ page }) => {
  await openJob(page, "AI Engineer (Agents)", "AI Engineer (Agents)");
  const panel = page.getByTestId("salary-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("salary-head-jd")).toContainText("未披露");
  await expect(panel.getByTestId("salary-lane-jd")).toHaveAttribute("data-state", "none");
  await expect(panel.getByTestId("salary-lane-jd-block")).toHaveCount(0);
  await expect(panel.getByTestId("salary-lane-group")).toBeVisible();
});

test("the year card links to the panel, which scrolls into view", async ({ page }) => {
  await openJob(page, "LLM Engineer", "LLM Engineer");
  await page.getByTestId("salary-card-panel-link").click();
  await expect(page).toHaveURL(/#h-pay$/);
  await expect(page.getByRole("heading", { level: 2, name: "薪资 · 这个岗位给多少钱" })).toBeInViewport();
});

test("a shared lookup labels every estimate and links to the posting that started it without asking again", async ({ page }) => {
  await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
  const card = page.getByTestId("salary-panel");
  await expect(card).toHaveAttribute("data-lookup-state", "done");
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
  await expect(page.getByTestId("salary-panel")).toHaveAttribute("data-lookup-state", "done");
  await expect(page.getByTestId("salary-lookup-origin")).toHaveCount(0);
});

test("ask for a lookup: queued, answered by the runner, counted; the next visit reads the stored result", async ({ page }) => {
  await openJob(page, "LLM Engineer", "LLM Engineer");
  const card = page.getByTestId("salary-panel");
  await expect(card).toHaveAttribute("data-lookup-state", "ready");
  await card.getByTestId("salary-lookup-button").click();
  await expect(card).toHaveAttribute("data-lookup-state", "done", { timeout: 30_000 });
  await expect(card.getByTestId("salary-lookup-role")).toContainText("€");
  // the band is on the ruler and in the third cell, marked as an unverified estimate
  await expect(card.getByTestId("salary-lane-ai-block")).toBeVisible();
  await expect(card.getByTestId("salary-head-ai-figure")).toContainText("€");
  await expect(card.getByTestId("salary-head-ai")).toContainText("未核对");

  // a reload is a cache hit: the stored lookup, no new request
  await page.reload();
  await expect(page.getByTestId("salary-panel")).toHaveAttribute("data-lookup-state", "done");
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

test("the ruler is a labelled list whose rows carry their figures, with at most one live region and one alert", async ({ page }) => {
  await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
  const panel = page.getByTestId("salary-panel");
  const list = panel.getByRole("list", { name: "各来源薪资对照" });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  // the rows that draw figures carry them as text (the company row says "none" in words when the company has no other salary)
  for (const kind of ["group", "ai"]) await expect(panel.getByTestId(`salary-lane-${kind}`)).toContainText(/\d/);
  await expect(panel.getByTestId("salary-track-ai")).toHaveAttribute("aria-hidden", "true");
  expect(await panel.getByRole("status").count()).toBeLessThanOrEqual(1);
  expect(await panel.getByRole("alert").count()).toBeLessThanOrEqual(1);
});

for (const locale of ["en", "zh"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`390 px, ${locale}, ${theme}: the salary panel fits without horizontal scroll, its cells stacked`, async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL ?? "http://127.0.0.1" }]);
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await openJob(page, "Forward Deployed", "Forward Deployed Engineer");
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const panel = page.getByTestId("salary-panel");
      await expect(panel.getByTestId("salary-lookup-ai-badge")).toHaveText(locale === "en" ? "AI lookup" : "AI 查询");
      await expect(panel.getByTestId("salary-lookup-confidence")).toContainText(locale === "en" ? "AI's own confidence" : "AI 自评置信度");
      await expect(panel.getByTestId("salary-lookup-scope")).toBeVisible();
      await expect(panel.getByTestId("salary-lookup-origin")).toBeVisible();
      // the three cells stand one under the other
      const first = await panel.getByTestId("salary-head-jd").boundingBox();
      const second = await panel.getByTestId("salary-head-group").boundingBox();
      const third = await panel.getByTestId("salary-head-ai").boundingBox();
      expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height - 1);
      expect(third!.y).toBeGreaterThanOrEqual(second!.y + second!.height - 1);
      // each row's label stands above its track
      const label = await panel.getByTestId("salary-lane-ai").locator("p").first().boundingBox();
      const track = await panel.getByTestId("salary-lane-ai").locator("[data-testid^='salary-track-'], p.border-dashed").first().boundingBox();
      expect(track!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await panel.screenshot({ path: path.resolve(process.env.E2E_SHOTS_DIR ?? "test-results", `salary-panel-390-${locale}-${theme}.png`) });
    });
  }
}
