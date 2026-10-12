import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { parse, stringify } from "yaml";

/**
 * Reason sources on the detail page, on the seeded e2e database. Fictional seed jobs: "AI Engineer (Agents)" (Lindenhof Data) has a
 * score with sources (one inferred reason, a quote that is also the job's T3 signal, a quote of its own, a gap the JD does not
 * state); "Applied Scientist, Clinical NLP" (Mosaik Health AI) has a score from before sources. The legacy note shows only while
 * `ai.yaml: scoring.evidence.enabled` is on, so the spec turns it on and puts the default back. Rewrites ai.yaml: a project of the
 * serial chain (e2e/projects.ts). The UI is Chinese by default.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const AI_FILE = path.join(CONFIG_DIR, "ai.yaml");

test.describe.configure({ mode: "serial" });

function evidence(enabled: boolean) {
  const doc = parse(fs.readFileSync(path.join(DEFAULTS_DIR, "ai.yaml"), "utf8")) as Record<string, Record<string, unknown> | undefined>;
  doc.scoring = { ...doc.scoring, evidence: { enabled, quote_max_chars: 150 } };
  fs.writeFileSync(AI_FILE, stringify(doc));
}

test.beforeEach(() => evidence(true));
test.afterAll(() => fs.copyFileSync(path.join(DEFAULTS_DIR, "ai.yaml"), AI_FILE));

async function openJob(page: Page, title: string) {
  await page.goto(`/jobs?q=${encodeURIComponent(title)}`);
  await page.getByRole("link", { name: new RegExp(title.replace(/[()]/g, "\\$&")) }).first().click();
  await expect(page.getByTestId("job-title")).toHaveText(title);
  await page.waitForLoadState("networkidle");
}

test("each reason shows its source; a JD quote opens and jumps to its mark in the JD", async ({ page }) => {
  await openJob(page, "AI Engineer (Agents)");
  const markers = page.getByTestId("reason-source");
  await expect(markers).toHaveCount(4);
  await expect(markers.nth(0)).toHaveText(/推断/);
  await expect(markers.nth(0)).toHaveAttribute("title", /AI 根据 JD/);
  await expect(page.locator('[data-testid="reason-source"][data-basis="unstated"]')).toHaveText(/未提及/);
  await expect(page.getByTestId("reasons-evidence-legacy")).toHaveCount(0);

  // the quote of its own: an evidence mark in the JD
  const own = page.locator('[data-testid="reason-text"][data-basis="jd"]').filter({ hasText: "Two office days" });
  const marker = own.getByTestId("reason-source");
  await expect(marker).toHaveText(/原文/);
  await expect(own.getByTestId("reason-quote")).toBeHidden();
  await marker.click();
  await expect(marker).toHaveAttribute("aria-expanded", "true");
  await expect(own.getByTestId("reason-quote")).toContainText("Hybrid: two office days per week.");
  await own.getByTestId("reason-jump").click();
  const mark = page.getByTestId("jd-evidence-mark").filter({ hasText: "Hybrid: two office days per week." });
  await expect(mark).toBeInViewport();
  await expect(mark).toHaveAttribute("data-tier", "evidence");
  await expect(page.getByTestId("jd-legend-evidence")).toBeVisible();

  // the quote that is also a signal: it jumps to the signal's mark, no second mark is added
  const shared = page.locator('[data-testid="reason-text"][data-basis="jd"]').filter({ hasText: "above market" });
  await shared.getByTestId("reason-source").click();
  await shared.getByTestId("reason-jump").click();
  await expect(page.getByTestId("jd-evidence-mark").filter({ hasText: "above-market salary" })).toHaveCount(0);
});

test("a score from before sources: the reasons alone and a note while sources are on; no note while they are off", async ({ page }) => {
  await openJob(page, "Applied Scientist, Clinical NLP");
  await expect(page.getByTestId("reason-text").first()).toBeVisible();
  await expect(page.getByTestId("reason-source")).toHaveCount(0);
  await expect(page.getByTestId("reasons-evidence-legacy")).toContainText("重新打分后会带标注");

  evidence(false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("reason-text").first()).toBeVisible();
  await expect(page.getByTestId("reasons-evidence-legacy")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`390px, ${theme}: the markers and an open quote fit without a horizontal scroll`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await openJob(page, "AI Engineer (Agents)");
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    const own = page.locator('[data-testid="reason-text"][data-basis="jd"]').filter({ hasText: "Two office days" });
    await own.getByTestId("reason-source").click();
    await expect(own.getByTestId("reason-quote")).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await own.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve(process.env.E2E_SHOTS_DIR ?? "test-results", `score-evidence-390-${theme}.png`) });
  });
}
