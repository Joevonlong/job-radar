import { expect, test } from "@playwright/test";

// The e2e run serves the production build: the dev-only component page must not exist there.
test("/dev/viz is a 404 in production", async ({ page }) => {
  const response = await page.goto("/dev/viz");
  expect(response?.status()).toBe(404);
});
