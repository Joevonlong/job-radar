import fs from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import postgres from "postgres";

/**
 * /sources: web-search discovery of new ATS boards against the disposable database and a
 * private copy of config/. The tavily channel has no API key here, so its card says "not configured".
 * The UI is Chinese by default.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const SOURCES = path.join(CONFIG_DIR, "sources.yaml");

// One config directory and one database: run the tests one after another.
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  fs.copyFileSync(path.join(process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults"), "sources.yaml"), SOURCES);
  const sql = postgres(process.env.E2E_DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
  try {
    await sql`truncate table ats_board_candidates restart identity`;
    await sql`insert into ats_board_candidates (ats, token, board_url, title, seen_count)
      values ('ashby', 'e2e-acme-labs', 'https://jobs.ashbyhq.com/e2e-acme-labs', 'AI Engineer - E2E Acme Labs', 3),
             ('personio', 'e2e-beta', 'https://e2e-beta.jobs.personio.de', null, 1)`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("the tavily card says it is not configured without an API key", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  const tavily = page.locator('[data-testid="channel-card"][data-channel="tavily"]');
  await expect(tavily.getByTestId("not-configured")).toHaveText("未配置");
  await expect(page.locator('[data-testid="channel-card"][data-channel="ashby"]').getByTestId("not-configured")).toHaveCount(0);
});

test("the paid LinkedIn cards and cascade entries say not configured without API keys", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[data-testid="channel-card"][data-channel="linkedin-apify"]').getByTestId("not-configured")).toHaveText("未配置");
  await expect(page.locator('[data-testid="channel-card"][data-channel="linkedin-monid"]').getByTestId("not-configured")).toHaveText("未配置");
  for (const id of ["linkedin-apify", "linkedin-monid"]) {
    const entry = page.locator(`[data-testid="cascade-entry"][data-channel="${id}"]`);
    await expect(entry.getByTestId("cascade-not-configured")).toHaveText("未配置");
  }
  // Bright Data without BRIGHT_DATA_API_KEY is skipped the same way
  await expect(page.locator('[data-testid="cascade-entry"][data-channel="linkedin-brightdata"]').getByTestId("cascade-not-configured")).toHaveText("未配置");
});

test("the overview only points at the discovered boards", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("candidates-card")).toHaveCount(0);
  const notice = page.getByTestId("candidates-notice");
  await expect(notice).toContainText("发现了 2 个新的 board");
  await notice.getByRole("link").click();
  await expect(page).toHaveURL(/\/sources\/registry/);
  await expect(page.getByTestId("candidates-card")).toBeVisible();
});

test("a discovered board can be added to sources.yaml or dismissed on the registry page", async ({ page }) => {
  await page.goto("/sources/registry");
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("candidates-card");
  await expect(card.getByTestId("candidate")).toHaveCount(2);
  const acme = card.locator('[data-testid="candidate"][data-token="e2e-acme-labs"]');
  await expect(acme).toContainText("E2e Acme Labs");
  await expect(acme).toContainText("AI Engineer - E2E Acme Labs");

  await acme.getByTestId("candidate-add").click();
  await expect(card.getByTestId("candidate-feedback")).toContainText("E2e Acme Labs");
  await expect(card.getByTestId("candidate")).toHaveCount(1);
  const yaml = fs.readFileSync(SOURCES, "utf8");
  expect(yaml).toContain("# ATS 公司清单"); // the file's comments survive the write
  expect(yaml).toMatch(/name: E2e Acme Labs[\s\S]*ats: ashby[\s\S]*token: e2e-acme-labs[\s\S]*enabled: true/);

  await card.locator('[data-testid="candidate"][data-token="e2e-beta"]').getByTestId("candidate-dismiss").click();
  await expect(card.getByTestId("candidates-empty")).toBeVisible();
  expect(fs.readFileSync(SOURCES, "utf8")).not.toContain("e2e-beta");

  // gone for good after a reload
  await page.reload();
  await expect(page.getByTestId("candidates-card").getByTestId("candidates-empty")).toBeVisible();
});
