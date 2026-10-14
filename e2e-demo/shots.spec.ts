import { execFileSync } from "node:child_process";

import { expect, test, type Browser } from "../e2e/fixtures";

import { DESKTOP_VIEWPORT, DETAIL_VIEWPORT, MOBILE_VIEWPORT, PIPELINE_VIEWPORT } from "../scripts/demo/settings";

import { horizontalOverflow, jobIdByTitle, recordTraffic, REPO_ROOT, setLook, settle, shoot, type Locale, type Theme } from "./helpers";
import type { TelegramPreview } from "./telegram-preview";

/**
 * The README screenshots (docs/images/README.md lists them). Every picture is the viewport, after the page is at rest
 * and the leak guard found nothing.
 */

/** The detail page shown: scored, a salary quoted from the JD, an AI trap on its Greenhouse page (src/lib/db/seed-demo.ts). */
const DETAIL_TITLE = "Applied Scientist, Clinical NLP";

async function open(browser: Browser, baseURL: string, look: { locale: Locale; theme: Theme; viewport?: { width: number; height: number } }) {
  const context = await browser.newContext({ viewport: look.viewport ?? DESKTOP_VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: look.theme, baseURL });
  await setLook(context, baseURL, look);
  const page = await context.newPage();
  return { context, page, traffic: recordTraffic(page) };
}

const LOOKS: ReadonlyArray<{ suffix: string; locale: Locale; theme: Theme }> = [
  { suffix: "light", locale: "en", theme: "light" },
  { suffix: "dark", locale: "en", theme: "dark" },
  { suffix: "zh", locale: "zh", theme: "light" },
];

for (const look of LOOKS) {
  test(`today-${look.suffix}.png`, async ({ browser, baseURL }) => {
    const { context, page, traffic } = await open(browser, baseURL ?? "", look);
    await page.goto("/");
    await settle(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shoot(page, traffic, `today-${look.suffix}.png`);
    await context.close();
  });

  test(`job-detail-${look.suffix}.png`, async ({ browser, baseURL }) => {
    const id = await jobIdByTitle(DETAIL_TITLE);
    const { context, page, traffic } = await open(browser, baseURL ?? "", { ...look, viewport: DETAIL_VIEWPORT });
    await page.goto(`/jobs/${id}`);
    await expect(page.getByTestId("job-title")).toHaveText(DETAIL_TITLE);
    await settle(page);
    // the score, the AI trap and the salary sentence quoted from the JD are all in the picture
    for (const testId of ["job-title", "trap-quote", "cap-bar"]) await expect(page.getByTestId(testId)).toBeInViewport();
    await expect(page.getByText("EUR 90,000 to 110,000", { exact: false }).first()).toBeInViewport();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shoot(page, traffic, `job-detail-${look.suffix}.png`);
    await context.close();
  });
}

test("pipeline.png", async ({ browser, baseURL }) => {
  const { context, page, traffic } = await open(browser, baseURL ?? "", { locale: "en", theme: "light", viewport: PIPELINE_VIEWPORT });
  await page.goto("/pipeline");
  await settle(page);
  // the ended column opens to show its cards
  await page.getByTestId("ended-toggle").click();
  await settle(page);
  // every column is in the picture and holds at least one card
  const columns = page.getByTestId("board-column");
  await expect(columns).toHaveCount(7);
  for (const column of await columns.all()) {
    await expect(column).toBeInViewport({ ratio: 1 });
    await expect(column.getByTestId("pipeline-card").first()).toBeVisible();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shoot(page, traffic, "pipeline.png");
  await context.close();
});

test("settings.png", async ({ browser, baseURL }) => {
  const { context, page, traffic } = await open(browser, baseURL ?? "", { locale: "en", theme: "light" });
  // the search tab: the keyword groups of the "AI engineering in Europe" example
  await page.goto("/settings?tab=search");
  await settle(page);
  await expect(page.locator("body")).toContainText("Forward Deployed Engineer");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shoot(page, traffic, "settings.png");
  await context.close();
});

test("mobile-today.png", async ({ browser, baseURL }) => {
  const { context, page, traffic } = await open(browser, baseURL ?? "", { locale: "en", theme: "light", viewport: MOBILE_VIEWPORT });
  await page.goto("/");
  await settle(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shoot(page, traffic, "mobile-today.png");
  await context.close();
});

test("telegram.png", async ({ browser, baseURL }) => {
  const id = await jobIdByTitle(DETAIL_TITLE);
  // the real formatJobMessage output (rendered under tsx: the app's modules import JSON catalogs)
  const preview = JSON.parse(
    execFileSync("pnpm", ["exec", "tsx", "e2e-demo/telegram-render.ts", String(id)], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL ?? "" }, encoding: "utf8" }),
  ) as TelegramPreview;
  expect(preview.message).toContain('href="http://127.0.0.1:3000/jobs/');
  const { context, page, traffic } = await open(browser, baseURL ?? "", { locale: "en", theme: "light", viewport: { width: 640, height: 560 } });
  await page.setContent(preview.html);
  // the bubble holds exactly the formatted message
  expect(await page.getByTestId("telegram-message").evaluate((el) => el.innerHTML)).toBe(preview.message);
  await settle(page);
  await shoot(page, traffic, "telegram.png");
  await context.close();
});
