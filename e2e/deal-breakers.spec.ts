import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";
import postgres from "postgres";

import { refreshCurrentScores } from "./current-scores";

/**
 * Deal-breakers: the card on /me (add a language gate, its preview over the seeded jobs, save) and a vetoed job's page.
 * The seeded instance is German and "About me" says German B1. Fictional seed job: "Data Engineer" (Orbitrail AG), which
 * requires German B2 ("Gute Deutschkenntnisse (B2) sind erforderlich."). The filter step runs in the runner, not in the
 * web app, so the second test writes the rule and the job's filter result itself, and puts both back.
 * Rewrites preferences.yaml: a project of the serial chain (e2e/projects.ts).
 */
const PROFILE_DIR = process.env.E2E_PROFILE_DIR ?? "";
const PREFS_FILE = path.join(PROFILE_DIR, "preferences.yaml");
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";

test.describe.configure({ mode: "serial" });
// every test starts from the German template, and the next spec file finds it again
test.beforeEach(() => fs.rmSync(PREFS_FILE, { force: true }));
test.afterAll(() => fs.rmSync(PREFS_FILE, { force: true }));

async function openMe(page: Page) {
  await page.goto("/me");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("deal-breakers-card")).toBeVisible();
}

test("the card adds a language gate, counts what it would veto and saves it", async ({ page }) => {
  await openMe(page);
  const card = page.getByTestId("deal-breakers-card");
  await expect(card).toContainText("还没有一票否决项");
  await expect(card.getByTestId("deal-breakers-ai-note").getByRole("link", { name: /设置/ })).toHaveAttribute("href", /\/settings\?tab=ai/);

  await card.getByTestId("deal-breaker-add-gate").click();
  const rule = card.getByTestId("deal-breaker");
  await expect(rule).toHaveAttribute("data-type", "language_gate");
  await expect(rule).toContainText("B1");
  // the seeded jobs that state German above B1 (B2, C1): counted before anything is saved
  const preview = rule.getByTestId("deal-breaker-preview");
  await expect(preview).toHaveAttribute("data-status", "ok");
  await expect.poll(async () => Number(await preview.getAttribute("data-count"))).toBeGreaterThanOrEqual(1);
  await expect(preview).toContainText("Data Engineer");

  // a fixed threshold of C2 vetoes none of them
  await rule.getByRole("combobox").first().selectOption("C2");
  await expect(preview).toHaveAttribute("data-count", "0");
  await rule.getByRole("combobox").first().selectOption("");
  await expect.poll(async () => Number(await preview.getAttribute("data-count"))).toBeGreaterThanOrEqual(1);

  await page.getByTestId("preferences-card").getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => fs.existsSync(PREFS_FILE) ? fs.readFileSync(PREFS_FILE, "utf8") : "").toMatch(/type: language_gate/);
  const saved = fs.readFileSync(PREFS_FILE, "utf8");
  expect(saved).not.toMatch(/at_least/);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("deal-breakers-card").getByTestId("deal-breaker")).toHaveCount(1);
});

test("a vetoed job names the rule, quotes the posting and shows both levels; Keep anyway is offered", async ({ page, context, baseURL }) => {
  // Seed the template explicitly before the hand edit; opening /me only reads it in memory.
  await openMe(page);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.copyFileSync(path.join(DEFAULTS_DIR, "profile.example", "preferences.yaml"), PREFS_FILE);
  fs.appendFileSync(PREFS_FILE, "\ndeal_breakers:\n  - id: german-gate\n    label: 德语高于我的水平\n    type: language_gate\n");

  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  const [job] = await sql<{ id: number }[]>`select j.id::int as id from jobs j join companies c on c.id = j.company_id where j.title = 'Data Engineer' and c.name = 'Orbitrail AG'`;
  if (!job) throw new Error("seeded job missing");
  const rows = await sql<{ id: number; filter_result: string; filter_reasons: string[] }[]>`select id::int as id, filter_result, filter_reasons from scores where job_id = ${job.id}`;
  try {
    await sql`update scores set filter_result = 'filtered_out', filter_reasons = ${sql.array(["deal_breaker:german-gate"])} where job_id = ${job.id}`;
    await refreshCurrentScores([job.id]);

    // a hand edit of the file: the page reads it as it is now
    await page.goto(`/jobs/${job.id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("filter-banner")).toContainText("一票否决：德语高于我的水平");
    const explanation = page.getByTestId("deal-breaker-explanations").locator('[data-deal-breaker="german-gate"]');
    await expect(explanation.getByTestId("deal-breaker-levels")).toContainText("B2");
    await expect(explanation.getByTestId("deal-breaker-levels")).toContainText("B1");
    await expect(explanation.getByTestId("deal-breaker-quote")).toContainText("Deutschkenntnisse (B2)");
    await expect(page.getByTestId("detail-header").getByRole("button", { name: "仍然保留" })).toBeVisible();
    // the score the job earned stays on the rank card (the banner says why it is filtered out); a veto means no push, so no push line
    const rankBox = page.getByTestId("rank-box");
    await expect(rankBox.locator('[data-rank="ranked"]')).toBeVisible();
    await expect(rankBox.locator('[data-rank="not-ranked"]')).toHaveCount(0);
    await expect(rankBox.locator(".jr-segm--noline")).toHaveCount(1);

    // in the filtered list the row carries the rule's name
    await page.goto("/jobs?q=Orbitrail&filtered=true");
    await expect(page.locator("[data-job-id]", { hasText: "Data Engineer" }).first().locator('[data-slot="filter-reasons"]')).toContainText("德语高于我的水平");

    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.goto(`/jobs/${job.id}`);
    await expect(page.getByTestId("filter-banner")).toContainText("Deal-breaker: 德语高于我的水平");
    await expect(explanation.getByTestId("deal-breaker-levels")).toHaveText("The rules read: B2; your level: B1.");
  } finally {
    for (const row of rows) await sql`update scores set filter_result = ${row.filter_result}, filter_reasons = ${sql.array(row.filter_reasons)} where id = ${row.id}`;
    await sql.end({ timeout: 5 });
    await refreshCurrentScores([job.id]);
  }
});
