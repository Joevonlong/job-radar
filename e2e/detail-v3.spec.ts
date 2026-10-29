import { expect, test } from "./fixtures";
import postgres from "postgres";
import { listRow } from "./list-rows";

/**
 * Job detail v3 on the seeded e2e database. "Applied Scientist, Clinical NLP": rank 106 = 91 + 15 (T1 salary
 * range + T2 equity, both quoted from its JD, bonus 18 capped at 15), a stated salary of EUR 90,000-110,000.
 */
const TITLE = "Applied Scientist, Clinical NLP";

async function openDetail(page: import("./fixtures").Page) {
  await page.goto("/jobs?q=Clinical+NLP");
  await page.getByRole("link", { name: new RegExp(TITLE) }).first().click();
  await expect(page.getByTestId("job-title")).toHaveText(TITLE);
}

test.describe("job detail v3", () => {
  test("shows the score meter, the composition, the salary axis and the cap bar", async ({ page }) => {
    await openDetail(page);
    await expect(page.getByRole("meter", { name: "排序值" })).toBeVisible();
    await expect(page.getByTestId("rank-breakdown")).toContainText("+15");
    // the cap bar adds up to the bonus of the rank value
    await expect(page.getByTestId("cap-bar")).toHaveAttribute("data-total", "18");
    await expect(page.getByTestId("cap-bar")).toHaveAttribute("data-counted", "15");
    await expect(page.getByTestId("cap-bar-bonus")).toHaveText("+15");
    await expect(page.getByTestId("salary-card-figure")).toContainText("€90–110k");
    await expect(page.locator("[data-salary-state]").first()).toBeVisible();
    await expect(page.getByTestId("checks-panel")).toContainText("德语");
    // the run has its own profile directory: with no preferences.yaml there is no floor to compare with
    await expect(page.getByTestId("floor-check")).toHaveAttribute("data-state", /^(pass|no_floor)$/);
  });

  test("a rank above 100 shows its real number and no '?' placeholders", async ({ page }) => {
    await openDetail(page);
    const meter = page.getByRole("meter", { name: "排序值" });
    await expect(meter).toHaveAttribute("aria-valuenow", "106");
    await expect(meter).toHaveAttribute("aria-valuemax", "106"); // /100 like the list and the board; a value past it raises the max to itself
    await expect(page.locator(".jr-score__n")).toContainText("106");
    await expect(page.locator(".jr-score__o")).toHaveText("+6");
    const meta = page.getByTestId("score-meta");
    if (await meta.count()) await expect(meta).not.toContainText("?");
  });

  test("a signal tag scrolls the JD to its sentence and flashes it", async ({ page }) => {
    await openDetail(page);
    const tag = page.getByTestId("jump-tag").nth(1);
    await expect(tag).toBeVisible();
    const index = await tag.getAttribute("data-quote-index");
    await tag.click();
    const mark = page.locator(`#jd-quote-${index}`);
    await expect(mark).toHaveClass(/jr-flash/);
    await expect(mark).toBeInViewport();
  });

  test("a tag whose sentence is not in the JD has no jump", async ({ page }) => {
    await openDetail(page);
    // every seeded quote is in the JD: all rows carry a jump tag and are marked as such
    for (const item of await page.getByTestId("signal-item").all()) {
      await expect(item).toHaveAttribute("data-in-jd", "true");
      await expect(item.getByTestId("jump-tag")).toHaveCount(1);
    }
  });

  test("has no horizontal scroll at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDetail(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

/** What a navigation did with the View Transitions API: how many it started, which names it paired, how long the morph lasts. */
async function watchTransitions(page: import("./fixtures").Page, options: { unsupported?: boolean } = {}) {
  await page.addInitScript((unsupported) => {
    const w = window as unknown as { __vt: { calls: number; names: string[]; durations: number[] } };
    w.__vt = { calls: 0, names: [], durations: [] };
    const original = document.startViewTransition?.bind(document);
    if (unsupported || !original) {
      // a browser without the API: React must simply render the page
      (document as unknown as { startViewTransition?: unknown }).startViewTransition = undefined;
      return;
    }
    document.startViewTransition = (...args: Parameters<typeof original>) => {
      w.__vt.calls += 1;
      const transition = original(...args);
      void transition.ready
        .then(() => {
          const names = new Set<string>();
          for (const el of document.querySelectorAll("*")) {
            const name = getComputedStyle(el).viewTransitionName;
            if (name && name !== "none") names.add(name);
          }
          w.__vt.names = [...names];
          w.__vt.durations = document
            .getAnimations()
            .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition-group(job-"))
            .map((a) => Number(a.effect?.getComputedTiming().duration));
        })
        .catch(() => undefined);
      return transition;
    };
  }, options.unsupported ?? false);
  return () => page.evaluate(() => (window as unknown as { __vt: { calls: number; names: string[]; durations: number[] } }).__vt);
}

test.describe("job detail: shared-element transition from the list", () => {
  test("a click on a list title runs a view transition that pairs the title and the score", async ({ page }) => {
    const seen = await watchTransitions(page);
    await page.goto("/jobs?q=Clinical+NLP");
    await page.getByRole("link", { name: new RegExp(TITLE) }).first().click();
    await expect(page.getByTestId("job-title")).toHaveText(TITLE);
    await expect.poll(async () => (await seen()).calls).toBeGreaterThan(0);
    await expect.poll(async () => (await seen()).names.length).toBeGreaterThan(0);
    const result = await seen();
    expect(result.names.some((name) => name.endsWith("-title"))).toBe(true);
    expect(result.names.some((name) => name.endsWith("-score"))).toBe(true);
    // the same job id on both ends (the names are paired, not two different jobs)
    expect(new Set(result.names.map((name) => name.split("-")[1])).size).toBe(1);
    // the morph takes the motion token's time
    await expect.poll(async () => Math.max(0, ...(await seen()).durations)).toBeGreaterThan(0);
  });

  test("a browser without View Transitions just navigates", async ({ page }) => {
    const seen = await watchTransitions(page, { unsupported: true });
    await page.goto("/jobs?q=Clinical+NLP");
    await page.getByRole("link", { name: new RegExp(TITLE) }).first().click();
    await expect(page.getByTestId("job-title")).toHaveText(TITLE);
    expect((await seen()).calls).toBe(0);
  });
});

test.describe("job detail: shared-element transition with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the transition has no duration, the page just switches", async ({ page }) => {
    const seen = await watchTransitions(page);
    await page.goto("/jobs?q=Clinical+NLP");
    await page.getByRole("link", { name: new RegExp(TITLE) }).first().click();
    await expect(page.getByTestId("job-title")).toHaveText(TITLE);
    await expect.poll(async () => (await seen()).durations.length).toBeGreaterThan(0);
    expect(Math.max(...(await seen()).durations)).toBe(0);
  });
});

test.describe("job detail: actions and focus", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the header actions are one row at 1440, the filter decision is in the more menu", async ({ page }) => {
    await openDetail(page);
    const apply = await page.getByTestId("view-posting-button").boundingBox();
    const more = page.getByTestId("action-more");
    const moreBox = await more.boundingBox();
    const translate = await page.getByTestId("action-translate").boundingBox();
    expect(apply && moreBox && translate).toBeTruthy();
    expect(Math.abs((moreBox?.y ?? 0) - (apply?.y ?? 99))).toBeLessThan(2);
    expect(Math.abs((translate?.y ?? 0) - (apply?.y ?? 99))).toBeLessThan(2);
    await more.click();
    // the filter decision and "mark as unseen"
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    await expect(page.getByTestId("filter-override-exclude")).toBeVisible();
    await expect(page.getByTestId("action-mark-unseen")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
  });

  test("Status & notes scrolls to the panel and leaves the focus on the status select", async ({ page }) => {
    await openDetail(page);
    await page.getByTestId("action-status").click();
    await expect(page.locator("#job-status")).toBeFocused();
    await expect(page.locator("#job-status")).toBeInViewport();
  });

  test("links, the back link and the notes box show a focus ring", async ({ page }) => {
    await openDetail(page);
    await page.getByTestId("back-link").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("back-link")).toBeFocused();
    await expect.poll(() => page.getByTestId("back-link").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.getByTestId("notes-input").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("notes-input")).toBeFocused();
    expect(await page.getByTestId("notes-input").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("the median line says its scope and sample", async ({ page }) => {
    await openDetail(page);
    await expect(page.getByTestId("salary-median")).toContainText("中位 · 本月");
    await expect(page.getByTestId("salary-median")).toContainText("个：");
  });
});

// the database of this run: playwright.config.ts exports its address (E2E_DATABASE_URL) to the workers
const E2E_URL = process.env.E2E_DATABASE_URL ?? "";

async function seenVia(jobId: number): Promise<string | null> {
  const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ via: string }[]>`select via from job_seen where job_id = ${jobId}`;
    return row?.via ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe("job detail: seen state", () => {
  test.describe.configure({ mode: "serial" });

  test("showing the page marks the job seen; 'mark as unseen' takes it back; the posting link marks it again", async ({ page, context }) => {
    await openDetail(page);
    const jobId = Number(await page.getByTestId("job-detail").getAttribute("data-job-id"));
    await expect.poll(() => seenVia(jobId)).not.toBeNull();

    await page.getByTestId("action-more").click();
    await page.getByTestId("action-mark-unseen").click();
    await expect.poll(() => seenVia(jobId)).toBeNull();
    // fetching the page without showing it (a prefetch, a link preview, curl) writes no row
    expect((await page.request.get(`/jobs/${jobId}`)).ok()).toBe(true);
    await page.request.get(`/jobs/${jobId}`, { headers: { RSC: "1", "Next-Router-Prefetch": "1" } });
    await page.waitForTimeout(500);
    expect(await seenVia(jobId)).toBeNull();
    // back on the list it is bold again
    await page.goto("/jobs?q=Clinical+NLP");
    await expect(listRow(page, jobId)).toHaveAttribute("data-seen", "false");

    // following the posting link (a new tab) marks it seen, as "source", without opening the detail page
    await context.route(/\.example\//, (route) => route.fulfill({ status: 200, body: "posting" }));
    await page.goto(`/jobs/${jobId}`);
    await page.getByTestId("action-more").click();
    await page.getByTestId("action-mark-unseen").click();
    await expect.poll(() => seenVia(jobId)).toBeNull();
    const popup = context.waitForEvent("page");
    await page.getByTestId("view-posting-button").click();
    await (await popup).close();
    await expect.poll(() => seenVia(jobId)).toBe("source");
  });
});


test.describe("job detail: closing a job", () => {
  // a seeded job no other spec opens; list-v3 closes it too, so both take the same advisory lock
  const CLOSE_TITLE = "Staff Engineer, Developer Experience";
  const override = async (id: number) => {
    const sql = postgres(E2E_URL, { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ action: string; note: string | null }[]>`select action::text, note from job_closure_overrides where job_id = ${id}`;
      return row ? `${row.action}:${row.note ?? ""}` : null;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  test("mark as closed with a note, undo, close again, find it in 'Archive (N)', reopen", async ({ page }) => {
    const lock = postgres(E2E_URL, { max: 1, onnotice: () => {} });
    await lock`select pg_advisory_lock(117)`;
    try {
      const [job] = await lock<{ id: string }[]>`select id from jobs where title like ${`${CLOSE_TITLE}%`}`;
      const id = Number(job!.id);
      await lock`delete from job_closure_overrides where job_id = ${id}`;

      await page.goto(`/jobs/${id}`);
      await page.getByTestId("detail-close").click();
      await page.getByTestId("detail-close-note").fill("Recruiter said the role is filled");
      await page.getByTestId("detail-close-submit").click();
      await expect.poll(() => override(id)).toBe("closed:Recruiter said the role is filled");
      await expect(page.getByTestId("detail-header").locator('[data-slot="job-status-chip"]')).toContainText("你标记的已关闭");
      await expect(page.getByTestId("closure-note")).toContainText("Recruiter said the role is filled");
      await expect(page.getByTestId("detail-reopen")).toBeVisible();

      await page.getByRole("button", { name: "撤销" }).click();
      await expect.poll(() => override(id)).toBeNull();
      await expect(page.getByTestId("detail-reopen")).toHaveCount(0);
      await expect(page.getByTestId("detail-header").locator('[data-slot="job-status-chip"]')).toHaveCount(0);

      await page.getByTestId("detail-close").click();
      await page.getByTestId("detail-close-submit").click();
      await expect.poll(() => override(id)).toBe("closed:");

      await page.goto("/jobs?q=Developer+Experience&filtered=true");
      await expect(listRow(page, id)).toHaveCount(0);
      await page.getByTestId("scope-archive").click();
      await expect(listRow(page, id)).toBeVisible();
      await page.getByRole("link", { name: new RegExp(CLOSE_TITLE) }).first().click();
      await expect(page.getByTestId("job-title")).toContainText(CLOSE_TITLE);
      await page.getByTestId("detail-reopen").click();
      await expect.poll(() => override(id)).toBeNull();
      await expect(page.getByTestId("detail-close")).toBeVisible();
    } finally {
      await lock`delete from job_closure_overrides where job_id in (select id from jobs where title like ${`${CLOSE_TITLE}%`})`;
      await lock`select pg_advisory_unlock(117)`;
      await lock.end({ timeout: 5 });
    }
  });
});

for (const locale of ["en", "zh"] as const) {
  test(`a dormant detail explains its last listing and Still open restores it (${locale})`, async ({ page, context, baseURL }) => {
    if (!baseURL) throw new Error("The e2e run must configure baseURL");
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    const sql = postgres(process.env.E2E_DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
    await sql`select pg_advisory_lock(119)`;
    const [job] = await sql<{ id: string }[]>`select id from jobs where title = 'Research Engineer, Document Retrieval'`;
    const id = Number(job!.id);
    try {
      await sql`delete from job_closure_overrides where job_id = ${id}`;
      await sql`update jobs set dormant_at = now() - interval '1 day' where id = ${id}`;
      await page.setViewportSize({ width: 375, height: 844 });
      await page.goto(`/jobs/${id}`);
      await expect(page.getByTestId("closure-notice")).toHaveAttribute("data-reason", "dormant");
      await expect(page.getByTestId("closure-hint")).toContainText(locale === "en" ? "No source has listed" : "已经数周");
      await expect(page.getByTestId("closure-last-listed")).toContainText(locale === "en" ? "Last listed by a source on" : "最后一次被来源列出");
      await expect(page.getByTestId("detail-close")).toContainText(locale === "en" ? "Confirm closed" : "确认已关闭");
      await expect(page.getByTestId("detail-keep-open")).toContainText(locale === "en" ? "Still open" : "仍在招");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByTestId("detail-keep-open").click();
      await expect(page.getByTestId("closure-notice")).toHaveCount(0);
      await expect.poll(async () => (await sql`select dormant_at from jobs where id = ${id}`)[0]!.dormant_at).toBeNull();
      await page.goto("/jobs?q=Document+Retrieval");
      await expect(listRow(page, id)).toBeVisible();
    } finally {
      await sql`delete from job_closure_overrides where job_id = ${id}`;
      await sql`update jobs set dormant_at = now() - interval '1 day' where id = ${id}`;
      await sql`select pg_advisory_unlock(119)`;
      await sql.end({ timeout: 5 });
    }
  });
}
