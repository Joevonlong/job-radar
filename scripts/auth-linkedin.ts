/**
 * Log in to LinkedIn once, yourself, so the `linkedin-session` channel can read with your login.
 *
 *   pnpm auth:linkedin                    open a browser window, log in (two-step verification included), then close the window
 *   pnpm auth:linkedin --status           show what is on disk and what the channels last learned; opens nothing
 *   pnpm auth:linkedin --timeout-minutes 20
 *
 * This opens a normal, visible Chromium window on THIS machine. You type your password and complete any verification in that window;
 * the script never reads, stores or types a password, and never touches a verification page. It only watches for the login to
 * succeed and then saves the browser's login state (cookies) to `linkedin.session.site.auth_file` (default `.auth/linkedin.json`;
 * gitignored, mode 600). Treat that file like a password: anyone holding it is logged in as you.
 *
 * Run it on the host (the Docker runner mounts `.auth/` read-only). After saving, the script also marks the login valid in the
 * database and closes the circuit a login-wall / verification stop opened (when `DATABASE_URL` is reachable).
 */
import { parseArgs } from "node:util";

import { isLoggedInState, readAuthFileInfo, resolveAuthFile, writeAuthFile } from "../src/lib/channels/linkedin/session/auth-file";
import { AUTH_FLAG_KEY, loginStateOf, readAuthFlag } from "../src/lib/channels/linkedin/session/auth-state";
import { resetSessionAuth } from "../src/lib/channels/linkedin/session/store";
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { getRuntimeState } from "../src/lib/db/repos/runtime-state";

const POLL_MS = 2000;
/** Pages that are not "logged in and looking at LinkedIn": a state captured while on one of them is not saved. */
const NOT_LOGGED_IN_PATH = /^\/(?:login|uas|checkpoint|authwall|signup|challenge)(?:[/?#]|$)/i;

function fail(message: string): never {
  console.error(`auth:linkedin: ${message}`);
  process.exit(2);
}

async function status(authFile: string): Promise<number> {
  const info = readAuthFileInfo(authFile);
  console.log(`login file : ${info.path}`);
  console.log(`exists     : ${info.exists ? "yes" : "no"}`);
  console.log(`has login  : ${info.hasSessionCookie ? "yes (LinkedIn session cookie present)" : "no"}`);
  if (info.sessionCookieExpiresAt) console.log(`expires    : ${info.sessionCookieExpiresAt.toISOString()}`);
  if (info.modifiedAt) console.log(`written    : ${info.modifiedAt.toISOString()}`);
  let flag = null;
  try {
    flag = readAuthFlag((await getRuntimeState(getDb(), AUTH_FLAG_KEY))?.value);
  } catch {
    console.log("channel state: unknown (database not reachable)");
  }
  const state = loginStateOf(info, flag, new Date());
  console.log(`status     : ${{ missing: "missing (not logged in)", valid: "valid", expired: "expired" }[state.status]}${state.reason ? ` - ${state.reason}` : ""}`);
  await closeDb().catch(() => {});
  return state.status === "valid" ? 0 : 1;
}

async function main(): Promise<number> {
  let values: { status?: boolean; "timeout-minutes"?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: { status: { type: "boolean" }, "timeout-minutes": { type: "string", default: "15" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "bad arguments");
  }
  if (values.help) {
    console.log("Usage: pnpm auth:linkedin [--status] [--timeout-minutes N]");
    return 0;
  }
  const settings = loadConfig("channels").linkedin.session;
  const authFile = resolveAuthFile(settings.site.auth_file);
  if (values.status) return status(authFile);

  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return fail("--timeout-minutes must be a positive number");

  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return fail(
      /executable doesn't exist|playwright install/i.test(message)
        ? "Chromium is not installed for Playwright: run `pnpm exec playwright install chromium`, then try again"
        : "could not open a browser window (this needs a desktop session on this machine)",
    );
  }

  const context = await browser.newContext({ locale: settings.browser.locale, viewport: null });
  const page = await context.newPage();
  const loginUrl = new URL("/login", settings.site.base_url).toString();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("A browser window is open on LinkedIn's login page.");
  console.log("  1. Log in there yourself (two-step verification included).");
  console.log("  2. When you see your LinkedIn feed, close the browser window.");
  console.log(`Nothing you type is read by this script. Waiting up to ${timeoutMinutes} minutes ...`);

  let closed = false;
  browser.on("disconnected", () => {
    closed = true;
  });
  let snapshot: unknown = null;
  let savedOnce = false;
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (!closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (closed) break;
    try {
      const onLoginPage = context.pages().some((p) => {
        try {
          return NOT_LOGGED_IN_PATH.test(new URL(p.url()).pathname);
        } catch {
          return false;
        }
      });
      if (onLoginPage) continue;
      const state: unknown = await context.storageState();
      if (!isLoggedInState(state)) continue;
      snapshot = state;
      if (!savedOnce) {
        writeAuthFile(authFile, state);
        savedOnce = true;
        console.log("Login detected. Close the browser window when you are done (the login state is saved when you do).");
      }
    } catch {
      // the window was closed while the state was read
      break;
    }
  }
  if (!closed) {
    console.log(`Timed out after ${timeoutMinutes} minutes.`);
    await browser.close().catch(() => {});
  }

  if (snapshot === null) {
    console.error("auth:linkedin: no login was detected, so nothing was saved. Run it again and log in before closing the window.");
    return 1;
  }
  writeAuthFile(authFile, snapshot);
  console.log(`Saved the login state to ${authFile} (owner-only, mode 600). Do not commit or share it.`);

  try {
    const reset = await resetSessionAuth(getDb(), new Date());
    console.log(reset.length > 0 ? `Marked the login valid and closed the circuit of: ${reset.join(", ")}.` : "Marked the login valid.");
  } catch {
    console.log("The database was not reachable: the login file is saved, but a channel circuit that a verification stop opened stays open until its cooldown ends.");
  } finally {
    await closeDb().catch(() => {});
  }
  console.log("Next: set linkedin.session.enabled to true in config/sources.yaml after `pnpm cycle:run --channel linkedin-session --dry-run` works.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`auth:linkedin: ${error instanceof Error ? error.message : "unexpected error"}`);
    process.exit(1);
  },
);
