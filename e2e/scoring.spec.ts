import { expect, test } from "./fixtures";
import postgres from "postgres";
import { listRows } from "./list-rows";

/**
 * AI scoring on the dashboard: score breakdown with the German deduction, the German badge,
 * the "hide German-required" quick filter and the stale marker. Runs on the seeded e2e database; the
 * job it needs is inserted here (and removed again), and it asks for C2 German so the result does
 * not depend on the German level the profile e2e test is editing at the same time (a C2 requirement
 * is above any level it sets).
 */

// the database of this run: playwright.config.ts exports its address (E2E_DATABASE_URL) to the workers
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";

// One worker runs the whole file: the job is created once in beforeAll and removed in afterAll.
test.describe.configure({ mode: "serial" });

const TITLE = "E2E Scoring German Role";
const COMPANY = "E2E Scoring Co";
let jobId = 0;

test.beforeAll(async () => {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from jobs where title = ${TITLE}`;
    await sql`delete from companies where name_norm = ${COMPANY.toLowerCase()}`;
    const [company] = await sql<{ id: number }[]>`insert into companies (name, name_norm) values (${COMPANY}, ${COMPANY.toLowerCase()}) returning id`;
    const [job] = await sql<{ id: number }[]>`
      insert into jobs (company_id, title, title_norm, description, german_level_required, first_seen_at)
      values (${company!.id}, ${TITLE}, ${TITLE.toLowerCase()}, 'Fließend Deutsch (C2) erforderlich. We build things.', 'C2', now() - interval '10 days')
      returning id`;
    jobId = job!.id;
    await sql`
      insert into scores (job_id, filter_result, provider, model, score, ai_score, german_penalty, german_level, german_level_ai, german_level_source,
                          rank_value, fit_reasons, gaps, summary_zh, summary_en, prompt_version, scored_at)
      values (${jobId}, 'passed', 'codex-cli', 'test-model', 65, 90, 25, 'C2', 'C2', 'agree',
              65, ${["与目标岗位高度相关"]}, ${["要求德语 C2"]}, '一个德语岗位。', 'A German-language role.', 'score-v1', now())`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test.afterAll(async () => {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from jobs where title = ${TITLE}`;
    await sql`delete from companies where name_norm = ${COMPANY.toLowerCase()}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("the list shows the score and the German badge; the quick filter hides the job and survives a reload", async ({ page }) => {
  await page.goto(`/jobs?q=${encodeURIComponent(TITLE)}`);
  const row = listRows(page).filter({ hasText: TITLE });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-rank="mid"]')).toContainText("65");
  await expect(row).toContainText("德语 C2");

  await page.getByTestId("filter-hide-german").click();
  await expect(page).toHaveURL(/[?&]hideLang=true/);
  await expect(listRows(page).filter({ hasText: TITLE })).toHaveCount(0);
  await expect(page.getByTestId("filter-hide-german")).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByTestId("filter-hide-german")).toHaveAttribute("aria-pressed", "true");
  await expect(listRows(page).filter({ hasText: TITLE })).toHaveCount(0);

  await page.getByTestId("filter-hide-german").click();
  await expect(listRows(page).filter({ hasText: TITLE })).toBeVisible();
});

test("the detail page shows reasons, gaps, summary, the breakdown with the German deduction and the German block", async ({ page }) => {
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-title")).toHaveText(TITLE);
  await expect(page.getByText("一个德语岗位。")).toBeVisible();
  await expect(page.getByTestId("fit-list")).toContainText("与目标岗位高度相关");
  await expect(page.getByTestId("gaps-list")).toContainText("要求德语 C2");

  const breakdown = page.getByTestId("rank-breakdown");
  await expect(breakdown).toContainText("AI 评分");
  await expect(breakdown).toContainText("90");
  await expect(breakdown).toContainText("德语要求");
  await expect(breakdown).toContainText("−25");
  await expect(breakdown).toContainText("65");

  const german = page.getByTestId("german-panel");
  await expect(german).toContainText("要求德语 C2");
  await expect(german.getByTestId("german-penalty")).toContainText("匹配分扣 25 分");
  await expect(page.getByTestId("score-meta")).toContainText("codex-cli");
  await expect(page.getByTestId("score-stale")).toHaveCount(0);
});

test("a stale score is marked in the list and on the detail page", async ({ page }) => {
  // the seed marks the score of "LLM Engineer" as out of date
  await page.goto("/jobs?q=LLM+Engineer");
  const row = listRows(page).filter({ hasText: "LLM Engineer" }).first();
  await expect(row.getByTestId("rank-stale")).toHaveText("已过期");
  await row.click();
  await expect(page.getByTestId("score-stale")).toContainText("已过期");
});

test("Today has the same quick filter as a toggle", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByTestId("toggle-hide-german");
  await expect(toggle).toHaveText("隐藏需德语");
  await toggle.click();
  await expect(page).toHaveURL(/[?&]hideLang=true/);
  await expect(page.getByTestId("toggle-hide-german")).toHaveText("已隐藏需德语");
  await page.getByTestId("toggle-hide-german").click();
  await expect(page).not.toHaveURL(/hideLang/);
});
