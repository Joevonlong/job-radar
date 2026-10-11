import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { listRows } from "./list-rows";

/**
 * Interests v2 on the seeded e2e database. The run has its own config directory
 * (playwright.config.ts); the tests write interests.yaml there and put the shipped file back at the end.
 * Seed facts used: today's jobs are in Berlin (4), München ("Machine Learning Engineer, Perception"),
 * Frankfurt and "remote"; "Applied Scientist, Clinical NLP" has a T1 and a T2 signal; "Orbitrail AG" is a company.
 * The UI is Chinese by default.
 */

const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const INTERESTS_FILE = path.join(CONFIG_DIR, "interests.yaml");
const SHIPPED_FILE = path.join(process.env.E2E_DEFAULTS_DIR ?? path.resolve(import.meta.dirname, "../tests/fixtures/config/defaults"), "interests.yaml");
const read = (): string => fs.readFileSync(INTERESTS_FILE, "utf8");

const MUNICH_JOB = "Machine Learning Engineer, Perception";

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

const rowCount = (page: Page) => listRows(page).count();

// One config file and one database for all tests of this file: one after another.
test.describe.configure({ mode: "serial" });

test.beforeAll(() => fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE));
test.afterAll(() => fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE));

test("save the /jobs filters as a view: a tab appears on Today and clicking it applies the filter", async ({ page }) => {
  await open(page, "/jobs?city=M%C3%BCnchen");
  await expect(listRows(page).filter({ hasText: MUNICH_JOB })).toBeVisible();

  // nothing to save without filters
  await open(page, "/jobs");
  await expect(page.getByTestId("save-view")).toBeDisabled();

  await open(page, "/jobs?city=M%C3%BCnchen&hideLang=true");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("München ohne Deutsch");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByText("已保存视图「München ohne Deutsch」")).toBeVisible();
  await expect.poll(read).toContain("München ohne Deutsch");
  expect(read()).toMatch(/id: munchen-ohne-deutsch/);
  expect(read()).toMatch(/city: München/);
  expect(read()).toContain("# 保存的筛选视图"); // comments stay

  // the same name again: refused, with a way to overwrite
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("münchen ohne deutsch");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByTestId("save-view-error")).toContainText("已经有同名视图");
  await page.keyboard.press("Escape");

  // Today: tabs "all" + the view
  await open(page, "/");
  const tabs = page.getByTestId("view-tabs");
  await expect(tabs.getByRole("radio", { name: "全部" })).toBeChecked();
  const all = await rowCount(page);
  expect(all).toBeGreaterThanOrEqual(5);

  await tabs.getByRole("radio", { name: "München ohne Deutsch" }).click();
  await expect(page).toHaveURL(/view=munchen-ohne-deutsch/);
  await expect(page.getByTestId("view-tab-munchen-ohne-deutsch")).toHaveAttribute("data-active", "true");
  await expect(listRows(page)).toHaveCount(1);
  await expect(listRows(page).filter({ hasText: MUNICH_JOB })).toBeVisible();
  // the "hide German" toggle that the view carries is on
  await expect(page.getByTestId("toggle-hide-german")).toHaveAttribute("data-active", "true");

  // a reload keeps the view; turning a toggle on top keeps it too; turning the view's own toggle off overrides it
  await page.reload();
  await expect(listRows(page)).toHaveCount(1);
  await page.getByTestId("toggle-hide-german").click();
  await expect(page).toHaveURL(/hideLang=false/);
  await expect(page).toHaveURL(/view=munchen-ohne-deutsch/);
  await expect(page.getByTestId("toggle-hide-german")).toHaveAttribute("data-active", "false");

  await tabs.getByRole("radio", { name: "全部" }).click();
  await expect.poll(() => rowCount(page)).toBe(all);
});

test("a default view is applied on Today without parameters, also after a reload", async ({ page }) => {
  await open(page, "/interests");
  const row = page.getByTestId("view-row").filter({ hasText: "München ohne Deutsch" });
  await expect(row).toContainText("城市：München");
  await expect(row).toContainText("隐藏需德语");
  // Every view carries its last-days sparkline and today's count
  await expect(row.getByTestId("view-trend").getByRole("img")).toBeVisible();
  await expect(row.getByTestId("view-trend-today")).toHaveText(/^今天 \d+$/);
  await row.getByTestId("view-default").click();
  await expect(row).toHaveAttribute("data-default", "true");
  await expect.poll(read).toMatch(/default: true/);

  await open(page, "/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("view-tab-munchen-ohne-deutsch")).toHaveAttribute("data-active", "true");
  await expect(listRows(page)).toHaveCount(1);
  await page.reload();
  await expect(listRows(page)).toHaveCount(1);

  // "all" is still reachable and stays all when a toggle is used
  await page.getByTestId("view-tab-all").click();
  await expect(page).toHaveURL(/view=all/);
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(5);
  await page.getByTestId("toggle-high").click();
  await expect(page).toHaveURL(/view=all/);
  await expect(page).toHaveURL(/high=true/);

  // an explicit toggle without a view parameter ignores the default view
  await open(page, "/?filtered=true");
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(5);

  // un-default, rename and delete
  await open(page, "/interests");
  await row.getByTestId("view-default").click();
  await expect(row).toHaveAttribute("data-default", "false");
  await row.getByRole("button", { name: "重命名 München ohne Deutsch" }).click();
  await page.getByLabel("视图名称").fill("München");
  await page.getByRole("button", { name: "保存名称" }).click();
  const renamed = page.getByTestId("view-row").filter({ hasText: "München" });
  await expect(renamed.getByTestId("view-name")).toHaveText("München");
  await expect.poll(read).toMatch(/name: München\n/);
  await renamed.getByTestId("view-delete").click();
  await renamed.getByTestId("view-delete-confirm").click();
  await expect(page.getByTestId("views-empty")).toBeVisible();
  await expect.poll(read).toMatch(/views: \[\]/);

  // The view switch is always there (built-in quick views with their counts); no saved view is left in it
  await open(page, "/");
  await expect(page.getByTestId("view-tabs")).toBeVisible();
  await expect(page.getByTestId("view-tab-all")).toContainText(/\d+/);
  for (const key of ["quick-high", "quick-salary", "quick-following"]) await expect(page.getByTestId(`view-tab-${key}`)).toBeVisible();
  await expect(page.getByTestId("view-tabs").getByRole("radio")).toHaveCount(4);
});

test("edit a T2 keyword and its weight: the YAML changes and the rank values are recomputed", async ({ page }) => {
  const rank = async () => {
    await open(page, "/jobs?q=Clinical%20NLP");
    const text = await listRows(page).filter({ hasText: "Applied Scientist, Clinical NLP" }).locator("[data-rank]").first().getAttribute("data-rank-value");
    return Number(text);
  };
  const before = await rank();
  expect(before).toBeGreaterThan(0);

  await open(page, "/interests");
  await page.getByTestId("category-toggle-T2").click();
  const t2 = page.getByTestId("category-body-T2");
  await t2.getByLabel("词", { exact: true }).fill("Anteile");
  await t2.getByLabel("词", { exact: true }).press("Enter");
  await expect(t2.getByText("Anteile", { exact: true })).toBeVisible();
  const weight = t2.getByLabel("权重", { exact: true });
  await expect(weight).toHaveValue("8");
  await weight.fill("2");
  await page.getByTestId("vocabulary-save").click();

  const result = page.getByTestId("recompute-result");
  await expect(result).toContainText("已保存。排序值已按新的权重重算");
  await expect(result).toContainText("没有调用 AI");
  await expect(result).toContainText("下一轮采集会重新扫描");
  expect(read()).toMatch(/- id: T2\n(?:.*\n)*?\s+weight: 2\n/);
  expect(read()).toContain("Anteile");
  expect(read()).toContain("# T2：股权或期权"); // comments stay

  // the form is back with the saved values, also after a reload
  await page.reload();
  await page.getByTestId("category-toggle-T2").click();
  await expect(page.getByTestId("category-body-T2").getByLabel("权重", { exact: true })).toHaveValue("2");
  await expect(page.getByTestId("category-body-T2").getByText("Anteile", { exact: true })).toBeVisible();

  // T1 (10) + T2 (2) = 12 points instead of 15 (the cap): 3 points less
  expect(await rank()).toBe(before - 3);

  // an invalid entry is refused, field by field, and nothing is written
  await open(page, "/interests");
  const file = read();
  await page.getByTestId("category-toggle-T3").click();
  await page.getByTestId("category-body-T3").getByLabel("权重", { exact: true }).fill("abc");
  await page.getByTestId("vocabulary-save").click();
  await expect(page.getByText("要填数字")).toBeVisible();
  expect(read()).toBe(file);
});

test("weights: the stepper moves the cells and the cap bar before anything is saved", async ({ page }) => {
  // the default weights (10 + 8 + 3 + 2 + 0 against a cap of 15), whatever an earlier test saved
  fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE);
  await open(page, "/interests");
  const bar = page.getByTestId("cap-bar");
  await expect(bar).toHaveAttribute("data-sum", "23");
  await expect(bar).toHaveAttribute("data-counted", "15");
  await expect(page.getByTestId("cap-overflow")).toBeVisible();
  const before = read();

  await page.getByTestId("category-toggle-T1").click();
  await page.getByRole("button", { name: "具体金额 权重 −1" }).click();
  await page.getByRole("button", { name: "具体金额 权重 −1" }).click();
  await expect(page.getByTestId("category-body-T1").getByLabel("权重", { exact: true })).toHaveValue("8");
  await expect(bar).toHaveAttribute("data-sum", "21");
  await expect(page.getByTestId("category-T1").getByRole("meter")).toHaveAttribute("aria-valuenow", "80");
  await expect(page.getByTestId("save-bar")).toContainText("1 处未保存");
  expect(read()).toBe(before);

  // under the cap nothing is hatched
  await page.getByLabel("加分封顶").fill("30");
  await expect(page.getByTestId("cap-overflow")).toHaveCount(0);
  await expect(bar).toHaveAttribute("data-counted", "21");
});

test("signal categories: add one, order, delete (it hides its signals) and restore", async ({ page }) => {
  fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE);
  const detail = async () => {
    await open(page, "/jobs?q=Clinical%20NLP");
    await page.getByRole("link", { name: /Applied Scientist, Clinical NLP/ }).first().click();
    await expect(page.getByTestId("job-title")).toHaveText("Applied Scientist, Clinical NLP");
  };
  // the seed stores a `visa` signal on this job; no such category yet, so it is not shown
  await detail();
  await expect(page.getByTestId("signal-item")).toHaveCount(2);

  await open(page, "/interests");
  await page.getByTestId("category-add").click();
  const dialog = page.getByTestId("category-add-dialog");
  await expect(dialog.getByTestId("category-add-kind-amount")).toBeDisabled();
  await dialog.getByLabel("类别 id").fill("9visa");
  await dialog.getByTestId("category-add-submit").click();
  await expect(dialog.getByTestId("category-add-id-error")).toContainText("id 格式不对");
  await dialog.getByLabel("类别 id").fill("visa");
  await dialog.getByLabel("中文名称").fill("签证担保");
  await dialog.getByLabel("英文名称").fill("Visa sponsorship");
  // the colour with the keyboard: the radio group moves with the arrow keys
  await dialog.getByRole("radiogroup", { name: "颜色" }).getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("ArrowRight");
  await dialog.getByRole("radio", { name: "紫" }).click();
  await dialog.getByTestId("category-add-submit").click();
  await expect(dialog).toBeHidden();

  const body = page.getByTestId("category-body-visa");
  await body.getByLabel("词", { exact: true }).fill("visa sponsorship");
  await body.getByLabel("词", { exact: true }).press("Enter");
  await body.getByLabel("给 AI 的定义（英文）").fill("the employer sponsors a work visa");
  await body.getByLabel("权重", { exact: true }).fill("4");
  await body.getByTestId("category-high-visa").click();
  await page.getByTestId("category-up-visa").click();
  await page.getByTestId("vocabulary-save").click();
  await expect(page.getByTestId("recompute-result")).toContainText("AI 定义或 AI 类别有改动");
  expect(read()).toMatch(/- id: visa\n\s+kind: keyword\n/);

  await page.reload();
  const ids = await page.getByTestId("category-list").locator("> li").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(ids).toEqual(["category-T1", "category-T2", "category-T3", "category-T4", "category-visa", "category-tag"]);

  // the seeded signal is shown with the new category's name and colour, counted in the bonus
  await detail();
  const visa = page.locator('[data-testid="signal-item"][data-tier="visa"]');
  await expect(visa).toContainText("签证担保");
  await expect(visa.getByTestId("signal-points")).toContainText("+4");
  await expect(page.locator('[data-testid="header-tag"][data-tier="visa"]')).toBeVisible();

  // delete: the dialog says what it hides; the row stays in the database, the page no longer shows it
  await open(page, "/interests");
  await page.getByTestId("category-delete-visa").click();
  const confirm = page.getByTestId("category-delete-dialog");
  await expect(confirm.getByTestId("category-delete-body")).toContainText("1 条信号");
  await expect(confirm.getByTestId("category-delete-body")).toContainText("1 个岗位");
  await confirm.getByTestId("category-delete-confirm").click();
  await expect(page.getByTestId("retired-visa")).toBeVisible();
  await page.getByTestId("vocabulary-save").click();
  await expect(page.getByTestId("recompute-result")).toBeVisible();
  expect(read()).toMatch(/retired_categories:\n\s+- id: visa/);
  await detail();
  await expect(page.locator('[data-testid="signal-item"][data-tier="visa"]')).toHaveCount(0);

  // the id stays taken; restoring brings it back
  await open(page, "/interests");
  await page.getByTestId("category-add").click();
  await page.getByTestId("category-add-dialog").getByLabel("类别 id").fill("VISA");
  await page.getByTestId("category-add-dialog").getByTestId("category-add-submit").click();
  await expect(page.getByTestId("category-add-id-error")).toContainText("已经用过");
  await page.keyboard.press("Escape");
  await page.getByTestId("retired-restore-visa").click();
  await page.getByTestId("vocabulary-save").click();
  await expect(page.getByTestId("recompute-result")).toBeVisible();
  await detail();
  await expect(page.locator('[data-testid="signal-item"][data-tier="visa"]')).toHaveCount(1);
  fs.copyFileSync(SHIPPED_FILE, INTERESTS_FILE);
});

test("the category editor fits a phone and speaks English", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/interests");
  await page.getByTestId("category-toggle-T2").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "en", url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId("category-add")).toHaveText(/Add category/);
  await expect(page.getByTestId("category-T2")).toContainText("Equity");
});

test("watched companies: autocomplete from the companies table, add and remove", async ({ page }) => {
  await open(page, "/interests");
  const card = page.getByTestId("watched-card");
  await expect(card.getByTestId("watched-empty")).toBeVisible();

  await card.getByTestId("watched-input").fill("orbit");
  const option = card.getByRole("option", { name: "Orbitrail AG" });
  await expect(option).toBeVisible();
  await option.click();
  await expect(card.getByTestId("watched-item")).toHaveCount(1);
  await expect(card.getByTestId("watched-item")).toContainText("Orbitrail AG");
  // (whether the entry matches a company row is covered by the integration test: the seed's name keys are not the pipeline's)
  await expect.poll(read).toMatch(/watched_companies:\n {2}- Orbitrail AG\n/);

  // a name the radar has not seen: allowed, flagged as not matched yet; the same company twice is refused
  await card.getByTestId("watched-input").fill("Zukunft GmbH");
  await card.getByTestId("watched-add").click();
  await expect(card.getByTestId("watched-item")).toHaveCount(2);
  await expect(card.getByTestId("watched-item").nth(1)).toContainText("还没有这家公司的岗位");
  await card.getByTestId("watched-input").fill("orbitrail ag");
  await card.getByTestId("watched-add").click();
  await expect(card.getByText("这家公司已经在关注列表里")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("watched-card").getByTestId("watched-item")).toHaveCount(2);
  await page.getByRole("button", { name: "移除 Zukunft GmbH" }).click();
  await page.getByRole("button", { name: "移除 Orbitrail AG" }).click();
  await expect(page.getByTestId("watched-empty")).toBeVisible();
  await expect.poll(read).toMatch(/watched_companies: \[\]/);
});

test("English UI, dark theme and a 390 px screen: no horizontal scroll on /interests, /jobs and Today with tabs", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3145" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });

  await open(page, "/jobs?city=Berlin");
  await expect(page.getByTestId("save-view")).toContainText("Save current filters as view");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Berlin mobile");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByText("Saved view “Berlin mobile”")).toBeVisible();

  for (const url of ["/jobs?city=Berlin", "/", "/interests"]) {
    await open(page, url);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
  await open(page, "/");
  await expect(page.getByTestId("view-tabs").getByRole("radio", { name: "Berlin mobile" })).toBeVisible();
  await open(page, "/interests");
  await expect(page.getByRole("heading", { level: 2, name: "Signal categories and vocabulary" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Saved views" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Watched companies" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Berlin mobile" }).click();
  await page.getByTestId("view-delete-confirm").click();
  await expect(page.getByTestId("views-empty")).toBeVisible();
});

test("a saved view keeps the application status, the minimum score and the minimum salary", async ({ page }) => {
  await open(page, "/jobs?app=interested&app=applied&app=archived&minScore=60&minSalary=70000");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Mein Funnel");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByText("已保存视图「Mein Funnel」")).toBeVisible();
  await expect.poll(read).toContain("Mein Funnel");
  expect(read()).toMatch(/app:\n\s+- interested\n\s+- applied\n\s+- archived/);
  expect(read()).toMatch(/minScore: 60/);
  expect(read()).toMatch(/minSalary: 70000/);

  // the views list names them
  await open(page, "/interests");
  const row = page.getByTestId("view-row").filter({ hasText: "Mein Funnel" });
  await expect(row).toContainText("申请状态：感兴趣、已申请或已忽略");
  await expect(row).toContainText("最低分：≥ 60");
  await expect(row).toContainText("最低年薪：≥ €70k");

  // "open in jobs" restores exactly these filters
  await row.getByRole("link", { name: "在岗位页打开 Mein Funnel" }).click();
  await expect(page).toHaveURL(/app=interested&app=applied&app=archived/);
  await expect(page).toHaveURL(/minScore=60/);
  await expect(page.getByTestId("filter-app-applied")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("filter-min-salary")).toHaveValue("70000");

  // on Today the view applies the same filters: with ignored jobs allowed back in by status, and only ranked ones
  await open(page, "/?view=mein-funnel");
  await expect(page.getByTestId("view-tab-mein-funnel")).toHaveAttribute("data-active", "true");
  for (const status of await listRows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-status")))) {
    expect(["interested", "applied", "archived"]).toContain(status);
  }

  await open(page, "/interests");
  await row.getByTestId("view-delete").click();
  await row.getByTestId("view-delete-confirm").click();
  await expect(page.getByTestId("views-empty")).toBeVisible();
});

test("start a category from a preset, try it on recent jobs, save it", async ({ page }) => {
  await open(page, "/interests");
  await page.getByTestId("category-add").click();
  const dialog = page.getByTestId("category-add-dialog");
  await dialog.getByTestId("category-add-preset").selectOption("ai_tools_budget");
  await expect(dialog.getByTestId("category-add-id")).toHaveValue("ai_tools_budget");
  await expect(dialog.getByTestId("category-add-en")).toHaveValue("AI tools / token budget");
  await dialog.getByTestId("category-add-submit").click();
  await expect(dialog).toBeHidden();

  const body = page.getByTestId("category-body-ai_tools_budget");
  await expect(body.getByTestId("category-ai-ai_tools_budget")).toHaveValue(/employer pays for AI tools/);
  // English plus the market's language: the e2e market is Germany
  await expect(body.getByText("KI-Budget")).toBeVisible();

  // the preview runs the rules only: a word the seeded JDs contain gives hits with quoted examples
  await body.getByLabel("词", { exact: true }).fill("Salary");
  await body.getByLabel("词", { exact: true }).press("Enter");
  await body.getByTestId("category-preview-run-ai_tools_budget").click();
  const result = body.getByTestId("category-preview-result-ai_tools_budget");
  await expect(result).toHaveAttribute("data-status", "ok");
  expect(Number(await result.getAttribute("data-hits"))).toBeGreaterThan(0);
  await expect(result.locator("q").first()).toContainText(/salary/i);
  await expect(body.getByTestId("category-preview-review-ai_tools_budget")).toBeVisible();

  await page.getByTestId("vocabulary-save").click();
  await expect(page.getByTestId("recompute-result")).toBeVisible();
  expect(read()).toContain("id: ai_tools_budget");
  await expect(page.getByTestId("category-ai_tools_budget")).toBeVisible();
});
