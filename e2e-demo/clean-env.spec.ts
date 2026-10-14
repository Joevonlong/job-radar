import { expect, test } from "../e2e/fixtures";

import { findLeaks, serializeDocument } from "./guard";
import { forbiddenPatterns, recordTraffic, settle } from "./helpers";

/**
 * The demo web runs without the project's `.env` (playwright.shots.config.ts blanks every variable `.env.example` lists):
 * the setup wizard's variable lists show every key and token as missing. With `DEMO_ENV_SENTINEL` set (scripts/demo-shots.sh
 * --env-sentinel writes a `.env` of that value), no page and no response contains it.
 */
for (const step of ["telegram", "ai", "sources"] as const) {
  test(`the ${step} step sees no configured variable`, async ({ page }) => {
    const traffic = recordTraffic(page);
    await page.goto(`/setup?step=${step}`);
    await settle(page);
    const present = await page.locator("[data-env][data-present='true']").count();
    expect(present, "a variable from a real .env reached the demo web").toBe(0);
    if (step === "telegram") await expect(page.locator("[data-env]").first()).toBeVisible();
    await traffic.settle();
    const leaks = [...findLeaks(await page.evaluate(serializeDocument), forbiddenPatterns(), "page"), ...traffic.log.drain().flatMap((e) => findLeaks(e.text, forbiddenPatterns(), e.where))];
    expect(leaks.map((l) => `${l.label} in ${l.where}`)).toEqual([]);
  });
}
