import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";
import { parse, parseDocument } from "yaml";

/**
 * /sources/registry against the disposable database (seed: xing breaker open, greenhouse ok, three boards with a
 * check record) and a private copy of config/. The UI is Chinese by default.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const SOURCES = path.join(CONFIG_DIR, "sources.yaml");
const read = () => fs.readFileSync(SOURCES, "utf8");

// One config directory: run the tests one after another.
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  fs.copyFileSync(path.join(process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults"), "sources.yaml"), SOURCES);
});

/** The shipped file has xing switched off; the seeded breaker only shows on an enabled channel. */
function enableXing() {
  fs.writeFileSync(SOURCES, read().replace(/(  xing:\n    enabled: )false/, "$1true"));
}

/** Set keys of the private sources.yaml (comments stay): the test says what it needs instead of trusting the shipped file. */
function setKeys(values: Record<string, unknown>) {
  const doc = parseDocument(read());
  for (const [key, value] of Object.entries(values)) doc.setIn(key.split("."), value);
  fs.writeFileSync(SOURCES, String(doc));
}

async function open(page: Page, query = "") {
  await page.goto(`/sources/registry${query}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "来源清单" })).toBeVisible();
}

const row = (page: Page, id: string) => page.locator(`[data-testid="registry-row"][data-id="${id}"]`);

test("every channel and board shows with its state and a reason; the summary adds up; the sub navigation links both pages", async ({ page }) => {
  enableXing();
  await open(page);
  await expect(page.getByTestId("channels-count")).toHaveText("21");
  await expect(page.locator('[data-testid="registry-row"][data-kind="channel"]')).toHaveCount(21);
  await expect(row(page, "xing")).toHaveAttribute("data-status", "failing");
  await expect(row(page, "xing").getByTestId("reason")).toContainText("被网站拦截");
  await expect(row(page, "greenhouse")).toHaveAttribute("data-status", "ok");
  await expect(row(page, "board:greenhouse:zellwerk")).toHaveAttribute("data-status", "ok");
  await expect(row(page, "board:greenhouse:gegensprech")).toHaveAttribute("data-status", "failing");
  await expect(row(page, "board:greenhouse:gegensprech").getByTestId("reason")).toContainText("连续 3 次失败");
  await expect(row(page, "board:greenhouse:werbenetz")).toHaveAttribute("data-status", "degraded");
  await expect(row(page, "board:greenhouse:datenhaus")).toHaveAttribute("data-status", "never_run");

  const total = await page.getByTestId("registry-row").count();
  let sum = 0;
  for (const status of ["ok", "degraded", "failing", "off", "not_configured", "never_run", "standby"]) {
    const shown = Number(await page.getByTestId(`summary-${status}`).getAttribute("data-count"));
    expect(await page.locator(`[data-testid="registry-row"][data-status="${status}"]`).count()).toBe(shown);
    sum += shown;
  }
  expect(sum).toBe(total);

  await expect(page.getByTestId("subnav-registry")).toHaveAttribute("aria-current", "location");
  await page.getByTestId("subnav-overview").click();
  await expect(page).toHaveURL(/\/sources$/);
  await expect(page.getByTestId("subnav-overview")).toHaveAttribute("aria-current", "location");
});

test("filters: a summary block, the type, the text; they live in the URL and survive a reload; unknown values are ignored", async ({ page }) => {
  enableXing();
  await open(page);
  await page.getByTestId("summary-failing").click();
  await expect(page).toHaveURL(/status=failing/);
  await expect(page.getByTestId("registry-row")).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("registry-row")).toHaveCount(2);
  await expect(page.getByTestId("summary-failing")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("summary-failing").click();
  await expect(page).not.toHaveURL(/status=/);

  await page.getByTestId("type-ats_board").click();
  await expect(page).toHaveURL(/type=ats_board/);
  await expect(page.getByTestId("channels-table")).toHaveCount(0);
  await page.getByTestId("registry-search").fill("zellwerk");
  await expect(page.getByTestId("registry-row")).toHaveCount(1);
  await expect(page).toHaveURL(/q=zellwerk/);

  await open(page, "?type=nonsense&status=nope&status=failing&ats=workday");
  await expect(page.getByTestId("type-all")).toBeChecked();
  await expect(page.locator('[data-testid="registry-row"]').first()).toHaveAttribute("data-status", "failing");
});

test("switching a board off and on changes only its line in sources.yaml", async ({ page }) => {
  await open(page, "?type=ats_board&q=zellwerk");
  const before = read();
  await row(page, "board:greenhouse:zellwerk").getByTestId("enabled-switch").click();
  await expect(row(page, "board:greenhouse:zellwerk")).toHaveAttribute("data-status", "off");
  const after = read();
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  expect(a.filter((line, i) => line !== b[i])).toHaveLength(1);
  expect(after).toContain('{ name: "Zellwerk", ats: greenhouse, token: "zellwerk", enabled: false }');
  expect(after).toContain("# 熔断：连续失败 failures 次后");
  await row(page, "board:greenhouse:zellwerk").getByTestId("enabled-switch").click();
  await expect(row(page, "board:greenhouse:zellwerk")).toHaveAttribute("data-status", "ok");
  expect(read()).toBe(before);
});

test("a channel switch writes its enabled key", async ({ page }) => {
  await open(page, "?type=channel&q=indeed");
  await row(page, "indeed").getByTestId("enabled-switch").click();
  await expect(row(page, "indeed")).toHaveAttribute("data-status", "off");
  const doc = parse(read()) as { sources: { indeed: { enabled: boolean } } };
  expect(doc.sources.indeed.enabled).toBe(false);
});

test("switching a scraping channel on asks for the terms-of-service confirmation; cancel leaves it off", async ({ page }) => {
  const indeedEnabled = () => (parse(read()) as { sources: { indeed: { enabled: boolean } } }).sources.indeed.enabled;
  await open(page, "?type=channel&q=indeed");
  const toggle = row(page, "indeed").getByTestId("enabled-switch");
  // off needs no confirmation
  await toggle.click();
  await expect(row(page, "indeed")).toHaveAttribute("data-status", "off");
  expect(indeedEnabled()).toBe(false);
  // on opens the dialog; cancel writes nothing and the switch springs back
  await toggle.click();
  await expect(page.getByTestId("consent-dialog")).toBeVisible();
  await expect(page.getByTestId("consent-dialog").getByTestId("doc-link-scraping")).toHaveAttribute("href", /\/blob\/v\d+\.\d+\.\d+[^/]*\/docs\/sources(\.zh)?\.md#/);
  await page.getByTestId("consent-cancel").click();
  await expect(page.getByTestId("consent-dialog")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("data-state", "unchecked");
  expect(indeedEnabled()).toBe(false);
  // confirm writes it
  await toggle.click();
  await page.getByTestId("consent-confirm").click();
  await expect(page.getByTestId("consent-dialog")).toHaveCount(0);
  await expect(row(page, "indeed")).not.toHaveAttribute("data-status", "off");
  expect(indeedEnabled()).toBe(true);
});

test("add a company (a duplicate is refused under its field), edit it, delete it", async ({ page }) => {
  await open(page, "?type=ats_board");
  await page.getByTestId("board-add").click();
  const dialog = page.getByTestId("board-dialog");
  await dialog.getByTestId("board-name").fill("Zellwerk Two");
  await dialog.getByTestId("board-token").fill("ZELLWERK");
  await dialog.getByTestId("board-save").click();
  await expect(dialog.getByTestId("board-error-token")).toBeVisible();
  await dialog.getByTestId("board-token").fill("e2e-newco");
  await dialog.getByTestId("board-ats").selectOption("ashby");
  await dialog.getByTestId("board-save").click();
  await expect(dialog).toHaveCount(0);
  expect(read()).toContain('name: Zellwerk Two');
  await expect(row(page, "board:ashby:e2e-newco")).toHaveAttribute("data-status", "never_run");

  await row(page, "board:ashby:e2e-newco").getByTestId("board-edit").click();
  await page.getByTestId("board-token").fill("e2e-newco2");
  await expect(page.getByTestId("board-key-changed")).toBeVisible();
  await page.getByTestId("board-save").click();
  await expect(row(page, "board:ashby:e2e-newco2")).toBeVisible();
  expect(read()).not.toContain("e2e-newco\n");

  await row(page, "board:ashby:e2e-newco2").getByTestId("board-delete").click();
  await page.getByTestId("board-delete-confirm").click();
  await expect(row(page, "board:ashby:e2e-newco2")).toHaveCount(0);
  expect(read()).not.toContain("e2e-newco2");
  expect(read()).toContain("# ATS 公司清单");
});

test("export YAML is the file; an import that switches indeed off previews, applies and shows in the table; the JSON export re-imports without a diff", async ({ page }) => {
  await open(page);
  const yaml = await (await page.request.get("/sources/registry/export?format=yaml")).text();
  expect(yaml).toContain("# 来源清单：");
  expect(yaml).toContain("ats_boards:");
  const json = await (await page.request.get("/sources/registry/export?format=json")).text();
  expect((JSON.parse(json) as { ats_boards: unknown[] }).ats_boards.length).toBeGreaterThan(100);

  // JSON round trip: no difference
  await page.getByTestId("import-open").click();
  const dialog = page.getByTestId("import-dialog");
  await dialog.getByTestId("import-file").setInputFiles({ name: "sources.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await dialog.getByTestId("import-preview").click();
  await expect(dialog.getByTestId("import-no-changes")).toBeVisible();
  await expect(dialog.getByTestId("import-apply")).toBeDisabled();

  // a file that switches indeed off
  const edited = parse(yaml) as { sources: { indeed: { enabled: boolean } } };
  edited.sources.indeed.enabled = false;
  await dialog.getByTestId("import-file").setInputFiles({ name: "sources.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(edited)) });
  await dialog.getByTestId("import-preview").click();
  await expect(dialog.getByTestId("import-summary")).toContainText("停用 1 个通道");
  await expect(dialog.getByTestId("import-note-proxiesKept")).toBeVisible();
  await dialog.getByTestId("import-apply").click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "indeed")).toHaveAttribute("data-status", "off");
  expect((parse(read()) as { sources: { indeed: { enabled: boolean } } }).sources.indeed.enabled).toBe(false);
});

test("an import with an error lists the path and cannot be applied", async ({ page }) => {
  await open(page);
  await page.getByTestId("import-open").click();
  const dialog = page.getByTestId("import-dialog");
  await dialog.getByTestId("import-text").fill("{\"paid_total_monthly_budget_usd\": -1}");
  await dialog.getByTestId("import-preview").click();
  await expect(dialog.getByTestId("import-errors")).toBeVisible();
  await expect(dialog.getByTestId("import-apply")).toBeDisabled();
});

test("edit settings opens the channel's section on the settings page", async ({ page }) => {
  await open(page, "?type=channel&q=greenhouse");
  await row(page, "greenhouse").getByTestId("edit-params").click();
  await expect(page).toHaveURL(/\/settings\?tab=channels&section=greenhouse/);
  await expect(page.getByTestId("section-greenhouse")).toHaveJSProperty("open", true);
  await expect(page.getByTestId("section-greenhouse")).toBeInViewport();
  await expect(page.getByTestId("registry-link")).toBeVisible();
});

test("390px, English, dark: cards, no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "en", url: page.url() === "about:blank" ? "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3100") : page.url() }]);
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.goto("/sources/registry");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "Source registry" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const first = row(page, "greenhouse");
  await expect(first.getByTestId("window")).toBeHidden();
  await first.getByTestId("row-details-toggle").click();
  await expect(first.getByTestId("window")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the recommended read is locked while linkedin-session is off, and works when it is on", async ({ page }) => {
  setKeys({ "linkedin.session.enabled": false, "linkedin.session.recommended_daily": true });
  await open(page, "?type=channel&q=recommended");
  const rec = row(page, "linkedin-session:recommended");
  await expect(rec.getByTestId("enabled-switch")).toBeDisabled();
  await expect(rec.getByTestId("reason")).toContainText("linkedin-session 通道已关闭");
  await expect(rec).toHaveAttribute("data-status", "off");
  const before = read();

  setKeys({ "linkedin.session.enabled": true });
  await open(page, "?type=channel&q=recommended");
  const on = row(page, "linkedin-session:recommended");
  await expect(on.getByTestId("enabled-switch")).toBeEnabled();
  await on.getByTestId("enabled-switch").click();
  await expect(on).toHaveAttribute("data-enabled", "0");
  expect((parse(read()) as { linkedin: { session: { recommended_daily: boolean } } }).linkedin.session.recommended_daily).toBe(false);
  expect(read()).not.toBe(before);
});

test("an id breaks only after a colon or a slash", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "?type=channel&q=linkedin");
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="registry-row"] [data-testid="row-id"] > span')].filter((part) => part.getClientRects().length > 1).map((part) => part.textContent),
  );
  expect(broken).toEqual([]);
});

test("the deep link shows the section title below the top bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/settings?tab=channels&section=lever");
  await page.waitForLoadState("networkidle");
  const section = page.getByTestId("section-lever");
  await expect(section).toHaveJSProperty("open", true);
  await page.waitForTimeout(800);
  const gap = await page.evaluate(() => {
    const bar = document.querySelector("header");
    const title = document.querySelector('[data-testid="section-lever"] summary');
    return title && bar ? title.getBoundingClientRect().top - bar.getBoundingClientRect().bottom : -1;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
});

test("at 390px the import dialog fits the screen, with a long preview too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByTestId("import-open").click();
  const dialog = page.getByTestId("import-dialog");
  const edited = parse(read()) as { sources: { indeed: { enabled: boolean } }; ats_boards: Array<{ name: string; token: string }> };
  edited.sources.indeed.enabled = false;
  edited.ats_boards = edited.ats_boards.slice(1);
  await dialog.getByTestId("import-text").fill(JSON.stringify(edited));
  await dialog.getByTestId("import-preview").click();
  await expect(dialog.getByTestId("import-summary")).toBeVisible();
  const fit = await dialog.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { left: box.left, right: box.right, overflow: el.scrollWidth - el.clientWidth, viewport: window.innerWidth };
  });
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.viewport);
  expect(fit.overflow).toBeLessThanOrEqual(0);
});
