import fs from "node:fs";

import axe from "axe-core";
import postgres from "postgres";

import { expect, test, type Page } from "./fixtures";

declare global {
  interface Window { axe: typeof axe }
}

/**
 * The application writer's export and reuse (/jobs/<id>/apply) on the seeded e2e database. "MLOps Engineer" (Windrose
 * Mobility) is the earlier job: it gets a question with a final answer straight from SQL (no AI involved).
 * "Prompt Engineer" (Aurelia Dynamics) is the new job whose workbench offers that answer for a similar question.
 * Both jobs' writer rows belong to this file only, and are removed again.
 */
const SOURCE = "MLOps Engineer";
const TARGET = "Prompt Engineer";
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";
const SOURCE_QUESTION = "Why do you want to join Windrose Mobility?";
const SOURCE_ANSWER = "I would love to join Windrose Mobility because I enjoy mobility software. I led the migration of our billing service.";

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function jobId(title: string): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ id: number }[]>`select id from jobs where title = ${title}`;
    if (!row) throw new Error(`no seeded job "${title}"`);
    return row.id;
  });
}

async function reset(ids: number[]): Promise<void> {
  await withSql(async (sql) => {
    await sql`delete from application_questions where job_id in ${sql(ids)}`;
  });
}

/** A question of the job whose only version is its final answer. */
async function seedFinalAnswer(id: number, question: string, answer: string): Promise<void> {
  await withSql(async (sql) => {
    const sentences = answer.split(/(?<=\.)\s+/u).map((text) => ({ text, newParagraph: false, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [] }));
    const [q] = await sql<{ id: number }[]>`
      insert into application_questions (job_id, position, text, kind, length_unit, length_value, output_language, tone, selected_materials)
      values (${id}, 0, ${question}, 'question', 'words', 150, 'en', 'neutral', '{}'::jsonb) returning id`;
    const [v] = await sql<{ id: number }[]>`
      insert into application_answer_versions (question_id, mode, text, sentences, user_written_count)
      values (${q!.id}, 'manual', ${answer}, ${sql.json(sentences)}, ${sentences.length}) returning id`;
    await sql`update application_questions set final_version_id = ${v!.id} where id = ${q!.id}`;
  });
}

let sourceId = 0;
let targetId = 0;
test.beforeAll(async () => {
  [sourceId, targetId] = [await jobId(SOURCE), await jobId(TARGET)];
  await reset([sourceId, targetId]);
  await seedFinalAnswer(sourceId, SOURCE_QUESTION, SOURCE_ANSWER);
});
test.afterAll(async () => {
  await reset([sourceId, targetId]);
});

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
});

test.describe.configure({ mode: "serial" });

async function addQuestion(page: Page, text: string): Promise<void> {
  const pane = page.getByTestId("writer-pane-questions");
  if (await pane.isVisible()) await pane.click();
  await page.getByTestId("writer-add-text").fill(text);
  await page.getByTestId("writer-add-button").click();
  await expect(page.getByTestId("writer-question").filter({ hasText: text })).toBeVisible();
}

test("export: one Markdown file of the final answers, downloaded in the browser", async ({ page }) => {
  await page.goto(`/jobs/${sourceId}/apply`);
  await expect(page.getByTestId("writer-workbench")).toHaveAttribute("data-availability", "enabled");
  await addQuestion(page, "A second question that has no answer yet");
  await expect(page.getByTestId("writer-export-count")).toHaveText("1 of 2 with a final answer");

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") requests.push(`${request.method()} ${request.url()}`);
  });
  const downloading = page.waitForEvent("download");
  await page.getByTestId("writer-export-button").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("windrose-mobility-mlops-engineer-answers.md");
  const text = fs.readFileSync((await download.path())!, "utf8");
  expect(text).toBe(
    [
      "# Application answers",
      "",
      "MLOps Engineer · Windrose Mobility",
      "",
      "## 1",
      "",
      "**Question**",
      "",
      `> ${SOURCE_QUESTION}`,
      "",
      "**Answer**",
      "",
      SOURCE_ANSWER,
      "",
    ].join("\n"),
  );
  expect(text).not.toContain("no answer yet");
  // the file is built from what the page holds: the click posts nothing (no server action, no upload)
  expect(requests).toEqual([]);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Exported 1 answer" })).toBeVisible();

  // leave the earlier job as it was seeded: one question, final
  await withSql(async (sql) => {
    await sql`delete from application_questions where job_id = ${sourceId} and text like 'A second question%'`;
  });
});

test("export: disabled while nothing is final, and available in Chinese", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "zh", url: baseURL ?? "http://127.0.0.1:3100" }]);
  await page.goto(`/jobs/${targetId}/apply`);
  await expect(page.getByTestId("writer-export-button")).toBeDisabled();
  await page.goto(`/jobs/${sourceId}/apply`);
  const downloading = page.waitForEvent("download");
  await page.getByTestId("writer-export-button").click();
  const text = fs.readFileSync((await (await downloading).path())!, "utf8");
  expect(text.startsWith("# 申请回答\n")).toBe(true);
  expect(text).toContain("**问题**");
  expect(text).toContain("**回答**");
});

test("reuse: a similar question offers the earlier final answer, which starts the new one; the old company is flagged until it is gone", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`/jobs/${targetId}/apply`);
  const text = page.getByTestId("writer-add-text");

  // not similar: nothing offered
  await text.fill("Describe your biggest technical challenge so far");
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("writer-reuse")).toHaveCount(0);

  // similar: offered with where it comes from
  await text.fill("Why do you want to join Aurelia Dynamics?");
  const offer = page.getByTestId("writer-reuse-match");
  await expect(offer).toHaveCount(1, { timeout: 10_000 });
  await expect(offer).toContainText(SOURCE_QUESTION);
  await expect(offer).toContainText("Windrose Mobility · MLOps Engineer · 60% of the words in common");

  // nothing is stored until the text is saved
  await offer.getByTestId("writer-reuse-use").click();
  const editor = page.getByTestId("writer-base-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByTestId("writer-base-text")).toHaveValue(SOURCE_ANSWER);
  await expect(editor.getByTestId("writer-old-company")).toContainText("Windrose Mobility");
  await expect(page.getByTestId("writer-version")).toHaveCount(0);

  // save it as it is: the warning stays with the saved version, also after a reload
  await page.getByTestId("writer-base-save").click();
  await expect(page.getByTestId("writer-version")).toHaveCount(1);
  await expect(page.getByTestId("writer-version").first()).toHaveAttribute("data-mode", "manual");
  const view = page.getByTestId("writer-version-view");
  await expect(view.getByTestId("writer-old-company")).toContainText("Windrose Mobility");
  await expect(view.locator('[data-testid="writer-sentence"][data-status="user_written"]')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("writer-version-view").getByTestId("writer-old-company")).toContainText("Windrose Mobility");

  // change the company: the next version carries no warning
  await page.getByTestId("writer-edit").click();
  const edit = page.getByTestId("writer-edit-text");
  await edit.fill((await edit.inputValue()).replace("Windrose Mobility", "Aurelia Dynamics"));
  await page.getByTestId("writer-edit-save").click();
  await expect(page.getByTestId("writer-version")).toHaveCount(2);
  await expect(page.getByTestId("writer-version-view").getByTestId("writer-old-company")).toHaveCount(0);

  // the earlier job's answer is untouched
  await page.goto(`/jobs/${sourceId}/apply`);
  await expect(page.getByTestId("writer-question-final")).toBeVisible();
  await page.getByTestId("writer-version").first().click();
  await expect(page.getByTestId("writer-version-text")).toContainText("Windrose Mobility");
});

test("reuse: the editor warns while typing, and discarding stores nothing", async ({ page }) => {
  await reset([targetId]);
  await page.goto(`/jobs/${targetId}/apply`);
  await page.getByTestId("writer-add-text").fill("Why do you want to join Aurelia Dynamics?");
  await page.getByTestId("writer-reuse-use").click({ timeout: 10_000 });
  const field = page.getByTestId("writer-base-text");
  await expect(page.getByTestId("writer-old-company")).toBeVisible();
  await field.fill(SOURCE_ANSWER.replaceAll("Windrose Mobility", "Aurelia Dynamics"));
  await expect(page.getByTestId("writer-old-company")).toHaveCount(0);
  await page.getByTestId("writer-base-discard").click();
  await expect(page.getByTestId("writer-base-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("writer-version")).toHaveCount(0);
});

test("accessibility: axe finds no WCAG A/AA violations with the reuse offer, the starting-text editor and the export button, in light and dark", async ({ page }) => {
  await reset([targetId]);
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await page.goto(`/jobs/${targetId}/apply`);
    await page.getByTestId("writer-add-text").fill("Why do you want to join Aurelia Dynamics?");
    await expect(page.getByTestId("writer-reuse-match")).toHaveCount(1, { timeout: 10_000 });
    await page.addScriptTag({ content: axe.source });
    const run = async (): Promise<string[]> =>
      page.evaluate(async () => {
        const result = await window.axe.run('[data-testid="writer-workbench"]', { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
        return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
      });
    expect(await run(), `${theme}: offer`).toEqual([]);
    await page.getByTestId("writer-reuse-use").click();
    await expect(page.getByTestId("writer-base-editor")).toBeVisible();
    await expect(page.getByTestId("writer-old-company")).toBeVisible();
    expect(await run(), `${theme}: editor`).toEqual([]);
    await reset([targetId]);
  }
});

test.describe("phone (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the bottom bar of the job page leads to the workbench, and the reuse offer fits the screen", async ({ page }) => {
    await reset([targetId]);
    await page.goto(`/jobs/${targetId}`);
    const entry = page.getByTestId("bar-write-button");
    await expect(entry).toBeVisible();
    const bar = await page.getByTestId("mobile-action-bar").boundingBox();
    const box = await entry.boundingBox();
    expect(box && bar && box.y >= bar.y && box.y + box.height <= bar.y + bar.height).toBe(true);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    await entry.click();
    await page.waitForURL(new RegExp(`/jobs/${targetId}/apply$`));
    await expect(page.getByTestId("writer-workbench")).toHaveAttribute("data-availability", "enabled");

    await page.getByTestId("writer-pane-questions").click();
    await page.getByTestId("writer-add-text").fill("Why do you want to join Aurelia Dynamics?");
    await expect(page.getByTestId("writer-reuse-match")).toHaveCount(1, { timeout: 10_000 });
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(widths[0]).toBeLessThanOrEqual(widths[1] ?? 390);
    await page.getByTestId("writer-reuse-use").click();
    await expect(page.getByTestId("writer-column-answer")).toBeVisible();
    await expect(page.getByTestId("writer-base-editor")).toBeVisible();
    const after = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(after[0]).toBeLessThanOrEqual(after[1] ?? 390);
  });

  test("with answers on the job, the bar's entry says how many are final", async ({ page }) => {
    await page.goto(`/jobs/${sourceId}`);
    await expect(page.getByTestId("bar-write-button")).toHaveAccessibleName("Write answers (1 of 1 final)");
  });
});
