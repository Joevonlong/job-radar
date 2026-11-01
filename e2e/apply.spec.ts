import axe from "axe-core";
import postgres from "postgres";

import { expect, test, type Page } from "./fixtures";

declare global {
  interface Window { axe: typeof axe }
}

/**
 * The application writer workbench (/jobs/<id>/apply) on the seeded e2e database. writer.yaml of the e2e config copy is
 * switched on by scripts/e2e-prepare.ts; the e2e runner runs the real `writer_job` handler with a stand-in AI that
 * writes, per version, a sentence quoting the JD (backed), a claim about you with no evidence and a framing sentence.
 * "ML Platform Engineer" has no seeded breakdown, so a new question starts with the JD text and the profile.
 */
const TITLE = "ML Platform Engineer";
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";

async function jobId(): Promise<number> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ id: number }[]>`select id from jobs where title = ${TITLE}`;
    if (!row) throw new Error(`no seeded job "${TITLE}"`);
    return row.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** No questions on the job (this job's questions belong to this file only), so the file can run again. */
async function reset(id: number): Promise<void> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from application_questions where job_id = ${id}`;
    await sql`delete from control_requests where kind = 'writer_job' and payload ->> 'jobId' = ${String(id)}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function addQuestion(page: Page, text: string): Promise<void> {
  const pane = page.getByTestId("writer-pane-questions");
  if (await pane.isVisible()) await pane.click();
  await page.getByTestId("writer-add-text").fill(text);
  await page.getByTestId("writer-add-button").click();
  await expect(page.getByTestId("writer-question").filter({ hasText: text })).toBeVisible();
}

async function write(page: Page): Promise<void> {
  const pane = page.getByTestId("writer-pane-answer");
  if (await pane.isVisible()) await pane.click();
  await page.getByTestId("writer-write-button").click();
  await expect(page.getByTestId("writer-answer")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
}

let id = 0;
test.beforeAll(async () => {
  id = await jobId();
  await reset(id);
});
test.afterAll(async () => {
  await reset(id);
});

test.describe.configure({ mode: "serial" });

test("from the job page: add a question, write, read the evidence, edit a sentence and mark the final version", async ({ page }) => {
  await page.goto(`/jobs/${id}`);
  await page.getByTestId("action-write").click();
  await page.waitForURL(new RegExp(`/jobs/${id}/apply$`));
  await expect(page.getByTestId("writer-workbench")).toHaveAttribute("data-availability", "enabled");
  await expect(page.getByTestId("writer-no-questions")).toBeVisible();

  await addQuestion(page, "Why do you want to work on our ML platform?");
  // what is sent is listed before anything is sent: the question, its settings, the job, the JD text and no web search
  await expect(page.getByTestId("writer-disclosure")).toContainText("JD");

  await write(page);
  const versions = page.getByTestId("writer-version");
  await expect(versions).toHaveCount(3);
  const view = page.getByTestId("writer-version-view");
  await expect(view.getByTestId("writer-sentence")).toHaveCount(3);
  await expect(view.locator('[data-testid="writer-sentence"][data-status="supported"]')).toHaveCount(1);
  await expect(view.locator('[data-testid="writer-sentence"][data-status="unsupported"]')).toHaveCount(1);
  await expect(view.locator('[data-testid="writer-sentence"][data-status="framing"]')).toHaveCount(1);
  await expect(view.getByTestId("writer-version-counts").locator('[data-status="unsupported"]')).toHaveAttribute("data-count", "1");

  // a sentence opens its evidence
  await view.locator('[data-testid="writer-sentence"][data-status="supported"]').click();
  await expect(page.getByTestId("writer-sentence-detail")).toHaveAttribute("data-status", "supported");
  await expect(page.getByTestId("writer-evidence")).toBeVisible();

  // a manual edit: the changed sentence becomes yours, the unchanged ones keep their check
  await view.getByTestId("writer-edit").click();
  const text = page.getByTestId("writer-edit-text");
  const before = await text.inputValue();
  await text.fill(before.replace("I scaled the team to 20 people.", "I ran the platform on call for two years."));
  await page.getByTestId("writer-edit-save").click();
  await expect(versions).toHaveCount(4);
  await expect(versions.first()).toHaveAttribute("data-mode", "manual");
  const edited = page.getByTestId("writer-version-view");
  await expect(edited.locator('[data-testid="writer-sentence"][data-status="user_written"]')).toHaveCount(1);
  await expect(edited.locator('[data-testid="writer-sentence"][data-status="supported"]')).toHaveCount(1);

  await edited.getByTestId("writer-finalise").click();
  await expect(edited.getByTestId("writer-finalise")).toHaveAttribute("data-final", "true");

  // the job page counts it, and a reload keeps it
  await page.goto(`/jobs/${id}`);
  await expect(page.getByTestId("action-write-count")).toHaveText("1/1");
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one column at a time, switched by the pane control, with no horizontal scroll", async ({ page }) => {
    await page.goto(`/jobs/${id}/apply`);
    await expect(page.getByTestId("writer-panes")).toBeVisible();
    for (const pane of ["materials", "questions", "answer"] as const) {
      await page.getByTestId(`writer-pane-${pane}`).click();
      await expect(page.getByTestId(`writer-column-${pane}`)).toBeVisible();
      const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(widths[0]).toBeLessThanOrEqual(widths[1] ?? 390);
    }
  });
});

test("accessibility: axe finds no WCAG A/AA violations on the workbench, in English and light theme", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(`/jobs/${id}/apply`);
  await expect(page.getByTestId("writer-version-view")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Answer", exact: true })).toBeVisible();
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run('[data-testid="writer-workbench"]', { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  });
  expect(violations).toEqual([]);
});
