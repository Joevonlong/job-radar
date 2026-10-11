import { expect, test, type Page } from "@playwright/test";

/**
 * The detail page on a phone, long signal quotes, the city dropdown of
 * /jobs and the English UI of the AI texts. Seeded fictional jobs: "Computer Vision Engineer" (München) is the one the
 * phone tests change (and restore); "Machine Learning Engineer, Perception" (München) the one with signals.
 */
const PHONE = { width: 390, height: 844 };

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

async function openJob(page: Page, title: string) {
  // no waiting for "network idle": on a touch screen the list's links keep prefetching their pages
  await page.goto(`/jobs?q=${encodeURIComponent(title)}&filtered=true`);
  await page.getByRole("link", { name: title }).first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("load");
}

test.describe("phone detail page", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: PHONE, hasTouch: true });

  test("status and notes are reachable from a bar fixed to the bottom, without scrolling through the description", async ({ page }) => {
    await openJob(page, "Computer Vision Engineer");
    const bar = page.getByTestId("mobile-action-bar");
    await expect(bar).toBeVisible();
    // the bar stays in the viewport even though the page is far taller than the screen
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(height).toBeGreaterThan(PHONE.height * 1.5);
    const box = await bar.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(PHONE.height);
    expect(box?.y ?? 0).toBeGreaterThan(PHONE.height - 120);

    await page.getByTestId("bar-status-select").selectOption("interested");
    await expect(page.getByText("状态已改为 感兴趣")).toBeVisible();

    await page.getByTestId("bar-notes-button").click();
    await page.getByTestId("bar-notes-input").fill("Call the recruiter on Monday.");
    await page.getByTestId("bar-notes-save").click();
    await expect(page.getByTestId("bar-notes-input")).toHaveCount(0);

    // saved on the server: the side panel (further down) shows the same after a reload
    await page.reload();
    await expect(page.getByTestId("status-select")).toHaveValue("interested");
    await expect(page.getByTestId("notes-input")).toHaveValue("Call the recruiter on Monday.");
    await expect(page.getByTestId("bar-status-select")).toHaveValue("interested");

    // restore the seed
    await page.getByTestId("bar-status-select").selectOption("new");
    await expect(page.getByText("状态已改为 新")).toBeVisible();
    await page.getByTestId("bar-notes-button").click();
    await page.getByTestId("bar-notes-input").fill("");
    await page.getByTestId("bar-notes-save").click();
    await expect(page.getByTestId("bar-notes-input")).toHaveCount(0);
  });

  test("a toast appears above the bottom bar, not over it", async ({ page }) => {
    await openJob(page, "Computer Vision Engineer");
    const bar = page.getByTestId("mobile-action-bar");
    await expect(bar).toBeVisible();
    await page.getByTestId("bar-status-select").selectOption("interested");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "状态已改为 感兴趣" });
    await expect(toast).toBeVisible();
    // the toast slides in: look at where it settles
    await expect
      .poll(async () => {
        const [toastBox, barBox] = await Promise.all([toast.boundingBox(), bar.boundingBox()]);
        return toastBox && barBox ? Math.round(barBox.y - (toastBox.y + toastBox.height)) : null;
      })
      .toBeGreaterThanOrEqual(0);

    // restore the seed
    await page.getByTestId("bar-status-select").selectOption("new");
    await expect(page.getByText("状态已改为 新")).toBeVisible();
  });

  test("the page does not scroll sideways", async ({ page }) => {
    await openJob(page, "Machine Learning Engineer, Perception");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
});

test("the action bar is only for narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openJob(page, "Computer Vision Engineer");
  await expect(page.getByTestId("mobile-action-bar")).toBeHidden();
  await expect(page.getByTestId("status-select")).toBeVisible();
});

test("a long signal quote is shortened to a window around its term and opens with 'Expand'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openJob(page, "Machine Learning Engineer, Perception");
  const quotes = page.getByTestId("signal-quote");
  const total = await quotes.count();
  expect(total).toBeGreaterThan(0);
  for (let i = 0; i < total; i += 1) {
    const quote = quotes.nth(i);
    const toggle = quote.getByTestId("signal-quote-toggle");
    if ((await toggle.count()) === 0) continue; // a short quote is shown whole
    const text = quote.getByTestId("signal-quote-text");
    const collapsed = (await text.textContent()) ?? "";
    await toggle.click();
    const expanded = (await text.textContent()) ?? "";
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    await toggle.click();
    expect(((await text.textContent()) ?? "").length).toBe(collapsed.length);
  }
});

test("the city picker folds spellings into one city and selecting it filters the list", async ({ page }) => {
  await open(page, "/jobs");
  await page.getByTestId("filter-city").click();
  const options = await page.getByTestId("filter-city-option").allTextContents();
  // one entry per city, however the sources spell it (the target-first order is covered by tests/jobs/city-groups.test.ts)
  expect(options.filter((o) => o === "München")).toHaveLength(1);
  expect(new Set(options).size).toBe(options.length);

  await page.locator('[data-testid="filter-city-option"][data-value="München"]').click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/city=M(%C3%BC|ü)nchen/);
  await expect(page.getByRole("link", { name: "Computer Vision Engineer" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Data Engineer" })).toHaveCount(0);
});

test("English UI: the summary is English and the Chinese-only reasons carry a 中文 tag", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
  await openJob(page, "Machine Learning Engineer, Perception");
  await expect(page.getByTestId("job-summary")).toHaveAttribute("data-lang", "en");
  await expect(page.getByTestId("job-summary")).toContainText("Fictional summary");
  const tags = page.getByTestId("language-tag");
  await expect(tags.first()).toHaveText("中文");
  await expect(tags.first()).toHaveAttribute("lang", "zh-CN");
});

test("Chinese UI: no language tag on the reasons", async ({ page }) => {
  await openJob(page, "Machine Learning Engineer, Perception");
  await expect(page.getByTestId("job-summary")).toHaveAttribute("data-lang", "zh");
  await expect(page.getByTestId("language-tag")).toHaveCount(0);
});

test("/sources shows what a channel without a budget did this month", async ({ page }) => {
  await open(page, "/sources");
  await page.locator('[data-channel="greenhouse"]').getByTestId("channel-details").locator("summary").click();
  const activity = page.locator('[data-channel="greenhouse"]').getByTestId("month-activity");
  await expect(activity).toBeVisible();
  await expect(activity).toHaveText(/本月/);
});
