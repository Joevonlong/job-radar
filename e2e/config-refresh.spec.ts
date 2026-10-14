import fs from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";

/**
 * A config file edited by hand shows up in the web app without a restart: the web has no watcher, so `loadConfig` checks the
 * files itself (the web server of the run has a short `JOB_RADAR_CONFIG_POLL_MS`, see playwright.config.ts). The home page reads
 * `notify.yaml: push_min_score` through the cache (nothing on its way reloads that file) and names its third summary block after
 * it. Rewrites notify.yaml: a project of the serial chain (e2e/projects.ts).
 */
const NOTIFY_FILE = path.join(process.env.E2E_CONFIG_DIR ?? "", "notify.yaml");
const LINE = /^push_min_score: \d+$/m;

test("an edit of notify.yaml reaches the page, and so does putting it back", async ({ page }) => {
  const original = fs.readFileSync(NOTIFY_FILE, "utf8");
  expect(original).toMatch(LINE);
  const blockName = async (): Promise<string> => {
    await page.goto("/");
    return (await page.getByTestId("kpi-qualified").getAttribute("aria-label")) ?? "";
  };
  try {
    await expect.poll(blockName).toBe("≥ 70 分");
    fs.writeFileSync(NOTIFY_FILE, original.replace(LINE, "push_min_score: 55"));
    await expect.poll(blockName, { timeout: 15_000 }).toBe("≥ 55 分");
  } finally {
    fs.writeFileSync(NOTIFY_FILE, original);
    // the next project must not meet the edited value: leave once the page shows the restored one
    await expect.poll(blockName, { timeout: 15_000 }).toBe("≥ 70 分");
  }
});
