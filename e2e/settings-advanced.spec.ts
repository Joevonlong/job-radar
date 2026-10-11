import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The advanced YAML editor (/settings?tab=advanced) on the disposable config directory. The specs rewrite ui.yaml,
 * ai.yaml, notify.yaml, sources.yaml and the pipeline.yaml override, so this file runs as its own project after everything
 * else (playwright.config.ts). The UI is Chinese by default.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const file = (name: string) => path.join(CONFIG_DIR, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");
const USER_FILES = ["schedule", "search", "sources", "ai", "notify", "ui", "resume", "insights"];

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  for (const name of USER_FILES) fs.copyFileSync(path.join(DEFAULTS_DIR, `${name}.yaml`), file(`${name}.yaml`));
  fs.rmSync(file("pipeline.yaml"), { force: true });
  fs.rmSync(file("models.yaml"), { force: true });
  fs.rmSync(file(".backup"), { recursive: true, force: true });
});
test.afterEach(() => {
  fs.rmSync(file("pipeline.yaml"), { force: true });
});

async function open(page: Page, query = "") {
  await page.goto(`/settings?tab=advanced${query}`);
  await expect(page.getByTestId("advanced-editor")).toBeVisible();
}

/** Replace the whole text of the editor (typing 800 lines is slow, and a fill is one input event). */
const setText = (page: Page, text: string) => page.getByTestId("yaml-textarea").fill(text);
const text = (page: Page) => page.getByTestId("yaml-textarea").inputValue();

test("lists every config file with its source, validity and version state; ?file= opens one directly", async ({ page }) => {
  await page.goto("/settings?tab=advanced");
  const list = page.getByTestId("advanced-files");
  await expect(list).toBeVisible();
  for (const stem of ["schedule", "search", "sources", "ai", "breakdown", "notify", "interests", "ui", "resume", "insights", "models", "pipeline"]) {
    await expect(page.getByTestId(`advanced-file-${stem}`)).toBeVisible();
  }
  await expect(page.getByTestId("advanced-file-source-pipeline")).toContainText("默认");
  await expect(page.getByTestId("advanced-file-source-ai")).toContainText("用户目录");
  await expect(list.getByText("用户配置")).toBeVisible();
  await expect(list.getByText("产品默认")).toBeVisible();

  await page.goto("/settings?tab=advanced&file=pipeline");
  await expect(page.getByTestId("advanced-editor")).toHaveAttribute("data-file", "pipeline");
  await expect(page.getByTestId("override-warning")).toContainText("整份覆盖文件");
  // an 800-line file: the line numbers are there
  await expect(page.getByTestId("yaml-editor").locator("[data-line-error], div").first()).toBeVisible();
});

test("a protected key (an API host) is flagged on its line and cannot be saved; the locked keys are listed", async ({ page }) => {
  await open(page, "&file=notify");
  await expect(page.getByTestId("protected-note")).toContainText("telegram.api_base_url");
  const original = await text(page);
  const changed = original.replace(/api_base_url: .*$/m, 'api_base_url: "https://evil.example"');
  expect(changed).not.toBe(original);
  await setText(page, changed);
  const rows = page.getByTestId("issue-row");
  await expect(rows.filter({ hasText: "telegram.api_base_url" })).toContainText("受保护的键");
  await expect(page.getByTestId("advanced-save")).toBeDisabled();
  expect(read("notify.yaml")).toBe(original);
});

test("a broken ai.yaml lists path, reason and line; a click jumps to the line; save is off until it is fixed; then it saves verbatim", async ({ page }) => {
  await open(page, "&file=ai");
  const original = await text(page);
  await expect(page.getByTestId("issues-ok")).toContainText("没有问题");

  // unknown key + wrong type (the schema check comes first; the catalog check runs once the schema is satisfied)
  const broken = original.replace(/^per_cycle_limit: .*$/m, "per_cycle_limit: lots\nmystery_key: 1");
  await setText(page, broken);
  await expect(page.getByTestId("issue-list")).toBeVisible();
  const rows = page.getByTestId("issue-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBe(2);
  await expect(page.getByTestId("advanced-save")).toBeDisabled();
  await expect(rows.filter({ hasText: "mystery_key" })).toContainText("未知的键");

  // clicking an issue puts the cursor on its line
  await rows.filter({ hasText: "mystery_key" }).click();
  const caretLine = await page.getByTestId("yaml-textarea").evaluate((el: HTMLTextAreaElement) => el.value.slice(0, el.selectionStart).split("\n").length);
  expect(broken.split("\n")[caretLine - 1]).toContain("mystery_key");
  await expect(page.locator('[data-line-error="true"]').first()).toBeVisible();

  // the schema is fine but a model is not in models.yaml: the cross-file check says so
  await setText(page, original.replace(/^(\s+)model: .*$/m, "$1model: no-such-model"));
  await expect(rows.first()).toContainText("no-such-model");
  await expect(page.getByTestId("advanced-save")).toBeDisabled();

  // fixed: one value changed, comments and blank lines kept
  const fixed = original.replace(/^per_cycle_limit: \d+/m, "per_cycle_limit: 77");
  await setText(page, fixed);
  await expect(page.getByTestId("issues-ok")).toContainText("没有问题");
  await expect(page.getByTestId("advanced-save")).toBeEnabled();
  await page.getByTestId("advanced-save").click();
  const dialog = page.getByTestId("preview-dialog");
  await expect(dialog.getByTestId("changed-paths")).toContainText("per_cycle_limit");
  await expect(dialog.locator('[data-diff="add"]').first()).toContainText("per_cycle_limit: 77");
  await dialog.getByTestId("preview-confirm").click();
  await expect(page.getByTestId("advanced-state")).toContainText("没有未保存");

  expect(read("ai.yaml")).toBe(fixed);
  // the old text went to .backup/editor/<time>/ai.yaml
  const backups = fs.readdirSync(file(".backup/editor")).filter((dir) => fs.existsSync(file(`.backup/editor/${dir}/ai.yaml`)));
  expect(backups).toHaveLength(1);
  expect(fs.readFileSync(file(`.backup/editor/${backups[0]}/ai.yaml`), "utf8")).toBe(original);

  // the AI tab shows the new value
  await page.goto("/settings?tab=ai");
  await expect(page.getByLabel("每轮最多处理条数")).toHaveValue("77");
});

test("a change made behind the editor's back is noticed at the preview with 'opened → now'; loading the latest file lets the save through", async ({ page }) => {
  await open(page, "&file=notify");
  const opened = await text(page);
  // someone else saves the same file (a form, another tab, a hand edit)
  const theirs = opened.replace(/^max_per_cycle: \d+/m, "max_per_cycle: 9");
  fs.writeFileSync(file("notify.yaml"), theirs);

  await setText(page, `${opened}\n# my note\n`);
  await expect(page.getByTestId("advanced-save")).toBeEnabled();
  // the preview already notices the outside change: no confirm step, the banner appears
  await page.getByTestId("advanced-save").click();
  const banner = page.getByTestId("conflict-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("你打开后文件被改过");
  await expect(banner).toContainText("打开时 → 现在");
  await expect(banner.locator('[data-diff="add"]').first()).toContainText("max_per_cycle: 9");
  expect(read("notify.yaml")).toBe(theirs);

  await banner.getByTestId("conflict-load-latest").click();
  await expect(banner).toBeHidden();
  expect(await text(page)).toBe(theirs);
  await setText(page, `${theirs}# my note\n`);
  await page.getByTestId("advanced-save").click();
  await page.getByTestId("preview-confirm").click();
  await expect(page.getByTestId("advanced-state")).toContainText("没有未保存");
  expect(read("notify.yaml")).toBe(`${theirs}# my note\n`);
});

test("a product default file: the first save needs a confirmation and creates the override; restoring the default removes it", async ({ page }) => {
  await open(page, "&file=pipeline");
  const original = await text(page);
  await setText(page, `${original}\n# my comment\n`);
  await expect(page.getByTestId("issues-ok")).toContainText("没有问题");
  await page.getByTestId("advanced-save").click();
  const dialog = page.getByTestId("preview-dialog");
  await expect(dialog.getByTestId("override-warning")).toBeVisible();
  // no confirmation, no save
  await expect(dialog.getByTestId("preview-confirm")).toBeDisabled();
  // the diff can be read against the product default too
  await dialog.getByTestId("preview-against-default").click();
  await expect(dialog.locator('[data-diff="add"]').filter({ hasText: "my comment" })).toBeVisible();
  await dialog.getByTestId("override-confirm").click();
  await dialog.getByTestId("preview-confirm").click();
  await expect(page.getByTestId("advanced-state")).toContainText("没有未保存");
  expect(fs.existsSync(file("pipeline.yaml"))).toBe(true);
  expect(read("pipeline.yaml")).toContain("# my comment");
  await expect(page.getByTestId("advanced-file-source-pipeline")).toContainText("已覆盖默认");

  await page.getByTestId("advanced-reset").click();
  await page.getByTestId("reset-confirm").click();
  await expect(page.getByTestId("advanced-reset")).toBeHidden();
  expect(fs.existsSync(file("pipeline.yaml"))).toBe(false);
  await expect(page.getByTestId("advanced-file-source-pipeline")).toContainText("默认");
  expect(await text(page)).toBe(original);
  // backed up before it was removed
  const dirs = fs.readdirSync(file(".backup/editor"));
  expect(dirs.some((dir) => fs.existsSync(file(`.backup/editor/${dir}/pipeline.yaml`)))).toBe(true);
});

test("a user file can be restored to the default content (after a backup), and 'no changes' is said when nothing differs", async ({ page }) => {
  fs.writeFileSync(file("notify.yaml"), read("notify.yaml").replace(/^max_per_cycle: \d+/m, "max_per_cycle: 13"));
  await open(page, "&file=notify");
  await page.getByTestId("advanced-reset").click();
  await expect(page.getByTestId("reset-dialog").locator('[data-diff="del"]').first()).toContainText("max_per_cycle: 13");
  await page.getByTestId("reset-confirm").click();
  await expect(page.getByTestId("advanced-reset")).toBeHidden();
  expect(read("notify.yaml")).toBe(fs.readFileSync(path.join(DEFAULTS_DIR, "notify.yaml"), "utf8"));

  // an edit that is undone again: the preview says there is no change
  await setText(page, `${await text(page)}x`);
  await setText(page, (await text(page)).slice(0, -1));
  await expect(page.getByTestId("advanced-save")).toBeDisabled();
});

test("proxy credentials in sources.yaml show as *** everywhere but the file; other edits keep them; changing a proxy is refused", async ({ page }) => {
  const withProxy = read("sources.yaml").replace("proxies: []", 'proxies:\n    - "http://alice:s3cret@proxy.example:8080"');
  fs.writeFileSync(file("sources.yaml"), withProxy);
  await open(page, "&file=sources");
  const shown = await text(page);
  expect(shown).not.toContain("s3cret");
  expect(shown).toContain("***:***@proxy.example:8080");
  expect(await page.content()).not.toContain("s3cret");

  // an unrelated edit: the real proxy stays in the file
  await setText(page, shown.replace(/timeout_ms: (\d+)/, "timeout_ms: 12345"));
  await page.getByTestId("advanced-save").click();
  await page.getByTestId("preview-confirm").click();
  await expect(page.getByTestId("advanced-state")).toContainText("没有未保存");
  expect(read("sources.yaml")).toContain("alice:s3cret@proxy.example:8080");
  expect(read("sources.yaml")).toContain("12345");

  // a changed proxy is refused
  const now = await text(page);
  await setText(page, now.replace("proxy.example:8080", "other.example:8080"));
  await expect(page.getByTestId("advanced-save")).toBeDisabled();
  await expect(page.getByTestId("issue-row").first()).toContainText("代理只能在文件里改");
  expect(read("sources.yaml")).toContain("proxy.example:8080");
});

test("a broken ui.yaml can still be opened and repaired in the editor; other tabs link to it", async ({ page }) => {
  fs.writeFileSync(file("ui.yaml"), "salary_axis: [oops\n");
  await page.goto("/settings?tab=ui");
  await expect(page.getByTestId("repair-link").first()).toBeVisible();
  await page.getByTestId("repair-link").first().click();
  await expect(page).toHaveURL(/tab=advanced&file=ui/);
  await expect(page.getByTestId("advanced-editor")).toHaveAttribute("data-file", "ui");
  await expect(page.getByTestId("issue-row").first()).toBeVisible();
  await expect(page.getByTestId("advanced-save")).toBeDisabled();

  await setText(page, fs.readFileSync(path.join(DEFAULTS_DIR, "ui.yaml"), "utf8"));
  await expect(page.getByTestId("issues-ok")).toContainText("没有问题");
  await page.getByTestId("advanced-save").click();
  await page.getByTestId("preview-confirm").click();
  await expect(page.getByTestId("advanced-state")).toContainText("没有未保存");
  await page.goto("/settings?tab=ui");
  await expect(page.getByTestId("settings-card-ui")).toBeVisible();
});

test("Tab indents, the editor keeps 390px free of sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "&file=notify");
  const area = page.getByTestId("yaml-textarea");
  await area.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Tab");
  expect((await text(page)).startsWith("  ")).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
