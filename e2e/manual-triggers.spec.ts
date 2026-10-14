import { expect, test } from "./fixtures";

/**
 * The test buttons of /sources on the seeded e2e database. scripts/e2e-runner.ts (the stand-in runner) answers
 * `test_channel` / `test_ai` with a stub result after a moment; nothing reaches a real source or AI. UI in Chinese.
 */
test("test a channel from its card: queued, then the result appears next to the button", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  const card = page.locator('[data-testid="channel-card"][data-channel="arbeitsagentur"]');
  // the buttons sit in the card's collapsible details
  await card.getByTestId("channel-details").locator("summary").click();
  const trigger = card.getByTestId("trigger-testChannel");
  await trigger.getByRole("button", { name: "测试" }).click();

  await expect(trigger.getByTestId("trigger-outcome")).toHaveAttribute("data-outcome", "done", { timeout: 15_000 });
  await expect(trigger.getByTestId("trigger-outcome")).toContainText("抓到 3 条，解析成功 3 条");
  await expect(trigger.getByText("AI Engineer (e2e)")).toBeVisible();

  // a second click right away is refused by the rate limit (schedule.yaml manual_triggers)
  await trigger.getByRole("button", { name: "测试" }).click();
  await expect(trigger.getByTestId("trigger-outcome")).toHaveAttribute("data-outcome", "refused");
  await expect(trigger.getByTestId("trigger-outcome")).toContainText("秒后可以再试");
});

test("paid and login-session channels offer no test; the AI card has a test per provider", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");
  const paid = page.locator('[data-testid="channel-card"][data-channel="linkedin-brightdata"]');
  await expect(paid.getByTestId("trigger-testChannel-button")).toBeDisabled();
  await expect(paid.getByTestId("trigger-testChannel")).toContainText("付费和登录态通道不提供测试");
  await expect(paid.getByTestId("trigger-runChannel-button")).toBeEnabled();

  const codex = page.locator('[data-testid="ai-health-row"][data-provider="codex-cli"]');
  await codex.getByRole("button", { name: "测试" }).click();
  await expect(codex.getByTestId("trigger-outcome")).toContainText("可用：e2e-model", { timeout: 15_000 });
});
