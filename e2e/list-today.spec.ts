import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

import { EXCLUSIVE_TAG } from "./projects";

/**
 * On the seeded e2e database: Today lists every cycle of the day, and "new since my last
 * visit" (the count). Also: unseen rows (bold, a dot), seen on opening, "mark all seen" with undo.
 * The cycle, the visit marker and the seen rows of all jobs are changed here and put back, and the counts cover every
 * job of Today: every page of every other spec reads or writes that state (a visit to Today moves the visit marker, a
 * detail page marks its job seen, other specs ignore and close jobs). So every test here is tagged exclusive: they run
 * in the "chromium-exclusive" project, one at a time, after the parallel specs (see e2e/projects.ts).
 */

// the database of this run: playwright.config.ts exports its address (E2E_DATABASE_URL) to the workers
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";

test.describe.configure({ mode: "serial" });
const EXCLUSIVE = { tag: EXCLUSIVE_TAG };

async function withDb<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

let manualCycleId = 0;

test.beforeAll(async () => {
  await withDb(async (sql) => {
    // a manual cycle early today (one second after local midnight: before the seeded morning cycle), with one failed source
    const [cycle] = await sql<{ id: number }[]>`
      insert into cycles (kind, status, started_at, finished_at, summary_json)
      values ('manual', 'succeeded',
              (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin') + interval '1 second',
              (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin') + interval '2 seconds',
              ${sql.json({ steps: [{ name: "pipeline", result: { created: 3, merged: { same_source: 0, exact_key: 0, simhash: 0 } } }] })})
      returning id`;
    manualCycleId = cycle!.id;
    await sql`
      insert into runs (cycle_id, channel_id, status, fetched, new_count, error_code, error)
      values (${manualCycleId}, 'lever', 'failed', 0, 0, 'network', 'down')`;
  });
});

test.afterAll(async () => {
  await withDb(async (sql) => {
    await sql`delete from runs where cycle_id = ${manualCycleId}`;
    await sql`delete from cycles where id = ${manualCycleId}`;
    await sql`delete from runtime_state where key = 'ui:visit'`;
    await sql`delete from job_seen where via <> 'migration'`;
  });
});

test("Today lists all of today's cycles, not only the latest: type, time, counts and failed sources", EXCLUSIVE, async ({ page }) => {
  await open(page, "/");
  // the strip is still the latest cycle (the seeded morning run)
  await expect(page.getByTestId("cycle-summary")).toContainText("早轮");

  const list = page.getByTestId("today-cycles");
  await expect(list).toBeVisible();
  const rows = list.getByTestId("today-cycle");
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  const manual = list.locator('[data-testid="today-cycle"][data-kind="manual"]').first();
  await expect(manual).toContainText("手动轮");
  await expect(manual).toContainText("3新岗位");
  await expect(manual.getByTestId("today-cycle-failed")).toContainText("失败来源: lever");
  await expect(list.locator('[data-testid="today-cycle"][data-kind="weekday_morning"]')).toBeVisible();
  await expect(page.getByTestId("today-cycles-total")).toContainText("合计");
});

test("unseen rows are bold with a dot; opening one and going back shows it seen; mark all seen + undo", EXCLUSIVE, async ({ page }) => {
  // the user last looked long ago, this very visit is still open; the seeded jobs of today are unseen
  await withDb(async (sql) => {
    await sql`delete from runtime_state where key = 'ui:visit'`;
    await sql`insert into runtime_state (key, value) values ('ui:visit', ${sql.json({ seenUpTo: "2000-01-01T00:00:00Z", lastActiveAt: new Date().toISOString() })})`;
    await sql`delete from job_seen where via <> 'migration'`;
  });
  await open(page, "/");
  const rows = page.locator("[data-job-id]");
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);
  // "new since your last visit" is the sentence next to the count (Today is sorted by score: no divider)
  await expect(page.getByTestId("new-since-visit")).toHaveAttribute("data-count", String(total));
  await expect(page.getByTestId("new-since-visit")).toContainText(`上次访问后新增 ${total} 条`);
  await expect(page.getByTestId("new-since-divider")).toHaveCount(0);
  await expect(page.locator("[data-slot=new-dot]")).toHaveCount(0);

  const unseen = page.locator('[data-job-id][data-seen="false"]');
  const unseenBefore = await unseen.count();
  expect(unseenBefore).toBeGreaterThan(1);
  await expect(page.getByTestId("unseen-count")).toHaveAttribute("data-count", String(unseenBefore));
  await expect(unseen.first().locator("[data-slot=unseen-dot]")).toBeVisible();
  // bold title on an unseen row, normal weight on a seen one
  const weight = (row: import("@playwright/test").Locator) => row.locator(".jb-title").evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(await weight(unseen.first())).toBeGreaterThanOrEqual(700);
  const seenRow = page.locator('[data-job-id][data-seen="true"]').first();
  if ((await seenRow.count()) > 0) expect(await weight(seenRow)).toBeLessThan(700);

  // open the first unseen job, then the browser's back button: the row is no longer bold
  const openedId = await unseen.first().getAttribute("data-job-id");
  await unseen.first().locator(".jb-title a").click();
  await expect(page.getByTestId("job-detail")).toHaveAttribute("data-job-id", openedId ?? "");
  await expect.poll(() => withDb(async (sql) => (await sql`select via from job_seen where job_id = ${Number(openedId)}`)[0]?.via ?? null)).toBe("detail");
  await page.goBack();
  // back on Today (the detail page also carries data-job-id on several panels: only list rows have data-seen)
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByTestId("job-detail")).toHaveCount(0);
  const opened = page.locator(`[data-job-id="${openedId}"][data-seen]`);
  await expect(opened).toHaveAttribute("data-seen", "true");
  expect(await weight(opened)).toBeLessThan(700);
  await expect(unseen).toHaveCount(unseenBefore - 1);
  // and after a reload too (it is stored)
  await page.reload();
  await expect(page.locator(`[data-job-id="${openedId}"][data-seen]`)).toHaveAttribute("data-seen", "true");

  // mark all seen: every row of the view is seen; the toast's undo takes back only that batch
  await page.getByTestId("mark-all-seen").click();
  await expect(unseen).toHaveCount(0);
  await expect(page.getByTestId("unseen-count")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(unseen).toHaveCount(unseenBefore - 1);
  await expect(page.locator(`[data-job-id="${openedId}"][data-seen]`)).toHaveAttribute("data-seen", "true");

  // /jobs shows the same state, with the unseen count of the whole filtered list
  await open(page, "/jobs");
  await expect(page.locator(`[data-job-id="${openedId}"][data-seen]`)).toHaveAttribute("data-seen", "true");
  await expect(page.getByTestId("unseen-count")).toBeVisible();
  await withDb((sql) => sql`delete from job_seen where via <> 'migration'`);
});

test("fetching a job page without showing it (a prefetch, a bot) marks nothing", EXCLUSIVE, async ({ page, request }) => {
  const id = await withDb(async (sql) => {
    await sql`delete from job_seen where via <> 'migration'`;
    const [row] = await sql<{ id: string }[]>`select j.id from jobs j where not exists (select 1 from job_seen s where s.job_id = j.id) order by j.id limit 1`;
    return Number(row!.id);
  });
  const response = await request.get(`/jobs/${id}`);
  expect(response.ok()).toBe(true);
  expect(await withDb(async (sql) => (await sql`select 1 from job_seen where job_id = ${id}`).length)).toBe(0);
  // hovering its link on the list (Next prefetches it) does not either
  await open(page, `/jobs?unseen=true`);
  const link = page.locator(`[data-job-id="${id}"] .jb-title a`);
  if ((await link.count()) > 0) {
    await link.hover();
    await page.waitForTimeout(500);
  }
  expect(await withDb(async (sql) => (await sql`select 1 from job_seen where job_id = ${id}`).length)).toBe(0);
});

test("newest first draws the 'new since your last visit' divider; other orders say it next to the count", EXCLUSIVE, async ({ page }) => {
  // the visit marker sits just after the third-newest job of /jobs (newest first): three jobs are new
  const { seenUpTo, thirdId } = await withDb(async (sql) => {
    const rows = await sql<{ id: string; first_seen_at: Date }[]>`
      select j.id, j.first_seen_at from jobs j where j.status <> 'closed' order by j.first_seen_at desc, j.id desc limit 4`;
    await sql`delete from runtime_state where key = 'ui:visit'`;
    const marker = rows[3]!.first_seen_at;
    await sql`insert into runtime_state (key, value) values ('ui:visit', ${sql.json({ seenUpTo: marker.toISOString(), lastActiveAt: new Date().toISOString() })})`;
    return { seenUpTo: marker, thirdId: rows[2]!.id };
  });
  expect(seenUpTo).toBeTruthy();
  await open(page, "/jobs?sort=first_seen&filtered=true");
  const divider = page.getByTestId("new-since-divider");
  await expect(divider).toHaveCount(1);
  await expect(divider).toHaveAccessibleName(/以上为上次访问后新增 · \d+ 条/);
  // it hangs under the last new row, inside that row's list item
  await expect(page.locator("li", { has: divider }).locator("[data-job-id]")).toHaveAttribute("data-job-id", String(thirdId));
  await expect(page.getByTestId("new-since-visit")).toHaveCount(0);

  // another order: no divider, the sentence with a link to newest first
  await open(page, "/jobs?filtered=true");
  await expect(page.getByTestId("new-since-divider")).toHaveCount(0);
  await expect(page.getByTestId("new-since-visit")).toContainText("上次访问后新增");
  await page.getByTestId("new-since-visit-link").click();
  await expect(page).toHaveURL(/sort=first_seen/);
  await expect(page.getByTestId("new-since-divider")).toHaveCount(1);
});

test("the first visit ever marks nothing as new", EXCLUSIVE, async ({ page }) => {
  await withDb((sql) => sql`delete from runtime_state where key = 'ui:visit'`);
  await open(page, "/");
  await expect(page.getByTestId("new-since-visit")).toHaveCount(0);
  // the visit was recorded
  await expect.poll(() => withDb(async (sql) => (await sql`select 1 from runtime_state where key = 'ui:visit'`).length)).toBe(1);
});
