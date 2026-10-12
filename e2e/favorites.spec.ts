import { expect, test, type Page } from "@playwright/test";
import { listRows } from "./list-rows";

/**
 * The star is independent of the application status. Seeded: "LLM Engineer" (with a note), "Prompt Engineer" (closed,
 * rejected) and "Machine Learning Engineer, Perception" (applied) are starred. Each test has its own job (no other spec uses them) and
 * puts the star back, the file runs in order because the sidebar count and /favorites are shared.
 */

test.describe.configure({ mode: "serial" });

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

const rowOf = (page: Page, title: string) => listRows(page).filter({ hasText: title }).first();
const favCount = async (page: Page): Promise<number> => Number((await page.getByTestId("nav-count-favorites").innerText()).trim());

/** Open a job's detail page by its title in the /jobs list. */
async function openDetail(page: Page, query: string, title: string) {
  await open(page, `/jobs?q=${encodeURIComponent(query)}`);
  await rowOf(page, title).getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
}

test.describe("favorites", () => {
  test("star from a list row: the star and the sidebar count change, /favorites lists it, a note survives a reload, un-starring there removes the row and Undo brings it back with the note", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/jobs?q=NLP+Engineer");
    const row = rowOf(page, "NLP Engineer");
    const before = await favCount(page);
    await row.hover();
    const star = row.getByTestId("row-favorite");
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(row.locator('[data-slot="fav-mark"]')).toBeVisible();
    await expect(row.locator('[data-slot="fav-mark"]')).toContainText("已收藏");
    await expect.poll(() => favCount(page)).toBe(before + 1);
    // the application status did not move
    await expect(row).toHaveAttribute("data-status", "new");

    await open(page, "/favorites");
    const fav = rowOf(page, "NLP Engineer");
    await expect(fav).toBeVisible();
    await expect(fav.locator('[data-slot="fav-note"]')).toContainText("收藏于");
    await fav.getByTestId("fav-note-edit").click();
    await fav.getByTestId("fav-note-input").fill("ask about the team size");
    await fav.getByTestId("fav-note-input").press("Enter");
    await expect(fav.getByTestId("fav-note-edit")).toHaveText("ask about the team size");
    await page.reload();
    await expect(rowOf(page, "NLP Engineer").getByTestId("fav-note-edit")).toHaveText("ask about the team size");
    // typing in the note field does not open the job
    await rowOf(page, "NLP Engineer").getByTestId("fav-note-edit").click();
    await rowOf(page, "NLP Engineer").getByTestId("fav-note-input").click();
    await expect(page).toHaveURL(/\/favorites$/);
    await page.keyboard.press("Escape");

    // un-star on /favorites: the row leaves, the toast has Undo, which restores note and time
    const unstar = rowOf(page, "NLP Engineer");
    await unstar.hover();
    await unstar.getByTestId("row-favorite").click();
    await expect(listRows(page).filter({ hasText: "NLP Engineer" })).toHaveCount(0);
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(rowOf(page, "NLP Engineer")).toBeVisible();
    await expect(rowOf(page, "NLP Engineer").getByTestId("fav-note-edit")).toHaveText("ask about the team size");

    // put it back
    await rowOf(page, "NLP Engineer").hover();
    await rowOf(page, "NLP Engineer").getByTestId("row-favorite").click();
    await expect(listRows(page).filter({ hasText: "NLP Engineer" })).toHaveCount(0);
    await expect.poll(() => favCount(page)).toBe(before);
  });

  for (const locale of ["zh", "en"] as const) {
    test(`the note sits on its own line at 1280px (${locale}): the add button and a short note are tappable, the star label and a long note stay in the cell, a saved note survives a reload`, async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL ?? "http://127.0.0.1:3100" }]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, "/favorites");
      const row = () => rowOf(page, "Prompt Engineer");
      const box = (id: string) => row().getByTestId(id).boundingBox();
      // every control is measured against its own cell: nothing sticks out of it
      const fits = (selector: string) => row().locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth);
      const noteIsAlone = async () => {
        const note = await box("fav-note-edit");
        const label = await row().locator('[data-slot="fav-note"] > span[title]').first().boundingBox();
        expect(note?.y ?? 0).toBeGreaterThanOrEqual((label?.y ?? 0) + (label?.height ?? 0) - 1);
      };

      // no note yet: the button is there, wide enough to hit, and not squeezed beside the star label
      expect((await box("fav-note-edit"))?.width ?? 0).toBeGreaterThanOrEqual(40);
      await noteIsAlone();
      expect(await fits('[data-slot="fav-note"] > span[title]')).toBe(true);
      expect(await fits(".jb-cell--job")).toBe(true);

      // a very short note
      await row().getByTestId("fav-note-edit").click();
      await row().getByTestId("fav-note-input").fill("ok");
      await row().getByTestId("fav-note-input").press("Enter");
      await expect(row().getByTestId("fav-note-edit")).toHaveText("ok");
      expect((await box("fav-note-edit"))?.width ?? 0).toBeGreaterThanOrEqual(40);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(row().getByTestId("fav-note-edit")).toHaveText("ok");
      await noteIsAlone();

      // a long note without a space does not push the cell wider
      const long = "x".repeat(180);
      await row().getByTestId("fav-note-edit").click();
      await row().getByTestId("fav-note-input").fill(long);
      await row().getByTestId("fav-note-input").press("Enter");
      await expect(row().getByTestId("fav-note-edit")).toHaveText(long);
      expect(await fits(".jb-cell--job")).toBe(true);
      expect(await fits('[data-slot="fav-note"] > span[title]')).toBe(true);
      expect((await box("fav-note-edit"))?.width ?? 0).toBeGreaterThanOrEqual(40);

      // put it back
      await row().getByTestId("fav-note-edit").click();
      await row().getByTestId("fav-note-input").fill("");
      await row().getByTestId("fav-note-input").press("Enter");
      await expect(row().getByTestId("fav-note-edit")).toHaveText(locale === "en" ? "Add note" : "添加备注");
    });
  }

  test("the f key toggles the focused row, and it stays starred after a reload", async ({ page }) => {
    await open(page, "/jobs?q=Freelance+ML+Engineer");
    const row = rowOf(page, "Freelance ML Engineer");
    await page.keyboard.press("j");
    await expect(row).toBeFocused();
    await page.keyboard.press("f");
    await expect(row.locator('[data-slot="fav-mark"]')).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(rowOf(page, "Freelance ML Engineer").locator('[data-slot="fav-mark"]')).toBeVisible();
    await page.keyboard.press("j");
    await page.keyboard.press("f");
    await expect(rowOf(page, "Freelance ML Engineer").locator('[data-slot="fav-mark"]')).toHaveCount(0);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(rowOf(page, "Freelance ML Engineer").locator('[data-slot="fav-mark"]')).toHaveCount(0);
  });

  test("/favorites lists the closed and the applied job with their markers; the order switch is in the URL and a bad sort falls back", async ({ page }) => {
    await open(page, "/favorites");
    const closed = rowOf(page, "Prompt Engineer");
    await expect(closed).toBeVisible();
    // The tag says why: the seed's closed job was taken down at the source (404 / 410)
    await expect(closed).toContainText("来源已下架");
    await expect(closed.locator('[data-slot="fav-mark"]')).toBeVisible();
    const applied = rowOf(page, "Machine Learning Engineer, Perception");
    await expect(applied).toHaveAttribute("data-status", "applied");
    await expect(applied.locator('[data-slot="fav-mark"]')).toBeVisible();
    await expect(page.getByTestId("favorites-count")).toContainText(/共 \d+ 个收藏/);
    await expect(page.getByTestId("favorites-count")).toContainText(/已关闭 \d+\/\d+/);

    const order = async () => listRows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-job-id")));
    const starredOrder = await order();
    await page.getByTestId("favorites-sort").getByRole("radio", { name: "排序值" }).click();
    await expect(page).toHaveURL(/sort=rank/);
    await expect.poll(order).not.toEqual(starredOrder);
    await open(page, "/favorites?sort=nonsense");
    await expect(page.getByTestId("favorites-sort").getByRole("radio", { name: "收藏时间" })).toBeChecked();
    expect(await order()).toEqual(starredOrder);
    await expect(page.getByTestId("favorites-filter-link")).toHaveAttribute("href", "/jobs?fav=true");
  });

  test("the detail page star (desktop action row) toggles, persists, and leaves the status alone", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDetail(page, "AI Engineer (Agents)", "AI Engineer (Agents)");
    const button = page.getByTestId("detail-favorite");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toContainText("已收藏");
    // the star shows at once; the save is done when data-saving is gone (a reload before that can cut the request off)
    await expect(button).not.toHaveAttribute("data-saving", /.*/);
    await page.reload();
    await expect(page.getByTestId("detail-favorite")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("detail-favorite").click();
    await expect(page.getByTestId("detail-favorite")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("detail-favorite")).not.toHaveAttribute("data-saving", /.*/);
    await page.reload();
    await expect(page.getByTestId("detail-favorite")).toHaveAttribute("aria-pressed", "false");
  });

  test("the phone bar has an icon star next to the notes button in the first row; it toggles and the bar does not overflow at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDetail(page, "Senior Backend Engineer", "Senior Backend Engineer (Python)");
    const bar = page.getByTestId("mobile-action-bar");
    const star = bar.getByTestId("bar-favorite");
    await expect(star).toBeVisible();
    const box = await star.boundingBox();
    // an icon button like the notes button next to it: same size, same row as the status select
    const notes = await bar.getByTestId("bar-notes-button").boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(Math.round(notes?.width ?? -1));
    expect(Math.round(box?.height ?? 0)).toBe(Math.round(box?.width ?? -1));
    // layout position, not the painted one: a pressed button is moved by --press-d (the shadow collapses), and the star may start pressed
    const layoutTop = (id: string) => bar.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).translate.split(" ")[1] ?? "0") || 0));
    expect(Math.abs((await layoutTop("bar-favorite")) - (await layoutTop("bar-notes-button")))).toBeLessThan(1);
    expect(Math.round(box?.height ?? 0)).toBe(Math.round(notes?.height ?? -1));
    const startedPressed = (await star.getAttribute("aria-pressed")) === "true";
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", String(!startedPressed));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const barBox = await bar.boundingBox();
    expect((barBox?.x ?? 0) + (barBox?.width ?? 0)).toBeLessThanOrEqual(390);
    // a second press right after the first (before the server answered) is not lost
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", String(startedPressed));
    await expect(star).not.toHaveAttribute("data-saving", /.*/);
    await page.reload();
    await expect(page.getByTestId("bar-favorite")).toHaveAttribute("aria-pressed", String(startedPressed));
  });

  test("/jobs?fav=true shows only starred jobs as a removable chip, stacks with other filters, and clear-all lifts it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/jobs");
    const all = await listRows(page).count();
    await page.getByTestId("toggle-fav").click();
    await expect(page).toHaveURL(/fav=true/);
    const only = listRows(page);
    await expect.poll(() => only.count()).toBeLessThan(all);
    for (const el of await only.all()) await expect(el.locator('[data-slot="fav-mark"]')).toBeVisible();
    const starred = await only.count();
    await expect(page.getByTestId("toggle-fav")).toHaveAttribute("data-active", "true");

    // stacks: favorites that are applied
    await open(page, "/jobs?fav=true&app=applied");
    await expect(listRows(page)).toHaveCount(1);
    await expect(rowOf(page, "Machine Learning Engineer, Perception")).toBeVisible();

    // clear all lifts it
    await page.getByTestId("filter-clear").click();
    await expect(page).not.toHaveURL(/fav=/);
    // (more than the starred ones again; not exactly `all`: other specs ignore and close jobs while this runs)
    await expect.poll(() => listRows(page).count()).toBeGreaterThan(starred);

    // the save-view dialog says fav is not stored
    await open(page, "/jobs?fav=true&minScore=60");
    await page.getByTestId("save-view").click();
    await expect(page.getByTestId("save-view-fav-hint")).toContainText("不会存进视图");
  });

  test("the pipeline board marks a starred card with a read-only star", async ({ page }) => {
    await open(page, "/pipeline");
    const starred = page.locator('[data-slot="pipeline-card"]', { hasText: "Machine Learning Engineer, Perception" });
    await expect(starred.locator('[data-slot="fav-mark"]')).toBeVisible();
    await expect(starred.getByRole("button", { name: /收藏/ })).toHaveCount(0);
  });

  test("English: the sidebar entry, the page and the buttons are translated", async ({ page }) => {
    await open(page, "/");
    await page.getByRole("button", { name: "切换语言" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await open(page, "/favorites");
    await expect(page.getByRole("heading", { level: 1, name: "Favorites" })).toBeVisible();
    await expect(page.getByTestId("favorites-count")).toContainText(/Favorites: \d+/);
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Favorites/ })).toHaveAttribute("aria-current", "page");
    await expect(rowOf(page, "Prompt Engineer").getByTestId("row-favorite")).toHaveAttribute("aria-label", /^Remove from favorites/);
  });
});
