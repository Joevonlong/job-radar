import fs from "node:fs";
import path from "node:path";

import type { BrowserContext, Page } from "@playwright/test";
import postgres from "postgres";

import { STAGING_DIR } from "../scripts/demo/settings";

import { assertNoLeaks, buildForbiddenPatterns, guardedScreenshot, loadPrivateStrings, machineFacts, TrafficLog, type ForbiddenPattern } from "./guard";

/** The product repository root. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const STAGING = path.join(REPO_ROOT, STAGING_DIR);

export type Locale = "en" | "zh";
export type Theme = "light" | "dark";

let patterns: ForbiddenPattern[] | null = null;
/** Whether the run must have the private patterns (`DEMO_REQUIRE_PATTERNS=1`, set by `pnpm demo:shots`). */
export const REQUIRE_PATTERNS = process.env.DEMO_REQUIRE_PATTERNS === "1";

/** The guard's patterns, built once per run (an extra string from `DEMO_ENV_SENTINEL` is added for the `.env` check). */
export function forbiddenPatterns(): ForbiddenPattern[] {
  if (patterns === null) {
    const extra = process.env.DEMO_ENV_SENTINEL ? [process.env.DEMO_ENV_SENTINEL] : [];
    const { strings } = loadPrivateStrings(REPO_ROOT, { require: REQUIRE_PATTERNS });
    patterns = buildForbiddenPatterns(machineFacts(REPO_ROOT), [...strings, ...extra]);
  }
  return patterns;
}

/** Language cookie and theme (next-themes keeps it in localStorage `theme`) before the first page load. */
export async function setLook(context: BrowserContext, baseURL: string, look: { locale: Locale; theme: Theme }): Promise<void> {
  await context.addCookies([{ name: "NEXT_LOCALE", value: look.locale, url: baseURL }]);
  await context.addInitScript((theme) => {
    try {
      window.localStorage.setItem("theme", theme);
    } catch {
      // no storage: the default (light) applies
    }
  }, look.theme);
}

/** Record every HTML / RSC response body and request URL of the page for the guard. */
export function recordTraffic(page: Page): { log: TrafficLog; settle: () => Promise<void> } {
  const log = new TrafficLog();
  const pending: Array<Promise<void>> = [];
  page.on("request", (request) => log.add(`request URL ${request.url()}`, request.url()));
  page.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (!/text\/html|text\/x-component|application\/json|text\/plain/.test(type)) return;
    pending.push(
      response
        .text()
        .then((body) => log.add(`response body of ${response.url()}`, body))
        .catch(() => {}),
    );
  });
  return { log, settle: async () => void (await Promise.all(pending.splice(0))) };
}

/** Wait until the page is at rest: network idle, fonts loaded, no skeletons, no busy regions, no toasts. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForFunction(() => document.querySelectorAll(".animate-pulse, [aria-busy='true'], [data-sonner-toast]").length === 0, null, { timeout: 15_000 });
  // hide the text caret and scrollbars: they are not part of the interface
  await page.addStyleTag({ content: "*{caret-color:transparent !important} ::-webkit-scrollbar{display:none} html{scrollbar-width:none}" });
  await page.waitForTimeout(300);
}

/** Fail when the page scrolls sideways. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Guard, then picture (into the staging directory). */
export async function shoot(page: Page, traffic: { log: TrafficLog; settle: () => Promise<void> }, file: string): Promise<void> {
  await traffic.settle();
  fs.mkdirSync(STAGING, { recursive: true });
  await guardedScreenshot(page, path.join(STAGING, file), forbiddenPatterns(), traffic.log);
}

/** Guard without a picture (the GIF's pages: the video records everything shown). */
export async function guard(page: Page, traffic: { log: TrafficLog; settle: () => Promise<void> }): Promise<void> {
  await traffic.settle();
  await assertNoLeaks(page, forbiddenPatterns(), traffic.log);
}

/** A short-lived connection to the demo database. */
export async function withDemoDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set (playwright.shots.config.ts sets it)");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function jobIdByTitle(title: string): Promise<number> {
  return withDemoDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`select id from jobs where title = ${title} limit 1`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no demo job "${title}"`);
    return Number(id);
  });
}
