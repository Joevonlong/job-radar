import fs from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { parse } from "yaml";

/**
 * The first-run setup on a brand-new install (playwright.setup.config.ts: empty config and profile directories,
 * an empty migrated database, no runner). One browser context walks the wizard in order, checking the files on disk
 * after every step; then skipping, the review mode from the settings page, and the phone width with the keyboard only.
 *
 * A product-contract test: the install starts from the SHIPPED defaults (`config/` and its example profile), the same
 * files a first `docker compose up` copies, not a frozen fixture. What the example profile and the shipped configs say
 * is read from those files (the defaults directory of the run, E2E_SETUP_DEFAULTS_DIR), so the spec follows a change of
 * the defaults, while a change that breaks the first-run experience fails it; the one thing pinned is the example market
 * itself (generic, US, USD), so a change of it makes whoever does it look at this walk-through. Market-specific
 * behaviour is not walked here: what a country switch does to the currency and the cities, and what the user's own
 * edits keep, is tested in tests/setup/step-market.test.tsx; the packs' own currencies, cities and languages in
 * tests/market/ and tests/setup/steps.test.ts.
 */
const CONFIG_DIR = process.env.E2E_SETUP_CONFIG_DIR ?? "";
const PROFILE_DIR = process.env.E2E_SETUP_PROFILE_DIR ?? "";
const DATABASE_URL = process.env.E2E_SETUP_DATABASE_URL ?? "";
const DEFAULTS_DIR = process.env.E2E_SETUP_DEFAULTS_DIR ?? "";

const configFile = (name: string): string => path.join(CONFIG_DIR, name);
const yaml = (file: string): Record<string, unknown> => parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const config = (name: string) => yaml(configFile(`${name}.yaml`));
const profile = (name: string) => yaml(path.join(PROFILE_DIR, `${name}.yaml`));
const shipped = (file: string): Record<string, unknown> => yaml(path.join(DEFAULTS_DIR, file));
const examplePreferences = () => shipped("profile.example/preferences.yaml") as { market: { pack: string; country: string; currency: string }; locations: string[] };
const setup = () => config("setup") as { completed_at: string | null; completed_by: string | null; steps?: Record<string, { status: string }> };

async function query<T extends Record<string, unknown>>(text: string): Promise<T[]> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return (await sql.unsafe(text)) as unknown as T[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "America/Los_Angeles" });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context.close();
});

async function save(next: string): Promise<void> {
  await page.getByTestId("setup-save").click();
  await expect(page).toHaveURL(new RegExp(`/setup\\?step=${next}$`));
  await expect(page.getByTestId("setup-wizard")).toHaveAttribute("data-step", next);
}

test("a fresh install opens the wizard; the API and the database stay untouched", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup\?step=language$/);
  await expect(page.getByTestId("setup-wizard")).toHaveAttribute("data-pending", "true");
  // no sidebar or search in the wizard
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByTestId("topbar")).toHaveAttribute("data-minimal", "true");
  const health = await page.request.get("/api/health", { maxRedirects: 0 });
  expect(health.status()).toBe(200);
  expect(await query("select id from cycles")).toEqual([]);
  // the web filled the empty directories on its first start: setup pending
  expect(setup().completed_at).toBeNull();
});

test("language: the browser's language is preselected, Chinese switches the page", async () => {
  await expect(page.getByTestId("setup-locale-en")).toBeChecked();
  await page.locator("label", { has: page.getByTestId("setup-locale-zh") }).click();
  await save("market");
  await expect(page.locator("h1")).toHaveText("设置 Job Radar");
  expect(setup().steps?.language?.status).toBe("done");
  expect((config("language") as { ui: { default_locale: string } }).ui.default_locale).toBe("zh");
});

// Hydration shows in the time zone: the server render has the shipped schedule's zone (America/New_York), the browser's own
// zone replaces it on a new install only once the page is hydrated. Wait for it before touching the step's controls.
// a city in the field is a chip with a remove button (the page is in Chinese since the language step)
const cityChip = (city: string) => page.getByRole("button", { name: `移除 ${city}` });
const hydrated = (): Promise<void> => expect(page.getByTestId("setup-timezone")).toHaveValue("America/Los_Angeles");

test("market: the example's market is preselected; another country brings its currency and main city until the user sets them", async () => {
  const { market, locations: cities } = examplePreferences();
  // the contract: a fresh install starts as a generic-pack US install in USD; if this changes, so does this walk-through
  expect(market).toMatchObject({ pack: "generic", country: "US", currency: "USD" });
  const country = page.getByTestId("market-country");
  const currency = page.getByTestId("market-currency");
  await hydrated();
  await expect(page.getByTestId("market-pack")).toHaveValue(market.pack);
  await expect(country).toHaveValue(market.country);
  await expect(currency).toHaveValue(market.currency);
  await expect(cityChip(cities[0] as string)).toBeVisible();
  // another country brings the currency of the country table and its main city, in place of the example's
  await country.selectOption("DE");
  await expect(currency).toHaveValue("EUR");
  await expect(cityChip("Berlin")).toBeVisible();
  await expect(cityChip(cities[0] as string)).toHaveCount(0);
  // a currency chosen by hand stays
  await currency.selectOption("CHF");
  await country.selectOption("NL");
  await expect(currency).toHaveValue("CHF");
  // nothing was saved: reloading the step goes back to the shipped example
  await page.reload();
  await hydrated();
  await expect(country).toHaveValue(market.country);
  await expect(currency).toHaveValue(market.currency);
});

test("market: the example's city, one added by hand, the browser's time zone and a chosen one land in preferences, search and schedule", async () => {
  const { market, locations: cities } = examplePreferences();
  await hydrated();
  // the example's city is in the field; add another by hand
  await expect(cityChip(cities[0] as string)).toBeVisible();
  await page.locator("#setup-market-cities").fill("Boston");
  await page.locator("#setup-market-cities").press("Enter");
  await expect(cityChip("Boston")).toBeVisible();
  // a new install preselects the browser's time zone, not the shipped schedule's
  await page.getByTestId("setup-timezone").selectOption("America/Chicago");
  await save("profile");
  const prefs = profile("preferences") as { market: { pack: string; country: string; currency: string }; locations: string[] };
  expect(prefs.market).toMatchObject({ pack: market.pack, country: market.country, currency: market.currency });
  expect(prefs.locations).toEqual([...cities, "Boston"]);
  expect((config("search") as { locations: string[] }).locations).toEqual([...cities, "Boston"]);
  expect(config("schedule").timezone).toBe("America/Chicago");
  expect(setup().steps?.market?.status).toBe("done");
});

test("profile: the summary is written to me.yaml (with a history snapshot)", async () => {
  await expect(page.getByTestId("setup-profile-privacy")).toBeVisible();
  await page.locator("#setup-profile-summary").fill("Backend engineer moving into data work.");
  await save("targets");
  expect(profile("me").summary).toBe("Backend engineer moving into data work.");
  const rows = await query<{ n: number }>("select count(*)::int as n from profile_snapshots where kind = 'me'");
  expect(rows[0]?.n).toBeGreaterThan(0);
});

test("targets: the preview says the example keywords are replaced, and they are", async () => {
  await page.locator("#setup-targets-titles").fill("Data Engineer");
  await page.locator("#setup-targets-titles").press("Enter");
  await expect(page.getByTestId("setup-keyword-preview")).toHaveAttribute("data-mode", "replace");
  const titles = (profile("preferences") as { target_titles: string[] }).target_titles;
  await save("sources");
  const groups = (config("search") as { keyword_groups: Record<string, string[]> }).keyword_groups;
  expect(groups).toEqual({ targets: [...titles, "Data Engineer"] });
});

test("sources: skip, come back through the step bar, then save a switch", async () => {
  await page.getByTestId("setup-skip").click();
  await expect(page).toHaveURL(/step=ai$/);
  expect(setup().steps?.sources?.status).toBe("skipped");
  await expect(page.getByTestId("setup-stepper").locator('[data-step="sources"]')).toHaveAttribute("data-state", "skipped");

  await page.getByTestId("setup-stepper").locator('[data-step="sources"]').click();
  await expect(page).toHaveURL(/step=sources$/);
  // the focus moved to the step's heading
  await expect(page.getByTestId("setup-step-heading")).toBeFocused();
  const greenhouse = page.locator('[data-testid="setup-channel"][data-channel="greenhouse"]');
  const before = (await greenhouse.getAttribute("data-state")) === "checked";
  await greenhouse.click();
  await save("ai");
  expect(((config("sources") as { sources: Record<string, { enabled: boolean }> }).sources.greenhouse?.enabled)).toBe(!before);
  expect(setup().steps?.sources?.status).toBe("done");
});

test("sources: scraping channels start unticked and need the confirmation to be saved", async () => {
  const indeedEnabled = (): boolean => ((config("sources") as { sources: Record<string, { enabled: boolean }> }).sources.indeed?.enabled);
  await page.goto("/setup?step=sources");
  const indeed = page.locator('[data-testid="setup-channel"][data-channel="indeed"]');
  // a scraping channel is never pre-ticked, even though an earlier save may have left it on; each row carries the notice
  await expect(indeed).toHaveAttribute("data-state", "unchecked");
  await expect(page.locator('[data-testid="setup-channel-consent"][data-channel="indeed"]')).toBeVisible();
  await expect(page.getByTestId("setup-consent-ack")).toHaveCount(0);

  // ticking it asks for the confirmation; saving without it is refused and the file stays as it is
  await indeed.click();
  await expect(page.getByTestId("setup-consent-ack")).toBeVisible();
  await expect(page.getByTestId("setup-consent-docs").getByTestId("doc-link-scraping")).toHaveAttribute("href", /\/blob\/v\d+\.\d+\.\d+[^/]*\/docs\/sources(\.zh)?\.md#/);
  const before = indeedEnabled();
  await page.getByTestId("setup-save").click();
  await expect(page.locator("#setup-consent-ack-msg")).toBeVisible();
  await expect(page.getByTestId("setup-wizard")).toHaveAttribute("data-step", "sources");
  expect(indeedEnabled()).toBe(before);
  expect(before).toBe(false);

  // with the confirmation it is saved
  await page.getByTestId("setup-consent-ack").click();
  await save("ai");
  expect(indeedEnabled()).toBe(true);
});

test("ai: the worker is offline (no ai-worker here), a provider is switched off", async () => {
  await expect(page.getByTestId("setup-ai-worker")).toHaveAttribute("data-state", "offline");
  await expect(page.getByTestId("setup-ai-disclosure").getByTestId("doc-link-aiProviders")).toHaveAttribute("href", /ai-providers(\.zh)?\.md#/);
  const mimo = page.locator('[data-testid="setup-ai-provider"][data-provider="mimo"]').getByTestId("setup-ai-use");
  await expect(mimo).toBeVisible();
  if ((await mimo.getAttribute("data-state")) !== "checked") await mimo.click();
  // the note names the vendors that are switched on right now
  await expect(page.getByTestId("setup-ai-disclosure")).toContainText("Xiaomi MiMo");
  await mimo.click();
  await expect(page.getByTestId("setup-ai-disclosure")).not.toContainText("Xiaomi MiMo");
  await save("telegram");
  expect(((config("ai") as { providers: Record<string, { enabled: boolean }> }).providers.mimo?.enabled)).toBe(false);
});

test("telegram: variables by name only, the switch lands in notify.yaml", async () => {
  await expect(page.getByTestId("env-presence").first()).toContainText("TELEGRAM_BOT_TOKEN");
  await expect(page.getByTestId("telegram-status")).toBeVisible();
  await expect(page.getByTestId("telegram-setup-command").first()).toHaveText("pnpm run setup --step telegram");
  const enabledBefore = ((config("notify") as { telegram: { enabled: boolean } }).telegram.enabled);
  await page.getByTestId("setup-telegram-enabled").click();
  await page.getByTestId("setup-telegram-locale").selectOption("en");
  await save("review");
  expect((config("language") as { notify: { locale: string | null } }).notify.locale).toBe("en");
  expect(((config("notify") as { telegram: { enabled: boolean } }).telegram.enabled)).toBe(!enabledBefore);
});

test("review: readiness, the first cycle is queued, finish ends the redirect", async () => {
  await expect(page.getByTestId("setup-readiness").locator("li")).toHaveCount(5);
  await page.getByTestId("setup-first-cycle-button").click();
  await expect.poll(async () => (await query<{ kind: string }>("select kind from control_requests")).map((r) => r.kind)).toEqual(["run_cycle"]);
  await page.getByTestId("setup-save").click();
  await expect(page).toHaveURL(/\/$/);
  expect(setup()).toMatchObject({ completed_by: "wizard" });
  expect(setup().completed_at).not.toBeNull();
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("aside")).toHaveCount(1);
});

test("settings → manual actions reopens the wizard in review mode", async () => {
  await page.goto("/settings?tab=actions");
  await page.getByTestId("setup-wizard-open").click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("setup-review-note")).toBeVisible();
  await expect(page.getByTestId("setup-wizard")).toHaveAttribute("data-pending", "false");
  // no redirect while reviewing
  await page.goto("/insights");
  await expect(page).toHaveURL(/\/insights$/);
});

test("phone width, keyboard only: the compact step bar, no horizontal scroll, Enter saves", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/setup?step=telegram");
  await expect(page.getByTestId("setup-stepper-compact")).toHaveText("7/8 · Telegram");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator("body").press("Tab");
  for (let i = 0; i < 40; i += 1) {
    if ((await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "setup-save") break;
    await page.keyboard.press("Tab");
  }
  await expect(page.getByTestId("setup-save")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/step=review$/);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("skip the wizard: marked complete as skipped, no more redirect", async () => {
  // back to "pending" on this throw-away install
  fs.writeFileSync(configFile("setup.yaml"), "completed_at: null\n");
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/setup\?step=language$/);
  await page.getByTestId("setup-skip-wizard-button").click();
  await page.getByTestId("setup-skip-wizard-confirm").click();
  await expect(page).toHaveURL(/\/$/);
  expect(setup()).toMatchObject({ completed_by: "skipped" });
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/jobs$/);
});
