import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";

// playwright.config.ts points the web server at this directory (and a disposable database).
const PROFILE_DIR = process.env.E2E_PROFILE_DIR ?? "";
const ME_FILE = path.join(PROFILE_DIR, "me.yaml");
const PREFS_FILE = path.join(PROFILE_DIR, "preferences.yaml");

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function open(page: Page) {
  await page.goto("/me");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "我的画像" })).toBeVisible();
}

// The tests share one profile directory and one database: run them one after another.
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  // Start every test from the shipped template in memory; the first save creates the file from it.
  fs.rmSync(ME_FILE, { force: true });
  fs.rmSync(PREFS_FILE, { force: true });
});

test("edit, save and roll back the preferences; the YAML keeps its comments", async ({ page }) => {
  await open(page);
  const prefs = page.getByTestId("preferences-card");
  const me = page.getByTestId("me-card");

  // Baseline save (Save is off while nothing changed): one harmless edit records a first version in the history.
  await prefs.getByLabel("排除的公司").fill("BaselineCo");
  await prefs.getByLabel("排除的公司").press("Enter");
  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存")).toBeVisible();
  await expect.poll(() => read(PREFS_FILE)).toContain("# 年薪底线");
  const baseline = read(PREFS_FILE);

  // Language level (about me), excluded keyword and salary floor (what I want).
  await me.getByRole("combobox", { name: "等级" }).nth(1).selectOption("C1");
  await me.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => read(ME_FILE)).toMatch(/de: C1/);
  expect(read(ME_FILE)).toContain("# 每种语言一行");

  await prefs.getByLabel("排除的关键词").fill("Praktikum");
  await prefs.getByLabel("排除的关键词").press("Enter");
  await expect(prefs.getByText("Praktikum", { exact: true })).toBeVisible();
  await prefs.getByLabel("年薪底线").fill("85000");
  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => read(PREFS_FILE)).toMatch(/salary_floor_year: 85000/);
  const edited = read(PREFS_FILE);
  expect(edited).toContain("Praktikum");
  expect(edited).toContain("# 年薪底线");

  // Values survive a reload.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("preferences-card").getByLabel("年薪底线")).toHaveValue("85000");
  await expect(page.getByTestId("preferences-card").getByText("Praktikum", { exact: true })).toBeVisible();
  await expect(page.getByTestId("me-card").getByRole("combobox", { name: "等级" }).nth(1)).toHaveValue("C1");

  // History: the newest entry is current and shows what changed.
  // The file is written first and its snapshot recorded right after: the YAML poll above can pass a moment before the
  // snapshot row exists, and a reload in that gap lists the previous snapshot as newest. Reload until the history has caught up.
  const history = page.getByTestId("history-card");
  const items = history.getByTestId("history-item");
  await expect(async () => {
    await page.reload();
    await page.waitForLoadState("networkidle");
    await history.getByRole("button", { name: "我要什么" }).click();
    await expect(items.first()).toHaveAttribute("data-current", "true", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await items.first().getByRole("button", { name: "查看差异" }).click();
  await expect(items.first().locator('[data-diff="add"]').filter({ hasText: "salary_floor_year: 85000" })).toBeVisible();
  await expect(items.first().locator('[data-diff="del"]').filter({ hasText: "salary_floor_year: 70000" })).toBeVisible();

  // Roll back to the baseline: the file is restored.
  await items.nth(1).getByRole("button", { name: "回滚到此版本" }).click();
  await expect(page.getByText("已回滚")).toBeVisible();
  await expect.poll(() => read(PREFS_FILE)).toBe(baseline);
  await expect(page.getByTestId("preferences-card").getByLabel("年薪底线")).toHaveValue("70000");
  await expect(history.getByTestId("history-item").first()).toHaveAttribute("data-current", "true");
});

test("a repeated target title is refused with a notice, the text stays, and Enter does not submit", async ({ page }) => {
  await open(page);
  const prefs = page.getByTestId("preferences-card");
  const titles = prefs.getByLabel("目标职位", { exact: true });
  const box = titles.locator("..");
  const chips = box.locator('[data-slot="filter-chip"]');
  const before = await chips.count();
  expect(before).toBeGreaterThan(0);

  await titles.fill("ai engineer");
  await titles.press("Enter");
  await expect(chips).toHaveCount(before);
  await expect(titles).toHaveValue("ai engineer");
  await expect(box.getByTestId("tag-duplicate")).toHaveText("已在列表里：AI Engineer");
  await expect(box.locator("[data-highlighted]")).toContainText("AI Engineer");
  // nothing was saved by the Enter key
  await expect(prefs.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

  // typing on clears the notice; a new title is added as usual
  await titles.fill("Data Platform Engineer");
  await expect(box.getByTestId("tag-duplicate")).toHaveText("");
  await titles.press("Enter");
  await expect(chips).toHaveCount(before + 1);
  await expect(titles).toHaveValue("");
});

test("saving right after typing a new title keeps it; a repeated one is dropped and the other edits still save", async ({ page }) => {
  await open(page);
  const prefs = page.getByTestId("preferences-card");
  const titles = prefs.getByLabel("目标职位", { exact: true });
  const saveButton = prefs.getByRole("button", { name: "保存", exact: true });

  // another field changed, then a new title typed and Save clicked without Enter
  await prefs.getByLabel("年薪底线").fill("86000");
  await titles.fill("Staff ML Engineer");
  await saveButton.click();
  await expect.poll(() => read(PREFS_FILE)).toMatch(/salary_floor_year: 86000/);
  expect(read(PREFS_FILE)).toContain("Staff ML Engineer");

  // a repeat typed this time: not added again, the salary edit still goes through
  await page.reload();
  await page.waitForLoadState("networkidle");
  await prefs.getByLabel("年薪底线").fill("87000");
  await titles.fill("staff ml engineer");
  await saveButton.click();
  await expect.poll(() => read(PREFS_FILE)).toMatch(/salary_floor_year: 87000/);
  const saved = read(PREFS_FILE);
  expect(saved.match(/Staff ML Engineer/gi)).toHaveLength(1);
});

test("floor preview: dragging the slider moves the count live and writes nothing until Save", async ({ page }) => {
  await open(page);
  const prefs = page.getByTestId("preferences-card");
  const before = fs.existsSync(PREFS_FILE) ? read(PREFS_FILE) : "";
  const preview = prefs.getByTestId("floor-preview");
  const drop = preview.getByTestId("floor-drop");
  const total = Number(await drop.getAttribute("data-total"));
  expect(total).toBeGreaterThan(0);
  const filteredAt = async (floor: number) => {
    await prefs.getByLabel("年薪底线").fill(String(floor));
    return Number(await drop.getAttribute("data-filtered"));
  };
  const low = await filteredAt(30_000);
  const high = await filteredAt(500_000);
  expect(low).toBe(0);
  expect(high).toBeGreaterThan(low);
  await expect(drop).toContainText(`会过滤掉 ${high} / ${total} 个本月写明薪资的岗位`);

  // the slider edits the field; the file is untouched
  await preview.getByRole("slider", { name: "拖动试试" }).fill("90000");
  await expect(prefs.getByLabel("年薪底线")).toHaveValue("90000");
  await expect(preview.getByTestId("floor-value")).toHaveText("€90k");
  expect(Number(await drop.getAttribute("data-filtered"))).toBe(await filteredAt(90_000));
  expect(fs.existsSync(PREFS_FILE) ? read(PREFS_FILE) : "").toBe(before);

  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => read(PREFS_FILE)).toMatch(/salary_floor_year: 90000/);
});

test("invalid input shows a field error and leaves the file unchanged", async ({ page }) => {
  await open(page);
  const prefs = page.getByTestId("preferences-card");
  // Capture the current text (empty before the first save).
  const before = read(PREFS_FILE);

  const salary = prefs.getByLabel("年薪底线");
  await salary.fill("-5");
  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect(prefs.getByRole("alert")).toHaveText("不能小于 0");
  await expect(salary).toHaveAttribute("aria-invalid", "true");
  expect(read(PREFS_FILE)).toBe(before);
  await expect(page.getByText("已保存")).toHaveCount(0);

  // Fixing the value and saving again works.
  await salary.fill("72000");
  await prefs.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => read(PREFS_FILE)).toMatch(/salary_floor_year: 72000/);
  await expect(prefs.getByRole("alert")).toHaveCount(0);
});

test("a language row with a bad code reports the error on that row", async ({ page }) => {
  await open(page);
  const me = page.getByTestId("me-card");
  const before = read(ME_FILE);
  await me.getByRole("button", { name: "添加语言" }).click();
  await me.getByRole("button", { name: "保存", exact: true }).click();
  await expect(me.getByRole("alert")).toContainText("语言代码");
  expect(read(ME_FILE)).toBe(before);
});

test("an incomplete profile is announced on Today and /me until a summary is saved", async ({ page }) => {
  // the shipped template has neither a summary nor skills
  await open(page);
  const meBanner = page.getByTestId("profile-incomplete-banner");
  await expect(meBanner).toContainText("画像不完整，AI 打分已暂停");
  await expect(meBanner).toContainText("缺少：简介（summary）、技能（skills）");

  await page.goto("/");
  const todayBanner = page.getByTestId("profile-incomplete-banner");
  await expect(todayBanner).toContainText("画像不完整，AI 打分已暂停");
  await todayBanner.getByRole("link", { name: "去填写画像" }).click();
  await expect(page).toHaveURL(/\/me$/);

  const me = page.getByTestId("me-card");
  await me.getByLabel("给 AI 的简介").fill("Senior ML engineer, LLM systems.");
  await me.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => read(ME_FILE)).toContain("Senior ML engineer");
  await expect(page.getByTestId("profile-incomplete-banner")).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("profile-incomplete-banner")).toHaveCount(0);
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the profile page fits the viewport in Chinese and English, dark and light", async ({ page }) => {
    await open(page);
    const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
    expect(await scrollWidth()).toBeLessThanOrEqual(390);
    await expect(page.getByTestId("me-card")).toBeVisible();
    await expect(page.getByTestId("history-card")).toBeVisible();

    await page.getByRole("button", { name: "切换深浅主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await scrollWidth()).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "切换语言" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "My profile" })).toBeVisible();
    await expect(page.getByTestId("preferences-card").getByLabel("Salary floor (EUR per year, gross)")).toBeVisible();
    expect(await scrollWidth()).toBeLessThanOrEqual(390);
  });
});
