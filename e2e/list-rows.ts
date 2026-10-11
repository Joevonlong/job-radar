import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The rows of the job list on screen (Today, /jobs, /favorites). A row that the last change removed (a filter, a view
 * tab, an ignore) stays in the DOM while it plays its exit animation, marked `data-leaving`; it is no longer in the list.
 * How long that animation takes depends on the machine's load, so a count or an absence check that included leaving
 * rows would race it. Count and look for rows only through these helpers.
 */
const ROW = ":scope > li:not([data-leaving]) [data-job-id]";

/** Every row of the list; `extra` narrows the row element itself, e.g. `[data-seen="false"]`. */
export const listRows = (page: Page, extra = ""): Locator => page.getByTestId("job-list").locator(`${ROW}${extra}`);

/** The row of one job. */
export const listRow = (page: Page, jobId: number | string): Locator => listRows(page, `[data-job-id="${jobId}"]`);

/**
 * Every row that left the list is gone from the DOM in the end: a row stuck in `data-leaving` (an exit animation that never
 * finishes) would otherwise pass the counts above unnoticed. Generous timeout: the exit is frame-driven and a loaded machine
 * delays it.
 */
export async function expectNoLeavingRows(page: Page): Promise<void> {
  await expect(page.getByTestId("job-list").locator(":scope > li[data-leaving]")).toHaveCount(0, { timeout: 15_000 });
}
