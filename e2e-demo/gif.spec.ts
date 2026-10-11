import path from "node:path";

import { expect, test } from "@playwright/test";

import { PIPELINE_VIEWPORT, VIDEO_DIR, VIDEO_VIEWPORT } from "../scripts/demo/settings";

import { guard, recordTraffic, REPO_ROOT, setLook, settle } from "./helpers";

/**
 * The README GIF (about 20 seconds, recorded at VIDEO_VIEWPORT; scripts/demo-finish.ts turns the video into the GIF):
 * today's list → the top job → its salary sentence in the JD → "Mark applied" → the pipeline board (zoomed out so all
 * seven columns fit).
 * Every page is checked by the leak guard; a hit fails the run and no GIF is made.
 */

const TITLE = "Applied Scientist, Clinical NLP";
/** Pauses so a viewer can read each step. */
const LOOK_MS = 2_500;

test("job-radar-demo.gif", async ({ page, context, baseURL }) => {
  await setLook(context, baseURL ?? "", { locale: "en", theme: "light" });
  const traffic = recordTraffic(page);

  await page.goto("/");
  await settle(page);
  await guard(page, traffic);
  await page.waitForTimeout(LOOK_MS);

  await page.getByText(TITLE, { exact: true }).first().click();
  await page.waitForURL(/\/jobs\/\d+/);
  await expect(page.getByTestId("job-title")).toHaveText(TITLE);
  await settle(page);
  await guard(page, traffic);
  await page.waitForTimeout(LOOK_MS);

  // the salary tag jumps to the sentence it was read from
  await page.getByTestId("trap-quote").scrollIntoViewIfNeeded();
  await page.waitForTimeout(LOOK_MS);
  await page.getByTestId("jump-tag").first().click();
  await guard(page, traffic);
  await page.waitForTimeout(LOOK_MS);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(1_000);
  await page.getByTestId("mark-applied-button").first().click();
  await expect(page.getByTestId("applied-display").first()).toBeVisible();
  await guard(page, traffic);
  await page.waitForTimeout(LOOK_MS);

  // the board needs PIPELINE_VIEWPORT's width for all seven columns: zoom the page out to fit the recording
  await page.goto("/pipeline");
  await settle(page);
  await page.evaluate((zoom) => {
    document.documentElement.style.zoom = String(zoom);
  }, VIDEO_VIEWPORT.width / PIPELINE_VIEWPORT.width);
  await settle(page);
  await guard(page, traffic);
  await expect(page.getByTestId("pipeline-card").filter({ hasText: TITLE })).toBeVisible();
  const columns = page.getByTestId("board-column");
  await expect(columns).toHaveCount(7);
  for (const column of await columns.all()) await expect(column).toBeInViewport({ ratio: 1 });
  await page.waitForTimeout(LOOK_MS + 1_000);

  // the recording is complete once the page is closed
  const video = page.video();
  if (!video) throw new Error("the gif project records video (playwright.shots.config.ts)");
  await page.close();
  await video.saveAs(path.join(REPO_ROOT, VIDEO_DIR, "demo.webm"));
});
