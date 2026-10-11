import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * "View posting" never touches the application status; "Mark applied" is a separate, explicit act with an Undo.
 * Seeded fictional jobs: "Full-Stack Engineer (TypeScript, Postgres)" (no application) is the desktop job and
 * "Research Engineer, Evaluation" the phone job; both are restored by the Undo. "Machine Learning Engineer, Perception"
 * is already applied (read only). Each test has its own job, the file runs in parallel.
 */

const ADMIN_URL = process.env.E2E_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar";
const E2E_URL = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${process.env.E2E_DB_NAME ?? "jobradar_e2e"}`;
  return url.toString();
})();

async function counts(jobId: number): Promise<{ applications: number; events: number; status: string | null }> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ applications: number; events: number; status: string | null }[]>`
      select (select count(*)::int from applications where job_id = ${jobId}) as applications,
             (select count(*)::int from application_events e join applications a on a.id = e.application_id where a.job_id = ${jobId}) as events,
             (select status from applications where job_id = ${jobId}) as status`;
    if (!row) throw new Error("no counts");
    return row;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Back to "no application" (this job is used by no other spec), so the file can run again. */
async function reset(jobId: number): Promise<void> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from applications where job_id = ${jobId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function openJob(page: Page, title: string, extra = ""): Promise<number> {
  await page.goto(`/jobs?q=${encodeURIComponent(title)}&filtered=true${extra}`);
  await page.getByRole("link", { name: title }).first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("load");
  return Number(new URL(page.url()).pathname.split("/").pop());
}

test.describe("desktop: view posting vs mark applied", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("opening the posting changes nothing; marking applied is explicit and can be undone", async ({ page, context }) => {
    const id = await openJob(page, "Full-Stack Engineer (TypeScript, Postgres)");
    const before = await counts(id);
    expect(before.status).toBeNull();

    const view = page.getByTestId("view-posting-button");
    await expect(view).toContainText("查看原帖");
    await expect(page.getByTestId("mark-applied-button")).toContainText("标为已申请");
    await expect(page.getByTestId("job-detail")).not.toContainText("去申请");

    // 1. view the posting: a new tab opens, nothing is written
    const popupPromise = context.waitForEvent("page");
    await view.click();
    const popup = await popupPromise;
    await popup.close();
    await page.bringToFront();
    await page.waitForTimeout(500);
    await page.reload();
    expect(await counts(id)).toEqual(before);
    await expect(page.getByTestId("mark-applied-button")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("status-select")).toHaveValue("new");

    // 2. mark applied
    await page.getByTestId("mark-applied-button").click();
    await expect(page.getByText(/已标为已申请：Full-Stack/)).toBeVisible();
    await expect(page.getByTestId("applied-display")).toContainText("已申请 · ");
    await expect(page.getByTestId("mark-applied-button")).toHaveCount(0);
    await expect(page.getByTestId("status-select")).toHaveValue("applied");
    await expect(page.getByTestId("status-history")).toContainText("→ 已申请");
    expect(await counts(id)).toEqual({ applications: 1, events: 1, status: "applied" });

    // survives a reload
    await page.reload();
    await expect(page.getByTestId("applied-display")).toContainText("已申请 · ");
    expect(await counts(id)).toEqual({ applications: 1, events: 1, status: "applied" });

    await reset(id);
  });

  test("undo from the toast puts everything back", async ({ page }) => {
    const id = await openJob(page, "Security Engineer, Cloud");
    const before = await counts(id);
    await page.getByTestId("mark-applied-button").click();
    await expect(page.getByTestId("applied-display")).toBeVisible();
    expect((await counts(id)).status).toBe("applied");
    await page.getByRole("button", { name: "撤销" }).click({ timeout: 15_000 });
    await expect(page.getByTestId("mark-applied-button")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("status-select")).toHaveValue("new");
    expect(await counts(id)).toEqual(before);
  });

  test("a job that is further along shows its status and no button", async ({ page }) => {
    // A closed job is listed only when a job status is asked for
    await openJob(page, "Prompt Engineer", "&status=closed");
    await expect(page.getByTestId("applied-display")).toContainText("被拒");
    await expect(page.getByTestId("mark-applied-button")).toHaveCount(0);
  });

  test("an applied job shows the date and no button", async ({ page }) => {
    await openJob(page, "Machine Learning Engineer, Perception");
    await expect(page.getByTestId("applied-display")).toContainText("已申请 · ");
    await expect(page.getByTestId("mark-applied-button")).toHaveCount(0);
    await expect(page.getByTestId("view-posting-button")).toBeVisible();
  });
});

test.describe("phone: the bar", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("both buttons are in the bar, marking works and the bar does not cover the sources", async ({ page, context }) => {
    const id = await openJob(page, "Research Engineer, Evaluation");
    const before = await counts(id);
    const bar = page.getByTestId("mobile-action-bar");
    const view = bar.getByTestId("bar-view-posting-button");
    const mark = bar.getByTestId("bar-mark-applied-button");
    await expect(view).toBeVisible();
    await expect(mark).toBeVisible();
    for (const button of [view, mark]) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    const popupPromise = context.waitForEvent("page");
    await view.click();
    await (await popupPromise).close();
    expect(await counts(id)).toEqual(before);

    // the last panel (resume, after the sources) stays above the bar
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = await page.locator("#h-resume").evaluate((el) => el.getBoundingClientRect().bottom);
    const barTop = (await bar.boundingBox())?.y ?? 0;
    expect(last).toBeLessThanOrEqual(barTop + 1);

    await mark.click();
    await expect(bar.getByTestId("bar-applied-display")).toContainText("已申请 · ");
    expect((await counts(id)).status).toBe("applied");
    await page.getByRole("button", { name: "撤销" }).click({ timeout: 15_000 });
    await expect(bar.getByTestId("bar-mark-applied-button")).toBeVisible();
    expect(await counts(id)).toEqual(before);
  });
});
