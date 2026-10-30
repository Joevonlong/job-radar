import { expect, test, type Page } from "./fixtures";

import { EXCLUSIVE_TAG } from "./projects";
import { expectNoLeavingRows, listRow, listRows } from "./list-rows";

/**
 * Dashboard v1 on the seeded e2e database (see e2e/global-setup.ts). Fictional seed jobs used here:
 *  - "LLM Engineer" (Brumbach Analytics GmbH): no application yet, the status/notes test changes it
 *  - "Lindenhof Data" job: status/key tests toggle it back, so other tests see a clean state
 * The UI is Chinese by default.
 */

const EXCLUSIVE = { tag: EXCLUSIVE_TAG };

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/** Type into a number filter and wait for the URL: retried, because text typed before the page has hydrated is thrown away. */
async function fillFilter(page: Page, testId: string, value: string, url: RegExp) {
  await expect(async () => {
    await page.getByTestId(testId).fill(value);
    await expect(page).toHaveURL(url, { timeout: 2500 });
  }).toPass({ timeout: 20_000 });
}

test.describe("Today, detail and status", () => {
  test.describe.configure({ mode: "serial" });

  test("Today shows the cycle strip and the seeded jobs of today, best rank first", async ({ page }) => {
    await open(page, "/");
    await expect(page.getByRole("heading", { level: 1, name: "今日" })).toBeVisible();

    const strip = page.getByTestId("cycle-summary");
    await expect(strip).toContainText("早轮");
    await expect(strip.locator('[data-channel="xing"]')).toHaveAttribute("data-state", "circuit_open");
    await expect(strip.locator('[data-channel="greenhouse"]')).toHaveAttribute("data-state", "ok");

    const rows = listRows(page);
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    await expect(rows.first()).toContainText("Applied Scientist, Clinical NLP");
    await expect(page.getByRole("link", { name: /LLM Engineer/ })).toBeVisible();
    // ignored and hard-filtered jobs are not part of Today
    await expect(page.getByRole("link", { name: /ML Platform Engineer/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Site Reliability Engineer/ })).toHaveCount(0);
  });

  test("open a job, set it to interested, add a note; the list shows the status chip", async ({ page }) => {
    await open(page, "/");
    await page.getByRole("link", { name: /LLM Engineer/ }).click();
    await expect(page).toHaveURL(/\/jobs\/\d+$/);
    await expect(page.getByTestId("job-title")).toHaveText("LLM Engineer");
    await expect(page.getByTestId("job-company")).toHaveText("Brumbach Analytics GmbH");

    // the pay block states the salary bound, the AI blocks are placeholders or fake seed data
    await expect(page.getByTestId("salary-normalized")).toContainText("120k");
    await expect(page.getByTestId("jd-body")).toContainText("What we offer");
    await expect(page.getByTestId("view-posting-button")).toHaveAttribute("href", /example/);

    const detailUrl = page.url();
    await page.getByTestId("status-select").selectOption("interested");
    await expect(page.getByText("状态已改为 感兴趣")).toBeVisible();

    await page.getByTestId("notes-input").fill("Ask about the team size.");
    await page.getByTestId("notes-save").click();
    await expect(page.getByTestId("notes-state")).toHaveText("备注已保存");

    // survives a reload, and left an event
    await page.reload();
    await expect(page.getByTestId("status-select")).toHaveValue("interested");
    await expect(page.getByTestId("notes-input")).toHaveValue("Ask about the team size.");
    await expect(page.getByTestId("status-history")).toContainText("感兴趣");

    // back to the list: the chip is there
    await page.getByTestId("back-link").click();
    await page.waitForURL((url) => !url.pathname.startsWith("/jobs/"));
    const row = listRows(page).filter({ hasText: "LLM Engineer" });
    await expect(row.locator('[data-slot="status-chip"]')).toHaveText("感兴趣");

    // and on /jobs
    await open(page, "/jobs?q=LLM+Engineer");
    await expect(listRows(page).filter({ hasText: "LLM Engineer" }).locator('[data-slot="status-chip"]')).toHaveText("感兴趣");
    expect(detailUrl).toMatch(/\/jobs\/\d+$/);
  });

  test("keyboard: j/k move focus, Enter opens, s toggles interested, x ignores and undo restores", async ({ page }) => {
    await open(page, "/");
    // other specs change the statuses of other Today jobs at the same time: only the Lindenhof row and its neighbour are counted on
    const rows = listRows(page);

    await page.keyboard.press("j");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(rows.nth(0)).toBeFocused();

    // s on the Lindenhof row: new -> interested -> new
    const lindenhof = listRows(page).filter({ hasText: "Lindenhof Data" });
    const index = await rows.evaluateAll((els) => els.findIndex((el) => el.textContent?.includes("Lindenhof Data")));
    for (let i = 0; i < index; i += 1) await page.keyboard.press("j");
    await expect(lindenhof).toBeFocused();
    const before = await lindenhof.getAttribute("data-status");
    await page.keyboard.press("s");
    await expect(lindenhof).toHaveAttribute("data-status", before === "interested" ? "new" : "interested");
    await page.keyboard.press("s");
    await expect(lindenhof).toHaveAttribute("data-status", before ?? "new");

    // x hides the row from Today, the focus moves on to the next row, and the toast offers undo
    const nextId = (await rows.nth(index + 1).getAttribute("data-job-id")) ?? "";
    await page.keyboard.press("x");
    await expect(listRows(page).filter({ hasText: "Lindenhof Data" })).toHaveCount(0);
    await expect(listRow(page, nextId)).toBeFocused();
    // and the ignored row does finish leaving
    await expectNoLeavingRows(page);
    // (the toast of the earlier s may still be on screen: take the ignore's own)
    await page.locator("[data-sonner-toast]", { hasText: "已忽略" }).getByRole("button", { name: "撤销" }).click();
    await expect(listRows(page).filter({ hasText: "Lindenhof Data" })).toHaveCount(1);
    await expect(listRow(page, nextId)).toHaveCount(1);
    // the restored row has the focus again
    await expect(lindenhof).toBeFocused();

    // Enter on a focused row follows its link
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/jobs\/\d+$/);
  });

  test("s (interested) offers an undo like x does, and the undo puts the status back", async ({ page }) => {
    // a job no other spec touches (the others run in parallel)
    await open(page, "/jobs?q=MLOps+Engineer");
    const row = listRows(page).filter({ hasText: "Windrose Mobility" });
    await row.focus();
    const before = await row.getAttribute("data-status");
    expect(before).toBe("new");
    await page.keyboard.press("s");
    await expect(row).toHaveAttribute("data-status", "interested");
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(row).toHaveAttribute("data-status", "new");
  });

  test("keys are ignored while typing in a field", async ({ page }) => {
    await open(page, "/jobs");
    const search = page.getByRole("searchbox");
    await search.focus();
    await page.keyboard.type("jxk");
    await expect(search).toHaveValue("jxk");
    await expect(page.locator("[data-job-id]:focus")).toHaveCount(0);
  });
});

// The tests marked EXCLUSIVE compare counts of the whole list; other specs ignore, close or add jobs while the parallel
// project runs, so these run in the "chromium-exclusive" project, one at a time, after it (see e2e/projects.ts).
test.describe("/jobs filters", () => {
  test("filter by source: URL carries it, a reload keeps it, results shrink", EXCLUSIVE, async ({ page }) => {
    await open(page, "/jobs");
    const total = Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    expect(total).toBeGreaterThan(10);

    await page.getByTestId("filter-source").click();
    await page.locator('[data-testid="filter-source-option"][data-value="xing"]').click();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/[?&]source=xing/);
    await expect(page.getByTestId("result-count")).not.toHaveText(`共 ${total} 条`);
    const filtered = Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(total);

    await page.reload();
    await expect(page).toHaveURL(/[?&]source=xing/);
    await expect(page.getByTestId("filter-source")).toHaveText("XING");
    await expect(page.getByTestId("result-count")).toHaveText(`共 ${filtered} 条`);
  });

  test("two sources = the union: the count is at least each one's, the URL repeats the key", EXCLUSIVE, async ({ page }) => {
    const count = async () => Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    await open(page, "/jobs?source=xing");
    const xing = await count();
    await open(page, "/jobs?source=ats");
    const ats = await count();
    await open(page, "/jobs?source=xing&source=ats");
    const both = await count();
    expect(both).toBeGreaterThanOrEqual(Math.max(xing, ats));
    expect(both).toBeLessThanOrEqual(xing + ats);
    await expect(page.getByTestId("filter-source")).toContainText("+1");
  });

  test("search, salary toggle and sort persist in the URL; clear resets them", async ({ page }) => {
    await open(page, "/jobs");
    await page.getByRole("searchbox").fill("engineer");
    await expect(page).toHaveURL(/[?&]q=engineer/);
    await page.getByTestId("filter-salary").click();
    await expect(page).toHaveURL(/salary=true/);
    await page.getByTestId("filter-sort").click();
    await page.locator('[data-testid="filter-sort-option"][data-value="posted"]').click();
    await expect(page).toHaveURL(/sort=posted/);

    await page.reload();
    await expect(page.getByRole("searchbox")).toHaveValue("engineer");
    await expect(page.getByTestId("filter-salary")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-sort")).toHaveAttribute("data-value", "posted");

    await page.getByTestId("filter-clear").click();
    await expect(page).not.toHaveURL(/q=|salary=/);
    await expect(page.getByRole("searchbox")).toHaveValue("");
  });

  test("application status: ignored jobs can be found again, several statuses combine, the URL carries them", EXCLUSIVE, async ({ page }) => {
    await open(page, "/jobs");
    const total = Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    await page.getByTestId("filter-app-archived").click();
    await expect(page).toHaveURL(/[?&]app=archived/);
    // the seed ignored "ML Platform Engineer": it is not on Today, but this is the way back to it
    await expect(page.getByTestId("result-count")).toHaveText("共 1 条");
    const row = listRows(page).filter({ hasText: "ML Platform Engineer" });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-slot="status-chip"]')).toHaveText("已忽略");

    await page.getByTestId("filter-app-interested").click();
    await expect(page).toHaveURL(/app=interested&app=archived/);
    await expect.poll(async () => Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""))).toBeGreaterThan(1);

    await page.reload();
    await expect(page.getByTestId("filter-app-archived")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-app-interested")).toHaveAttribute("aria-pressed", "true");

    // "new" = no application yet: most of the list
    await open(page, "/jobs?app=new");
    const fresh = Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    expect(fresh).toBeGreaterThan(total / 2);
    expect(fresh).toBeLessThan(total);
  });

  test("minimum score: only rows at or above it, kept in the URL", async ({ page }) => {
    await open(page, "/jobs");
    await fillFilter(page, "filter-min-score", "90", /minScore=90/);
    // the list follows the URL a moment later: every row left is ranked 90 or more, and there are some
    await expect
      .poll(async () => {
        const ranks = await listRows(page).locator("[data-rank]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-rank-value"))));
        const rows = await listRows(page).count();
        return rows > 0 && ranks.length === rows && Math.min(...ranks) >= 90;
      })
      .toBe(true);

    await page.reload();
    await expect(page.getByTestId("filter-min-score")).toHaveValue("90");
    await page.getByTestId("filter-min-score").fill("");
    await expect(page).not.toHaveURL(/minScore/, { timeout: 15_000 });
  });

  test("minimum salary: the stated annual cap decides, jobs without a salary drop out only while it is set", EXCLUSIVE, async ({ page }) => {
    const count = async () => Number(((await page.getByTestId("result-count").textContent()) ?? "").replace(/\D/g, ""));
    await open(page, "/jobs");
    const all = await count();
    // "Applied Scientist, Clinical NLP" states EUR 90,000 to 110,000 per year
    await fillFilter(page, "filter-min-salary", "100000", /minSalary=100000/);
    await expect(listRows(page).filter({ hasText: "Applied Scientist, Clinical NLP" })).toBeVisible();
    // the list follows the URL a moment later
    await expect.poll(count).toBeLessThan(all);
    const withSalary = await count();
    expect(withSalary).toBeGreaterThan(0);
    // every row left states a salary, drawn on the mini axis
    await expect(listRows(page)).toHaveCount(withSalary);
    await expect(listRows(page).locator("[data-salary-state]:not([data-salary-state=none])")).toHaveCount(withSalary);

    await fillFilter(page, "filter-min-salary", "110001", /minSalary=110001/);
    await expect(listRows(page).filter({ hasText: "Applied Scientist, Clinical NLP" })).toHaveCount(0);
    await expectNoLeavingRows(page);

    await page.getByTestId("filter-min-salary").fill("");
    await expect(page).not.toHaveURL(/minSalary/, { timeout: 15_000 });
    await expect.poll(count, { timeout: 15_000 }).toBe(all);
  });

  test("a row shows the AI summary and the salary on the mini axis", async ({ page }) => {
    await open(page, "/jobs?q=Applied+Scientist");
    const row = listRows(page).filter({ hasText: "Applied Scientist, Clinical NLP" });
    await expect(row.locator('[data-slot="job-summary"]')).toHaveText("Applied Scientist, Clinical NLP 的虚构摘要。");
    await expect(row.locator('[data-salary-state="stated"]')).toContainText("€90–110k");
  });

  test("an impossible combination shows the empty state", async ({ page }) => {
    await open(page, "/jobs?q=zzzznothing");
    await expect(page.getByTestId("job-list-empty")).toContainText("没有符合条件的岗位");
  });
});

test.describe("a comma in the search text", () => {
  // a touch screen prefetches the links of the page as soon as they are in view: the one with `q=ai,ml` used to stay pending for good
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the links to the same page are spelled the way Next spells them, so their prefetch finishes", async ({ page }) => {
    await page.goto("/jobs?q=ai%2Cml&filtered=true");
    await expect(page.getByTestId("result-count")).toBeVisible();
    await expect(page.getByTestId("toggle-filtered")).toHaveAttribute("href", "/jobs?q=ai%2Cml");
    // every request, the prefetches included, finishes
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  });

  test("typing the text into the search box gives a URL that carries it, a list and a page that settles", async ({ page }) => {
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    await expect(async () => {
      await page.getByRole("searchbox").fill("ai,ml");
      await expect(page).toHaveURL(/[?&]q=ai(,|%2C)ml/, { timeout: 2500 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("result-count")).toBeVisible();
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
    await page.reload();
    await expect(page.getByRole("searchbox")).toHaveValue("ai,ml");
  });
});

test.describe("English and light theme", () => {
  test("the detail page renders in English with the light theme", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    await open(page, "/jobs?q=Applied+Scientist");
    await page.getByRole("link", { name: /Applied Scientist/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Pay and benefits" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Sources" })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/light/);
  });
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("/jobs: the filters sit behind a Filters (n) sheet and the list starts on the first screen", async ({ page }) => {
    await open(page, "/jobs");
    await expect(page.getByTestId("filter-panel")).toBeHidden();
    await expect(page.getByTestId("filter-toggle")).toHaveText("筛选");
    // On a phone the search field has its own row and "包含职位说明" + "筛选" share the next one; the list still
    // starts within the top 480px of the 844px screen and its first row is fully visible.
    const firstRow = listRows(page).first();
    const box = await firstRow.boundingBox();
    expect(box?.y ?? 9999).toBeLessThan(480);
    expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(844);

    await page.getByTestId("filter-toggle").click();
    await expect(page.getByTestId("filter-panel")).toBeVisible();
    await page.getByTestId("filter-app-archived").click();
    await expect(page).toHaveURL(/[?&]app=archived/);
    await page.getByTestId("filter-apply").click();
    await expect(page.getByTestId("filter-panel")).toBeHidden();
    await expect(page.getByTestId("filter-toggle")).toHaveText("筛选 (1)");
    await expect(listRows(page).filter({ hasText: "ML Platform Engineer" })).toBeVisible();

    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(widths[0]).toBeLessThanOrEqual(widths[1] ?? 390);
  });

  test("Today, Jobs and Job detail do not scroll horizontally", async ({ page }) => {
    await open(page, "/");
    await page.getByRole("link", { name: /Applied Scientist/ }).click();
    await page.waitForURL(/\/jobs\/\d+$/);
    const detail = page.url();

    for (const path of ["/", "/jobs", new URL(detail).pathname]) {
      await open(page, path);
      const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(widths[0], `${path} scrollWidth`).toBeLessThanOrEqual(widths[1] ?? 390);
    }
  });
});
