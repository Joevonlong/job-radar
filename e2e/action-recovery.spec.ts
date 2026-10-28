import en from "../messages/en.json" with { type: "json" };
import zh from "../messages/zh.json" with { type: "json" };
import { expect, test, type Page } from "./fixtures";

test.describe.configure({ mode: "serial" });

/** Simulate an old tab calling an ID that the current deployment no longer exports. */
async function outdatedAction(page: Page, pathname: string): Promise<void> {
  let rejected = false;
  await page.route(`**${pathname}`, async (route) => {
    if (rejected || !route.request().headers()["next-action"]) return route.fallback();
    rejected = true;
    await route.fulfill({ status: 404, headers: { "x-nextjs-action-not-found": "1", "content-type": "text/plain" }, body: "Unknown action" });
  });
}

for (const { locale, messages } of [{ locale: "en", messages: en }, { locale: "zh", messages: zh }]) {
  test(`an outdated button action reloads with an update notice in ${locale}`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL! }]);
    await page.goto("/sources");
    const channel = page.locator('[data-testid="channel-card"][data-channel="greenhouse"]');
    await channel.getByTestId("channel-details").locator("summary").click();
    await outdatedAction(page, "/sources");
    const reloaded = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() });
    await channel.getByTestId("trigger-testChannel-button").click();
    await reloaded;
    await expect(page.getByText(messages.dashboard.error.updatedToast, { exact: true })).toBeVisible();
    await expect(page.getByTestId("page-error")).toHaveCount(0);
  });
}

test("an outdated useActionState form reloads instead of rendering the page error", async ({ page }) => {
  await page.goto("/settings?tab=schedule");
  const card = page.getByTestId("settings-card-schedule");
  await card.getByRole("textbox", { name: "Cron 表达式" }).nth(2).fill("0 10 * * 0,6");
  await outdatedAction(page, "/settings?tab=schedule");
  // The app's existing unsaved-edits prompt still applies to its full reload.
  page.on("dialog", (dialog) => dialog.accept());
  const reloaded = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() });
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await reloaded;
  await expect(page.getByText(zh.dashboard.error.updatedToast, { exact: true })).toBeVisible();
  await expect(page.getByTestId("page-error")).toHaveCount(0);
  await expect(page.getByTestId("settings-card-schedule")).toBeVisible();
});

test("a failed action connection shows a retry notice and keeps the page open", async ({ page }) => {
  await page.goto("/sources");
  const channel = page.locator('[data-testid="channel-card"][data-channel="greenhouse"]');
  await channel.getByTestId("channel-details").locator("summary").click();
  let rejected = false;
  await page.route("**/sources", async (route) => {
    if (rejected || !route.request().headers()["next-action"]) return route.fallback();
    rejected = true;
    await route.abort("connectionrefused");
  });
  await channel.getByTestId("trigger-testChannel-button").click();
  await expect(page.getByText(zh.dashboard.error.actionFailed, { exact: true })).toBeVisible();
  await expect(channel.getByTestId("trigger-outcome")).toHaveText(zh.trigger.refused.transportFailed);
  await expect(page.getByText(zh.trigger.refused.databaseUnavailable, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("page-error")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: zh.pages.sources.title, exact: true })).toBeVisible();
});
