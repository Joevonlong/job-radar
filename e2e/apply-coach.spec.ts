import axe from "axe-core";
import postgres from "postgres";

import { expect, test, type Page } from "./fixtures";

declare global {
  interface Window { axe: typeof axe }
}

/**
 * Improving your own draft and the coach review on the workbench (/jobs/<id>/apply), on the seeded e2e database. The e2e runner
 * runs the real `writer_job` handler with a stand-in AI: a polish returns the sentences of your text, each backed by itself;
 * a review rates one configured and one unknown dimension and suggests one backed rewrite, one without evidence and one for a
 * sentence that does not exist; a rewrite applies the suggestions.
 */
const TITLE = "ML Platform Engineer";
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";
const DRAFT = "I built the data pipeline. It cut our costs by 30%.";

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function jobId(): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ id: number }[]>`select id from jobs where title = ${TITLE}`;
    if (!row) throw new Error(`no seeded job "${TITLE}"`);
    return row.id;
  });
}

/** No questions on the job (they belong to this file only), so the file can run again. */
async function reset(id: number): Promise<void> {
  await withSql(async (sql) => {
    await sql`delete from application_questions where job_id = ${id}`;
    await sql`delete from control_requests where kind = 'writer_job' and payload ->> 'jobId' = ${String(id)}`;
  });
}

let id = 0;
test.beforeAll(async () => {
  id = await jobId();
  await reset(id);
});
test.afterAll(async () => {
  await reset(id);
});

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
});

test.describe.configure({ mode: "serial" });

async function openAnswer(page: Page): Promise<void> {
  const pane = page.getByTestId("writer-pane-answer");
  if (await pane.isVisible()) await pane.click();
}

test("improve my draft, then review the result: adopt a suggestion, rewrite by the review", async ({ page }) => {
  await page.goto(`/jobs/${id}/apply`);
  await expect(page.getByTestId("writer-workbench")).toHaveAttribute("data-availability", "enabled");
  // the form is a client component: type only once the page is hydrated, or the text is lost
  await page.waitForLoadState("networkidle");
  const pane = page.getByTestId("writer-pane-questions");
  if (await pane.isVisible()) await pane.click();
  await page.getByTestId("writer-add-text").fill("Why do you want to work on our ML platform?");
  await page.getByTestId("writer-add-button").click();
  await expect(page.getByTestId("writer-question")).toHaveCount(1);
  await openAnswer(page);

  // nothing to polish or review before there is a text
  await expect(page.getByTestId("writer-polish")).toBeVisible();
  const versions = page.getByTestId("writer-version");
  await expect(versions).toHaveCount(0);

  // improve my draft: what is sent is listed per option, "language only" sends none of the chosen material
  await page.getByTestId("writer-polish").locator("summary").click();
  await expect(page.getByTestId("writer-polish-button")).toBeDisabled();
  await page.getByTestId("writer-polish-text").fill(DRAFT);
  await expect(page.getByTestId("writer-polish-sends")).toContainText("JD");
  await page.getByTestId("writer-polish-option").selectOption("language_only");
  await expect(page.getByTestId("writer-polish-sends")).not.toContainText("JD");
  await expect(page.getByTestId("writer-polish-sends")).toContainText("your text");
  await page.getByTestId("writer-polish-option").selectOption("align_to_job");
  await page.getByTestId("writer-polish-button").click();
  await expect(versions).toHaveCount(1, { timeout: 30_000 });
  await expect(versions.first()).toHaveAttribute("data-mode", "polish");
  const view = page.getByTestId("writer-version-view");
  await expect(view.locator('[data-testid="writer-sentence"][data-status="supported"]')).toHaveCount(2);
  await expect(view.locator('[data-testid="writer-sentence"][data-status="framing"]')).toHaveCount(1);
  // a sentence's evidence is the user's own text
  await view.locator('[data-testid="writer-sentence"][data-status="supported"]').first().click();
  await expect(page.getByTestId("writer-evidence")).toContainText("your draft");

  // the coach review
  const coach = page.getByTestId("writer-coach");
  await expect(coach).toHaveAttribute("data-reviewed", "false");
  await expect(page.getByTestId("writer-coach-sends")).toContainText("your text");
  await page.getByTestId("writer-coach-button").click();
  await expect(coach).toHaveAttribute("data-reviewed", "true", { timeout: 30_000 });
  await expect(page.getByTestId("writer-coach-score")).toHaveAttribute("data-score", "72");
  await expect(coach).toContainText("AI judgement");
  // the unknown dimension and the suggestion for a sentence that does not exist are left out, and counted
  await expect(page.getByTestId("writer-coach-dimensions").getByRole("listitem")).toHaveCount(2);
  const suggestions = page.getByTestId("writer-coach-suggestion");
  await expect(suggestions).toHaveCount(2);
  await expect(suggestions.nth(0)).toHaveAttribute("data-status", "supported");
  await expect(suggestions.nth(1)).toHaveAttribute("data-status", "ai_suggestion_unverified");
  await expect(page.getByTestId("writer-coach-dropped")).toBeVisible();

  // adopt the unverified suggestion: a new version in which that sentence is marked as unchecked
  await suggestions.nth(1).getByTestId("writer-coach-adopt").click();
  await expect(versions).toHaveCount(2, { timeout: 30_000 });
  await expect(versions.first()).toHaveAttribute("data-mode", "manual");
  await expect(page.getByTestId("writer-version-view").locator('[data-testid="writer-sentence"][data-status="ai_suggestion_unverified"]')).toHaveCount(1);
  await expect(page.getByTestId("writer-version-view")).toContainText("I ran the platform on call for two years.");

  // back on the reviewed version (its review is stored on it): rewrite the whole answer by the suggestions
  await versions.nth(1).click();
  await expect(page.getByTestId("writer-coach")).toHaveAttribute("data-reviewed", "true");
  await page.getByTestId("writer-coach-rewrite").click();
  await expect(versions).toHaveCount(3, { timeout: 30_000 });
  await expect(versions.first()).toHaveAttribute("data-mode", "coach_rewrite");
  await expect(page.getByTestId("writer-version-view")).toContainText("every single day");

  // a reload keeps the versions and the review
  await page.reload();
  await openAnswer(page);
  await expect(versions).toHaveCount(3);
  await versions.nth(2).click();
  await expect(page.getByTestId("writer-coach-score")).toHaveAttribute("data-score", "72");
});

test("language only sends none of the chosen material and still gives a checked version", async ({ page }) => {
  await page.goto(`/jobs/${id}/apply`);
  await openAnswer(page);
  const versions = page.getByTestId("writer-version");
  const before = await versions.count();
  await page.getByTestId("writer-polish").locator("summary").click();
  await page.getByTestId("writer-polish-text").fill("Ich habe die Datenpipeline gebaut. Die Kosten sanken um 30%.");
  await page.getByTestId("writer-polish-option").selectOption("language_only");
  await page.getByTestId("writer-polish-button").click();
  await expect(versions).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(versions.first()).toHaveAttribute("data-mode", "polish");
  await expect(page.getByTestId("writer-version-view").locator('[data-testid="writer-sentence"][data-status="supported"]')).toHaveCount(2);
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the review fits the width and nothing scrolls sideways", async ({ page }) => {
    await page.goto(`/jobs/${id}/apply`);
    await openAnswer(page);
    await page.getByTestId("writer-version").last().click();
    await expect(page.getByTestId("writer-coach-result")).toBeVisible();
    await page.getByTestId("writer-polish").locator("summary").click();
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(widths[0]).toBeLessThanOrEqual(widths[1] ?? 390);
  });
});

test("accessibility: axe finds no WCAG A/AA violations with the polish box open and a review shown, in English and light theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(`/jobs/${id}/apply`);
  await expect(page.getByRole("heading", { name: "Answer", exact: true })).toBeVisible();
  await page.getByTestId("writer-version").last().click();
  await expect(page.getByTestId("writer-coach-result")).toBeVisible();
  await page.getByTestId("writer-polish").locator("summary").click();
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run('[data-testid="writer-workbench"]', { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  });
  expect(violations).toEqual([]);
});
