import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { listRow, listRows } from "./list-rows";

/** The graphic columns of the job list, the hover actions, the summary blocks and the phone cards on the seeded e2e database. */

// the database of this run: playwright.config.ts exports its address (E2E_DATABASE_URL) to the workers
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";

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

test.describe("Today and /jobs v3", () => {
  test("the summary blocks and the ticker are on Today, with real numbers and the push line from notify.yaml", async ({ page }) => {
    await open(page, "/");
    const strip = page.getByTestId("kpi-strip");
    await expect(strip).toBeVisible();
    for (const key of ["fetched", "passed", "qualified", "salary", "pushed"]) await expect(page.getByTestId(`kpi-${key}`)).toHaveAttribute("data-value", /^\d+$/);
    // the third block is named after the push line (70 in the shipped notify.yaml)
    await expect(page.getByTestId("kpi-qualified")).toHaveAccessibleName("≥ 70 分");
    // fetched = the sum of the latest cycle's runs: 120 + 80 + 31 + 0 + 22 + 18 + 0 in the seed
    await expect(page.getByTestId("kpi-fetched")).toHaveAttribute("data-value", "271");
    await expect(page.getByRole("group", { name: "本轮新岗位" }).first()).toBeVisible();
  });

  test("the list says how many of its jobs are from this cycle and from today, and the first cycle shows no change tag or lone-dot trend", async ({ page }) => {
    await open(page, "/");
    // the count itself stays "共 N 条"; the scope next to it adds this cycle's and today's share
    await expect(page.getByTestId("result-count")).toHaveText(/^共 \d+ 条$/);
    await expect(page.getByTestId("result-scope")).toHaveText(/^（本轮 \d+ · 今天 \d+）$/);
    // never a dashed "—" change tag in a block: it is either a real change or nothing
    await expect(page.locator('[data-testid="kpi-strip"] .jr-delta--unknown')).toHaveCount(0);
  });

  test("a wide screen gets the table with its head, a phone gets cards without one; every row has the graphic cells", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/jobs");
    await expect(page.locator('[data-slot="list-head"]')).toBeVisible();
    const row = listRows(page).filter({ hasText: "Applied Scientist, Clinical NLP" });
    await expect(row.getByRole("meter", { name: "排序值" })).toBeVisible();
    await expect(row.locator('[data-salary-state="stated"]')).toContainText("€90–110k");
    await expect(row.locator('[data-slot="signal-tag"]')).toHaveCount(1);
    await expect(row.locator('[data-slot="status-chip"]')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-slot="list-head"]')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // on a card the ★ / 👍 / ✕ buttons are always there
    await expect(row.getByTestId("row-favorite")).toBeVisible();
    await expect(row.getByTestId("row-interested")).toBeVisible();
  });

  test("a job without skills shows — in the skill column, never 0/0", async ({ page }) => {
    await open(page, "/jobs?q=Data+Engineer");
    const row = listRows(page).filter({ hasText: "Data Engineer" }).first();
    await expect(row.locator('[data-slot="skills-none"]')).toHaveText(/—/);
    await expect(row).not.toContainText("0/0");
  });

  test("hovering a row slides in ★ / 👍 / ✕; 👍 marks the job interested and a second press takes it back", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/");
    // a job no other spec touches (the others run in parallel)
    const row = listRows(page).filter({ hasText: "Orbitrail AG" });
    const actions = row.locator('[data-slot="row-actions"]');
    await expect(actions).toHaveCSS("opacity", "0");
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    const before = await row.getAttribute("data-status");
    const target = before === "interested" ? "new" : "interested";
    await row.getByTestId("row-interested").click();
    await expect(row).toHaveAttribute("data-status", target);
    await row.hover();
    await row.getByTestId("row-interested").click();
    await expect(row).toHaveAttribute("data-status", before ?? "new");
  });

  test("the buttons are reachable with the keyboard: Tab from the focused row lands on them", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/");
    await page.keyboard.press("j");
    const row = listRows(page).first();
    await expect(row).toBeFocused();
    await page.keyboard.press("Tab"); // the title link
    await page.keyboard.press("Tab"); // ★ favorite
    await expect(row.getByTestId("row-favorite")).toBeFocused();
    await expect(row.locator('[data-slot="row-actions"]')).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab"); // 👍 interested
    await expect(row.getByTestId("row-interested")).toBeFocused();
    await page.keyboard.press("Tab"); // ✕ ignore
    await expect(row.getByTestId("row-ignore")).toBeFocused();
  });

  test("a sort change reorders the rows and the URL keeps it", async ({ page }) => {
    await open(page, "/jobs");
    const first = await listRows(page).first().getAttribute("data-job-id");
    await page.getByTestId("filter-sort").click();
    await page.locator('[data-testid="filter-sort-option"][data-value="first_seen"]').click();
    await expect(page).toHaveURL(/sort=first_seen/);
    await expect.poll(async () => listRows(page).first().getAttribute("data-job-id")).not.toBe(first);
  });

  test("the column heads sort; a second click flips the direction, missing salaries stay last, the URL keeps it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/jobs");
    await expect(page.getByTestId("sort-head-score")).toHaveAttribute("data-sort-dir", "desc");
    await page.getByTestId("sort-head-salary").click();
    await expect(page).toHaveURL(/\/jobs\?sort=salary$/);
    await expect(page.getByTestId("sort-head-salary")).toHaveAttribute("data-sort-dir", "desc");
    await expect(page.getByTestId("sort-head-salary")).toHaveAccessibleName("年薪，当前降序，点击改为升序");
    const rows = listRows(page);
    await expect(rows.first().locator('[data-salary-state="stated"]')).toBeVisible();
    const topDesc = await rows.first().getAttribute("data-job-id");

    await page.getByTestId("sort-head-salary").click();
    await expect(page).toHaveURL(/sort=salary&dir=asc/);
    await expect(page.getByTestId("sort-head-salary")).toHaveAttribute("data-sort-dir", "asc");
    await expect.poll(() => rows.first().getAttribute("data-job-id")).not.toBe(topDesc);
    await expect(rows.first().locator('[data-salary-state="stated"]')).toBeVisible();
    // a job without a salary is last in both directions
    await expect(rows.last().locator('[data-salary-state="stated"]')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("sort-head-salary")).toHaveAttribute("data-sort-dir", "asc");

    // the keyboard reaches a head and Enter follows it: another column starts with its default direction
    await page.getByTestId("sort-head-fresh").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/jobs\?sort=first_seen$/);
    await expect(page.getByTestId("sort-head-fresh")).toHaveAttribute("data-sort-active", "true");
    await expect(page.getByTestId("sort-status")).toHaveText("已按新鲜度降序排序");
  });
});

test.describe("seen state on /jobs", () => {
  // a seeded job no other spec opens
  const TITLE = "AI Consultant (via agency)";
  const LIST = "/jobs?q=AI+Consultant&filtered=true";

  test("an unseen job is bold with a dot (card at 390px too); 'unseen only' keeps it; u marks it seen", async ({ page }) => {
    const id = await withDb(async (sql) => {
      const [row] = await sql<{ id: string }[]>`select id from jobs where title = ${TITLE}`;
      await sql`delete from job_seen where job_id = ${row!.id}`;
      return Number(row!.id);
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, LIST);
    const row = listRow(page, id);
    await expect(row).toHaveAttribute("data-seen", "false");
    await expect(row.locator("[data-slot=unseen-dot]")).toBeVisible();
    await expect(row).toHaveAccessibleName(new RegExp(`^未看：${TITLE.replace(/[()]/g, "\\$&")}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("toggle-unseen").click();
    await expect(page).toHaveURL(/unseen=true/);
    await expect(page.getByTestId("toggle-unseen")).toHaveAttribute("data-active", "true");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("unseen-count")).toHaveAttribute("data-count", "1");

    await row.focus();
    await page.keyboard.press("u");
    await expect(row).toHaveAttribute("data-seen", "true");
    await expect.poll(() => withDb(async (sql) => (await sql`select via from job_seen where job_id = ${id}`)[0]?.via ?? null)).toBe("action");
    // seen, it leaves the "unseen only" list on the next load
    await page.reload();
    await expect(listRow(page, id)).toHaveCount(0);
    await expect(page.getByTestId("unseen-count")).toHaveCount(0);
    await page.getByTestId("toggle-unseen").click();
    await expect(page).not.toHaveURL(/unseen=/);
    await expect(listRow(page, id)).toHaveAttribute("data-seen", "true");
  });
});


test.describe("closing jobs on /jobs", () => {
  // a seeded job no other spec opens; the detail page's test (detail-v3) uses it too, so both take the same advisory lock
  const TITLE = "Staff Engineer, Developer Experience";
  const LIST = "/jobs?q=Developer+Experience&filtered=true";
  const count = async (page: Page) => Number(((await page.getByTestId("toggle-closed").textContent()) ?? "").replace(/\D/g, ""));
  const override = (id: number) => withDb(async (sql) => (await sql<{ action: string }[]>`select action::text from job_closure_overrides where job_id = ${id}`)[0]?.action ?? null);

  test("the row button and c close a job (with undo), it leaves the list, 'Closed (N)' lists it, and reopening brings it back", async ({ page }) => {
    const lock = postgres(E2E_URL, { max: 1, onnotice: () => {} });
    await lock`select pg_advisory_lock(117)`;
    try {
      const id = await withDb(async (sql) => {
        const [row] = await sql<{ id: string }[]>`select id from jobs where title like ${`${TITLE}%`}`;
        await sql`delete from job_closure_overrides where job_id = ${row!.id}`;
        return Number(row!.id);
      });
      const row = listRow(page, id);

      // 390px: the fourth button sits inside the card and the page does not scroll sideways
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, LIST);
      const close = row.getByTestId("row-close");
      await expect(close).toBeVisible();
      const [card, button] = await Promise.all([row.boundingBox(), close.boundingBox()]);
      expect(button!.x + button!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, LIST);
      const before = await count(page);
      await row.hover();
      await row.getByRole("button", { name: /标记为已关闭$/ }).click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => override(id)).toBe("closed");
      await expect.poll(() => count(page)).toBe(before + 1);
      await page.getByRole("button", { name: "撤销" }).click();
      await expect(row).toBeVisible();
      await expect.poll(() => override(id)).toBeNull();

      await row.focus();
      await page.keyboard.press("c");
      await expect(row).toHaveCount(0);
      await expect.poll(() => override(id)).toBe("closed");

      await page.getByTestId("toggle-closed").click();
      await expect(page).toHaveURL(/status=closed&status=possibly_closed/);
      await expect(page.getByTestId("toggle-closed")).toHaveAttribute("data-active", "true");
      const chip = row.locator('[data-slot="job-status-chip"]');
      await expect(chip).toHaveAttribute("data-reason", "manual");
      await expect(chip).toContainText("你标记的已关闭");
      await expect(row.getByTestId("row-close")).toHaveAttribute("aria-pressed", "true");
      await row.hover();
      await row.getByTestId("row-close").click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => override(id)).toBeNull();
      await page.getByTestId("toggle-closed").click();
      await expect(page).not.toHaveURL(/status=/);
      await expect(row).toBeVisible();
    } finally {
      await withDb((sql) => sql`delete from job_closure_overrides where job_id in (select id from jobs where title like ${`${TITLE}%`})`);
      await lock`select pg_advisory_unlock(117)`;
      await lock.end({ timeout: 5 });
    }
  });
});
