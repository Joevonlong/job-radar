import { expect, test } from "./fixtures";

/** /sources on the seeded e2e database (see src/lib/db/seed.ts): the dashboard's fictional cycles and runs. The UI is Chinese by default. */
test("sources shows a card per channel with its circuit state, runs and budget", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "来源" })).toBeVisible();

  // summary: runner (the stand-in runner is up), latest cycle, global paid cap, AI budget
  await expect(page.getByTestId("runner-card")).toHaveAttribute("data-state", "online");
  await expect(page.getByTestId("latest-cycle-card")).toContainText("早轮");
  await expect(page.getByTestId("global-bar")).toBeVisible();
  await expect(page.getByTestId("ai-bar")).toBeVisible();

  // one card per configured channel; the seeded broken one is open
  // implemented channels get a full card; the ones without code are compact rows in one closed section (same hooks)
  const cards = page.getByTestId("channel-card");
  expect(await cards.count()).toBeGreaterThanOrEqual(18);
  await expect(page.locator('[data-testid="channel-card"]:not([data-compact])').first()).toBeVisible();
  const pending = page.getByTestId("pending-channels");
  await expect(pending.locator("details")).not.toHaveAttribute("open", "");
  expect(await pending.locator('[data-testid="channel-card"][data-compact="1"]').count()).toBeGreaterThanOrEqual(5);
  await expect(page.locator('[data-testid="channel-card"][data-channel="lever"]')).not.toHaveAttribute("data-compact", "1");
  await expect(page.locator('[data-testid="channel-card"][data-channel="xing"]')).toHaveAttribute("data-circuit", "open");
  await expect(page.locator('[data-testid="channel-card"][data-channel="greenhouse"]')).toHaveAttribute("data-circuit", "closed");

  const greenhouse = page.locator('[data-testid="channel-card"][data-channel="greenhouse"]');
  await expect(greenhouse.getByTestId("run-list").locator("li")).toHaveCount(2);
  const xing = page.locator('[data-testid="channel-card"][data-channel="xing"]');
  await expect(xing.locator('li[data-status="failed"]')).toContainText("被网站拦截");

  // the cascade, in order, and the channel that served the latest cycle
  const cascade = page.getByTestId("cascade-card");
  await expect(cascade.getByTestId("rotation-status")).toBeVisible();
  await expect(cascade.getByTestId("cascade-entry")).toHaveCount(5);
  const entries = cascade.getByTestId("cascade-entry");
  const channelOrder = ["linkedin-brightdata", "linkedin-apify", "linkedin-monid", "linkedin-session", "linkedin-guest"];
  for (const [index, id] of channelOrder.entries()) {
    await expect(entries.nth(index)).toHaveAttribute("data-channel", id);
  }
  await expect(entries.locator(".src-step__n")).toHaveText(channelOrder);
  await expect(cascade.getByTestId("cascade-entry").first()).toHaveAttribute("data-served", "1");
  await expect(cascade.locator('[data-channel="linkedin-guest"]')).toContainText("跳过");

  // The seeded AI calls of today are inside the month, and the card links to the statistics page
  expect(await page.getByTestId("ai-row").count()).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("ai-usage-details")).toHaveAttribute("href", "/sources/ai-usage?range=month");
});

test("channel cards carry the light, this cycle's count, the trend and the health strip from the run records", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  const greenhouse = page.locator('[data-testid="channel-card"][data-channel="greenhouse"]');
  const pulse = greenhouse.getByTestId("channel-pulse");
  await expect(pulse).toBeVisible();
  // the seeded latest cycle fetched 120 from greenhouse: the number is the real count, the strip has one block per cycle slot
  await expect(pulse.locator("[data-value]").first()).toHaveAttribute("data-value", "120");
  await expect(pulse.getByRole("img", { name: /轮.*正常/ })).toBeVisible();
  await expect(greenhouse.getByTestId("channel-status")).toHaveAttribute("data-status", "ok");
  await expect(greenhouse.getByRole("img", { name: /正常/ }).first()).toBeVisible();
  // a column of the run history says its values on hover
  await expect(pulse.locator("[data-tip]").first()).toHaveAttribute("data-tip", /.+/);
  // the test buttons are still there, in the card's collapsible details
  await expect(greenhouse.getByTestId("trigger-runChannel-button")).toBeHidden();
  await greenhouse.getByTestId("channel-details").locator("summary").click();
  await expect(greenhouse.getByTestId("trigger-runChannel-button")).toBeVisible();
  await expect(greenhouse.getByTestId("trigger-testChannel-button")).toBeVisible();
});

test("the summary has four health blocks and the cascade a quota battery per step", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("runner-card")).toBeVisible();
  await expect(page.getByTestId("ai-worker-card")).toBeVisible();
  await expect(page.getByTestId("paid-card").getByRole("meter")).toHaveAttribute("aria-valuemin", "0");
  await expect(page.getByTestId("disk-card")).toBeVisible();
  const steps = page.getByTestId("cascade-card").getByTestId("cascade-entry");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(2)).toHaveAttribute("data-channel", "linkedin-monid");
  await expect(steps.nth(2).locator(".src-step__n")).toHaveText("linkedin-monid");
  await expect(steps.first()).toHaveAttribute("data-step", "on");
});

test("English, terminal theme and a phone viewport: no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // the AI provider table reflows into stacked rows: its Test button is inside the viewport, not cut off
  const test = page.getByTestId("ai-health-row").first().getByRole("button").first();
  await test.scrollIntoViewIfNeeded();
  const box = await test.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
});

test("the AI provider card names each provider's default model", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  const rows = page.getByTestId("ai-health-row");
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) {
    const model = row.getByTestId("ai-model");
    await expect(model).not.toBeEmpty();
    await expect(model).toHaveAttribute("data-status", /^(ok|deprecated|missing|cliDefault)$/);
  }
  // the label of the catalog comes with the id
  await expect(rows.filter({ hasText: "deepseek" }).first().getByTestId("ai-model")).toContainText(/\S+ · deepseek-/);
  // 390px: the second line does not widen the page
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
