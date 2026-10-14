import { expect, test } from "./fixtures";

/** Without a saved LinkedIn login, /sources says "未登录" on the session channels and in the cascade (the e2e run has no .auth/linkedin.json). */
test("sources shows the LinkedIn session as not logged in", async ({ page }) => {
  await page.goto("/sources");
  await page.waitForLoadState("networkidle");

  const session = page.locator('[data-testid="channel-card"][data-channel="linkedin-session"]');
  await expect(session.getByTestId("login-status")).toHaveAttribute("data-status", "missing");
  await expect(session.getByTestId("login-status")).toHaveText("未登录");

  const recommended = page.locator('[data-testid="channel-card"][data-channel="linkedin-session:recommended"]');
  await expect(recommended.getByTestId("login-status")).toHaveAttribute("data-status", "missing");

  const entry = page.getByTestId("cascade-card").locator('[data-channel="linkedin-session"]');
  await expect(entry.getByTestId("cascade-login-status")).toHaveText("未登录");
  // the other channels carry no login badge
  await expect(page.locator('[data-testid="channel-card"][data-channel="linkedin-guest"]').getByTestId("login-status")).toHaveCount(0);
});
