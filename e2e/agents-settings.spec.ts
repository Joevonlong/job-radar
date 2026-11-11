import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { expect, test, type Page } from "./fixtures";

/**
 * The agent access page (/settings/agents) on the disposable config directory, with the run's web password set
 * (playwright.config.ts). The specs reach the server on 127.0.0.1, so the dashboard opens without a login; changing what agents
 * may do still needs a session. It rewrites mcp.yaml, so it runs in the serial chain. The UI is Chinese by default.
 */
const PASSWORD = process.env.E2E_WEB_PASSWORD ?? "";
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const MCP = path.join(CONFIG_DIR, "mcp.yaml");
const REMOTE = { "x-forwarded-for": "100.64.0.2" };

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  fs.copyFileSync(path.join(DEFAULTS_DIR, "mcp.yaml"), MCP);
});
test.afterAll(() => {
  fs.copyFileSync(path.join(DEFAULTS_DIR, "mcp.yaml"), MCP);
});

async function open(page: Page) {
  await page.goto("/settings/agents");
  await expect(page.getByTestId("agents-page")).toBeVisible();
}

async function signIn(page: Page) {
  await open(page);
  await page.getByTestId("agents-login-password").fill(PASSWORD);
  await page.getByTestId("agents-login-submit").click();
  await expect(page.getByTestId("agents-page")).toHaveAttribute("data-session", "ok");
}

test("on this machine without a session: the sign-in card, every control read-only; signing in there unlocks them", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("agents-page")).toHaveAttribute("data-session", "login_required");
  await expect(page.getByTestId("agents-session-banner")).toBeVisible();
  await expect(page.getByTestId("agents-switch-enabled")).toBeDisabled();
  await expect(page.getByTestId("matrix-jobs:read")).toBeDisabled();
  await expect(page.getByTestId("stdio-edit")).toBeDisabled();

  await page.getByTestId("agents-login-password").fill("not the password");
  await page.getByTestId("agents-login-submit").click();
  await expect(page.getByTestId("agents-login-error")).toHaveText(/\S/);
  await expect(page.getByTestId("agents-page")).toHaveAttribute("data-session", "login_required");

  await page.getByTestId("agents-login-password").fill(PASSWORD);
  await page.getByTestId("agents-login-submit").click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
  await expect(page.getByTestId("agents-session-banner")).toHaveCount(0);
  await expect(page.getByTestId("agents-switch-enabled")).toBeEnabled();
  await expect(page.getByTestId("matrix-jobs:read")).toBeEnabled();
  await expect(page.getByTestId("stdio-edit")).toBeEnabled();
});

test("from elsewhere the page stays behind the normal login", async ({ request }) => {
  const response = await request.get("/settings/agents", { headers: { ...REMOTE, accept: "text/html" }, maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe("/login?next=%2Fsettings%2Fagents");
});

test("matrix: a preset only changes the ticks; narrowing says what it takes, saves only the permissions and keeps the comments", async ({ page }) => {
  await signIn(page);
  const before = fs.readFileSync(MCP, "utf8");
  await page.getByTestId("matrix-preset-all").click();
  await expect(page.getByTestId("matrix-raw:read")).toHaveAttribute("data-state", "checked");
  expect(fs.readFileSync(MCP, "utf8")).toBe(before);
  await page.getByTestId("save-bar").getByRole("button").first().click();
  await expect(page.getByTestId("matrix-raw:read")).toHaveAttribute("data-state", "unchecked");

  await page.getByTestId("matrix-tracking:read").click();
  await expect(page.getByTestId("matrix-impact")).toBeVisible();
  await page.getByTestId("matrix-save").click();
  await expect(page.getByTestId("matrix-tracking:read")).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
  const after = fs.readFileSync(MCP, "utf8");
  const file = parse(after) as { permissions: string[]; stdio: { permissions: string[] } };
  expect(file.permissions).not.toContain("tracking:read");
  expect(file.stdio.permissions).toEqual((parse(before) as typeof file).stdio.permissions);
  for (const line of before.split("\n").filter((text) => text.startsWith("#"))) expect(after).toContain(line);

  await page.reload();
  await expect(page.getByTestId("matrix-tracking:read")).toHaveAttribute("data-state", "unchecked");
  const stdio = page.getByTestId("connection-stdio").getByTestId("permission-pill");
  await expect(stdio.filter({ hasText: "tracking:read" })).toHaveAttribute("data-effective", "false");
});

test("matrix: a save against a file changed elsewhere is refused and the page shows the file as it is", async ({ page }) => {
  await signIn(page);
  fs.writeFileSync(MCP, `${fs.readFileSync(MCP, "utf8")}# changed by hand\n`);
  const changed = fs.readFileSync(MCP, "utf8");
  await page.getByTestId("matrix-raw:read").click();
  await page.getByTestId("matrix-save").click();
  await expect(page.getByTestId("matrix-raw:read")).toHaveAttribute("data-state", "unchecked");
  expect(fs.readFileSync(MCP, "utf8")).toBe(changed);
});

test("the advanced editor points mcp.yaml to this page", async ({ page }) => {
  await page.goto("/settings?tab=advanced&file=mcp");
  await expect(page.getByTestId("agents-note")).toBeVisible();
  await page.goto("/settings");
  await page.getByTestId("tab-agents-link").click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
});

test("390px, light and dark: no horizontal scroll, the matrix keeps its three columns", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await open(page);
    await expect(page.getByTestId("agents-matrix").locator("thead th")).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
