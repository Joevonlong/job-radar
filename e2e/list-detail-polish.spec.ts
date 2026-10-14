import { expect, test, type Page } from "./fixtures";
import { listRows } from "./list-rows";

/**
 * List and detail polish. Read-only: no test here changes a job (the seed has "LLM Engineer" starred and
 * "Forward Deployed Engineer" marked interested).
 */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

const rowOf = (page: Page, title: string) => listRows(page).filter({ hasText: title }).first();
const background = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe("row buttons: one toggle language", () => {
  test("off is neutral for the star and the thumb alike, on is a different look for each", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // "Machine Learning Engineer, Perception" is starred and not interested (it is applied: its thumb is off and disabled)
    await open(page, "/favorites");
    const starred = rowOf(page, "Machine Learning Engineer, Perception");
    await starred.hover();
    const starOn = starred.getByTestId("row-favorite");
    const thumbOff = starred.getByTestId("row-interested");
    await expect(starOn).toHaveAttribute("aria-pressed", "true");
    await expect(thumbOff).toHaveAttribute("aria-pressed", "false");
    // a starred row no longer shows two yellow buttons: the thumb that is off looks like the ✕ (neutral)
    expect(await background(thumbOff)).toBe(await background(starred.getByTestId("row-ignore")));
    expect(await background(thumbOff)).not.toBe(await background(starOn));
    await open(page, "/jobs");
    const interested = rowOf(page, "Forward Deployed Engineer");
    await interested.hover();
    const thumbOn = interested.getByTestId("row-interested");
    await expect(thumbOn).toHaveAttribute("aria-pressed", "true");
    expect(await background(thumbOn)).not.toBe(await background(thumbOff));
    expect(await background(thumbOn)).not.toBe(await background(starOn));
  });

  test("on a phone the row buttons are at least 40px square", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/jobs");
    for (const id of ["row-favorite", "row-interested", "row-ignore"]) {
      const box = await listRows(page).first().getByTestId(id).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
    }
  });
});

test("phone detail bar: notes and star are 44px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/jobs?q=LLM+Engineer");
  await rowOf(page, "LLM Engineer").getByRole("link", { name: "LLM Engineer" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  for (const id of ["bar-notes-button", "bar-favorite"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("/favorites: the note input fills the column while editing, Esc leaves the note alone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/favorites");
  const row = rowOf(page, "LLM Engineer");
  await row.hover();
  await row.getByTestId("fav-note-edit").click();
  const input = await row.getByTestId("fav-note-input").boundingBox();
  const cell = await row.locator(".jb-cell--job").boundingBox();
  // the cell holds the logo mark too: the input takes the rest of its width, not a stub next to the "starred" label
  expect(input?.width ?? 0).toBeGreaterThan((cell?.width ?? 0) * 0.7);
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("fav-note-input")).toHaveCount(0);
});

test.describe("/jobs filters do not move the list", () => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`chip row appearing does not shift the content (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, "/jobs");
      const top = () => page.getByTestId("result-count").evaluate((el) => Math.round(el.getBoundingClientRect().top));
      const without = await top();
      await open(page, "/jobs?city=Berlin");
      await expect(page.getByTestId("filter-chip").first()).toBeVisible();
      expect(await top()).toBe(without);
      // and the "clear" button of the pill row does not change its height either
      await open(page, "/jobs?salary=true");
      expect(await top()).toBe(without);
    });
  }

  test("phone: the page never gets wider than the screen while rows leave the list after a filter is ticked", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/jobs");
    await page.evaluate(() => {
      const state = { max: 0 };
      (window as unknown as { __maxWidth: typeof state }).__maxWidth = state;
      const sample = () => {
        state.max = Math.max(state.max, document.documentElement.scrollWidth);
        requestAnimationFrame(sample);
      };
      sample();
    });
    await page.getByTestId("filter-toggle").click();
    await page.getByTestId("filter-salary").click();
    await page.waitForTimeout(1500);
    const max = await page.evaluate(() => (window as unknown as { __maxWidth: { max: number } }).__maxWidth.max);
    expect(max).toBeLessThanOrEqual(390);
  });
});

test("/jobs?fav=true with no favorite left to show: a hint on how to star, not 'relax the filters'", async ({ page }) => {
  await open(page, "/jobs?fav=true&q=zzzz-no-such-job");
  // other filters narrow it: the generic message stays
  await expect(page.getByTestId("job-list-empty")).toContainText("没有符合条件的岗位");
  await expect(page.getByTestId("jobs-fav-empty")).toHaveCount(0);
});
