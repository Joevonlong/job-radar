import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

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

const manifestSchema = z.object({ node: z.record(z.string(), z.object({ filename: z.string().optional(), exportedName: z.string().optional() })) });

/** The id the production build gave a Server Action of the agent access page (the build the run serves, in .next). */
function actionId(name: string): string {
  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(path.resolve(".next/server/server-reference-manifest.json"), "utf8")));
  const entry = Object.entries(manifest.node).find(([, value]) => value.filename === "src/app/settings/agents/actions.ts" && value.exportedName === name);
  if (!entry) throw new Error(`no Server Action ${name} in the build`);
  return entry[0];
}

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

test("on this machine without a session, a Server Action posted by hand past the page is refused and mcp.yaml stays as it was", async ({ page }) => {
  await open(page);
  const before = fs.readFileSync(MCP, "utf8");
  const calls = [
    ["setAgentSwitchAction", { key: "http", value: true }],
    ["saveAgentMatrixAction", { permissions: ["jobs:read", "config:write"], baseHash: "0" }],
    ["saveStdioPermissionsAction", { permissions: ["jobs:read"], baseHash: "0" }],
    ["createAgentTokenAction", { name: "sneaky", permissions: ["jobs:read"], expires: null }],
    ["revokeAgentTokenAction", { id: 1 }],
  ] as const;
  for (const [name, argument] of calls) {
    const answer = await page.evaluate(
      async ({ id, body }) => {
        const response = await fetch("/settings/agents", { method: "POST", headers: { "next-action": id, accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body });
        return { status: response.status, text: await response.text() };
      },
      { id: actionId(name), body: JSON.stringify([argument]) },
    );
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('"status":"session_required"');
  }
  expect(fs.readFileSync(MCP, "utf8")).toBe(before);
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

test("tokens: the seeded ones are listed; create shows the token once, then only its prefix; revoke refuses its next HTTP request", async ({ page, context }) => {
  // HTTP on, so the new token can be tried against /api/mcp (the run has a web password)
  fs.writeFileSync(MCP, fs.readFileSync(MCP, "utf8").replace("enabled: false", "enabled: true\nhttp:\n  enabled: true"));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await expect(page.getByTestId("agents-connections-card")).toBeVisible();
  await expect(page.getByTestId("agents-connections-card").getByText("Example laptop")).toBeVisible();
  const folded = page.getByTestId("tokens-inactive");
  await expect(folded).toContainText("Old tablet");
  await expect(folded.getByText("Old tablet")).toBeHidden();

  const name = `e2e-${Date.now()}`;
  await page.getByTestId("token-create").click();
  await page.getByTestId("token-name-input").fill(name);
  const answer = page.waitForResponse((response) => response.request().method() === "POST" && response.request().headers()["next-action"] === actionId("createAgentTokenAction"));
  await page.getByTestId("token-create-submit").click();
  const response = await answer;
  const secret = await page.getByTestId("token-secret").inputValue();
  expect(secret).toMatch(/^jrat_[A-Za-z0-9_-]{43}$/);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.text()).toContain(secret);

  await page.getByTestId("token-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

  const mcp = (token: string) =>
    page.request.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } },
    });
  expect((await mcp(secret)).status()).toBe(200);

  await page.getByTestId("token-secret-done").click();
  await expect(page.getByTestId("token-secret")).toHaveCount(0);
  const row = page.getByTestId("agents-connections-card").locator("li", { hasText: name });
  await expect(row.getByTestId("token-prefix")).toHaveText(`${secret.slice(0, 13)}…`);
  const seen = async () => ({
    html: await page.content(),
    url: page.url(),
    storage: await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })),
  });
  for (const text of Object.values(await seen())) expect(text).not.toContain(secret.slice(13));
  const flight: string[] = [];
  page.on("response", (reply) => {
    if (reply.url().includes("/settings/agents")) void reply.text().then((body) => flight.push(body), () => undefined);
  });
  await page.reload();
  await expect(row.getByTestId("token-prefix")).toBeVisible();
  for (const text of Object.values(await seen())) expect(text).not.toContain(secret.slice(13));

  await row.getByTestId("token-revoke").click();
  await expect(page.getByTestId("token-revoke-dialog")).toBeVisible();
  await page.getByTestId("token-revoke-confirm").click();
  await expect(page.getByTestId("token-revoke-dialog")).toHaveCount(0);
  await expect(folded).toContainText(name);
  expect((await mcp(secret)).status()).toBe(401);
  await expect.poll(() => flight.length).toBeGreaterThan(0);
  for (const body of flight) expect(body).not.toContain(secret.slice(13));
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
