import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { expect, test, type Page } from "./fixtures";
import { listRows } from "./list-rows";

/**
 * The company background on the seeded e2e database. research.yaml of the e2e config copy is switched on by
 * scripts/e2e-prepare.ts; the e2e runner runs the real handler with a stand-in AI, so nothing goes out to the web. The
 * stand-in's answer has one field with an http source, which the check must drop.
 */

async function openJob(page: Page, name: RegExp) {
  await page.goto("/jobs");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
}

const panel = (page: Page) => page.getByTestId("company-research-panel");

/** Change research.yaml of this run's config copy for one test; this spec has its own project in SERIAL_CHAIN. */
async function withResearchFile(edit: (text: string) => string, run: () => Promise<void>): Promise<void> {
  const configDir = process.env.E2E_CONFIG_DIR;
  if (!configDir) throw new Error("E2E_CONFIG_DIR is required");
  const file = path.join(configDir, "research.yaml");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, edit(original));
  try {
    await run();
  } finally {
    fs.writeFileSync(file, original);
  }
}

function database() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !new URL(url).pathname.slice(1).startsWith("jobradar_e2e")) throw new Error("A disposable E2E_DATABASE_URL is required");
  return postgres(url, { max: 1, onnotice: () => {} });
}

test.describe("company background", () => {
  test("before a lookup the panel says what it would send", async ({ page }) => {
    await openJob(page, /Forward Deployed Engineer/);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("company-research-ready")).toContainText(/Quillfeather/);
    await expect(page.getByTestId("company-research-quota")).toBeVisible();
  });

  test("a manual lookup shows the checked fields with sources, marked as unverified", async ({ page }) => {
    await openJob(page, /LLM Engineer/);
    await expect(page.getByTestId("company-research-badge")).toBeVisible();
    // a retry finds the result of its first attempt: it looks up again
    await page.getByTestId("company-research-button").or(page.getByTestId("company-research-refresh")).click();
    await expect(page.getByTestId("company-research-field-summary")).toBeVisible({ timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });

    await expect(page.getByTestId("company-research-field-summary")).toContainText("Builds analytics software");
    await expect(page.getByTestId("company-research-field-recentNews")).toContainText("Opened a second office");
    // the http source took its field with it, and the panel says a field was dropped
    await expect(page.getByTestId("company-research-field-funding")).toHaveCount(0);
    await expect(page.getByTestId("company-research-dropped")).toBeVisible();

    const source = page.getByTestId("company-research-field-summary").getByTestId("company-research-source");
    await expect(source).toHaveAttribute("href", "https://www.example-analytics.de/about");
    await expect(source).toHaveAttribute("target", "_blank");
    await expect(source).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByTestId("company-research-meta")).toContainText("e2e-model");
    await expect(page.getByTestId("company-research-sent")).toBeVisible();

    await page.reload();
    await expect(panel(page)).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("company-research-field-summary")).toContainText("Builds analytics software");
    await expect(page.getByTestId("company-research-refresh")).toBeEnabled();
  });

  test("the panel fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openJob(page, /LLM Engineer/);
    await expect(panel(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("the website domain", () => {
  test("an inferred domain waits for the user's confirmation, and stays confirmed after a reload", async ({ page }) => {
    await openJob(page, /Forward Deployed Engineer/);
    const sql = database();
    try {
      await sql`update companies set website_domain = 'quillfeather-labs.com', website_domain_source = 'inferred', website_domain_confirmed_at = null where name ilike 'Quillfeather%'`;
    } finally {
      await sql.end();
    }
    await page.reload();
    await expect(page.getByTestId("company-domain")).toHaveAttribute("data-state", "inferred");
    await page.getByTestId("company-domain-confirm").click();
    await expect(page.getByTestId("company-domain")).toHaveAttribute("data-state", "confirmed");
    await page.reload();
    await expect(page.getByTestId("company-domain")).toHaveAttribute("data-state", "confirmed");
    await expect(page.getByTestId("company-domain")).toContainText("quillfeather-labs.com");
  });
});

test.describe("the research bar", () => {
  test("shows each part, runs them, and remembers them after a reload", async ({ page }) => {
    await openJob(page, /LLM Engineer/);
    const bar = page.getByTestId("research-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("research-bar-company")).toBeVisible();
    const salary = page.getByTestId("research-bar-salary");
    await expect(salary).toBeVisible();
    await page.getByTestId("research-bar-salary-run").click();
    await expect(salary).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId("research-bar-salary")).toHaveAttribute("data-state", "done");
  });

  test("a star starts research by itself when the setting asks for it", async ({ page }) => {
    await withResearchFile(
      (text) => text.replace(/^  trigger: \w+$/m, "  trigger: favorite"),
      async () => {
        await page.goto("/jobs");
        await page.waitForLoadState("networkidle");
        const row = listRows(page).filter({ hasText: "Senior Backend Engineer" }).first();
        const href = await row.getByRole("link", { name: /Senior Backend Engineer/ }).first().getAttribute("href");
        await row.getByTestId("row-favorite").click();
        await expect(row.getByTestId("row-favorite")).toHaveAttribute("aria-pressed", "true");
        await page.goto(href as string);
        await page.waitForLoadState("networkidle");
        // running or already finished, but no longer waiting to be asked
        await expect.poll(async () => {
          await page.reload();
          return page.getByTestId("research-bar-company").getAttribute("data-state");
        }, { timeout: 30_000 }).toMatch(/running|done/);
        // put the star back as it was: other specs count stars
        await page.goto("/jobs");
        await page.waitForLoadState("networkidle");
        await listRows(page).filter({ hasText: "Senior Backend Engineer" }).first().getByTestId("row-favorite").click();
      },
    );
  });

  test("with research switched off nothing can be pressed", async ({ page }) => {
    await withResearchFile(
      (text) => text.replace(/^enabled: true$/m, "enabled: false"),
      async () => {
        await openJob(page, /LLM Engineer/);
        await expect(page.getByTestId("research-bar-all")).toHaveCount(0);
        await expect(page.locator('[data-testid^="research-bar-"][data-testid$="-run"]')).toHaveCount(0);
        // the result this job already has stays readable, but it cannot be asked for again
        await expect(page.getByTestId("company-research-refresh")).toHaveCount(0);
        await expect(page.getByTestId("company-research-button")).toHaveCount(0);
      },
    );
  });

  test("the bar fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openJob(page, /LLM Engineer/);
    await expect(page.getByTestId("research-bar")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("the company list", () => {
  test("shows a stored result, opens its fields, and starts nothing by itself", async ({ page }) => {
    const sql = database();
    let requestsBefore: number;
    try {
      const [{ n }] = await sql<[{ n: number }]>`select count(*)::int as n from control_requests where kind = 'company_research'`;
      requestsBefore = n;
    } finally {
      await sql.end();
    }
    await page.goto("/companies");
    await page.waitForLoadState("networkidle");
    // the manual lookup above left a result for this company
    const details = page.getByTestId("company-research-details").filter({ has: page.getByTestId("company-research-summary") }).filter({ visible: true }).first();
    await expect(details.getByTestId("company-research-summary")).toContainText("Builds analytics software");
    await details.getByTestId("company-research-toggle").click();
    await expect(details.getByTestId("company-research-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(details.getByTestId("company-research-field-summary")).toBeVisible();
    await expect(details.getByTestId("company-research-source").first()).toHaveAttribute("target", "_blank");
    await expect(details.getByTestId("company-domain")).toBeVisible();
    await expect(details.getByTestId("company-overview-refresh")).toBeEnabled();
    // a company without a result gets a button in its actions, not a row
    await expect(page.locator('[data-testid="company-website-action"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-testid="company-research-row"]')).toHaveCount(await page.locator('[data-testid="company-research-row"]:has([data-testid="company-research-summary"])').count());
    const check = database();
    try {
      const [{ n }] = await check<[{ n: number }]>`select count(*)::int as n from control_requests where kind = 'company_research'`;
      expect(n).toBe(requestsBefore);
    } finally {
      await check.end();
    }
  });

  test("fits a phone with the details open", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/companies");
    await page.waitForLoadState("networkidle");
    const details = page.getByTestId("company-research-details").filter({ has: page.getByTestId("company-research-summary") }).filter({ visible: true }).first();
    await details.getByTestId("company-research-toggle").click();
    await expect(details.getByTestId("company-research-field-summary")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("research settings", () => {
  test("the tab shows the switch and the limits", async ({ page }) => {
    await page.goto("/settings?tab=research");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("tab", { name: /Research|调研/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").getByText(/company name|公司名/).first()).toBeVisible();
    const trigger = page.getByRole("combobox", { name: /by itself|自动开始/ });
    await expect(trigger).toBeVisible();
    await expect(trigger.locator("option")).toHaveCount(3);
  });
});
