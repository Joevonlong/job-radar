import { ChannelError } from "../../errors";

/**
 * The browser the session channels read LinkedIn with. The interface is what the channels need and nothing more: open a URL
 * (GET navigation) and return what loaded. There is deliberately no click, type or submit: the channels are read-only, and
 * a verification page is never interacted with.
 */

export interface LoadedPage {
  /** The URL after redirects. */
  url: string;
  /** HTTP status of the navigation; null when the browser gave none. */
  status: number | null;
  html: string;
}

export interface LoadOptions {
  /** Scroll the page's list so its lazily rendered cards exist before the HTML is read. */
  scrollList: boolean;
}

export interface SessionBrowser {
  load(url: string, options: LoadOptions): Promise<LoadedPage>;
  close(): Promise<void>;
}

export interface BrowserOptions {
  /** Playwright storage state of the logged-in user (`pnpm auth:linkedin`). */
  authFile: string;
  headless: boolean;
  navigationTimeoutMs: number;
  renderWaitMs: number;
  scrollSteps: number;
  scrollPauseMs: number;
  locale: string;
  blockResources: readonly string[];
  /** Empty = the browser's own. */
  userAgent: string;
  signal: AbortSignal;
}

export type OpenBrowser = (options: BrowserOptions) => Promise<SessionBrowser>;

/** The element LinkedIn's job lists scroll in; falls back to the window. */
const LIST_SCROLLER_SELECTORS = [".scaffold-layout__list > div", ".scaffold-layout__list", ".jobs-search-results-list", ".jobs-search-results-list__list"];

/** Runs in the page: scroll the list one viewport (about 0.8 of its height) and report whether it moved. */
const SCROLL_STEP = `(selectors) => {
  const el = selectors.map((s) => document.querySelector(s)).find((e) => e && e.scrollHeight > e.clientHeight);
  if (el) {
    const before = el.scrollTop;
    el.scrollBy(0, Math.max(200, Math.floor(el.clientHeight * 0.8)));
    return el.scrollTop !== before;
  }
  const before = window.scrollY;
  window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.8)));
  return window.scrollY !== before;
}`;

/** Playwright (Chromium) behind `SessionBrowser`. `playwright-core` is loaded on first use: the web app and the tests never pull it in. */
export const openPlaywrightBrowser: OpenBrowser = async (options) => {
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    // /dev/shm is tiny in a container; without this Chromium crashes on heavy pages
    browser = await chromium.launch({ headless: options.headless, args: ["--disable-dev-shm-usage"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const missing = /executable doesn't exist|Executable doesn't exist|playwright install/i.test(message);
    throw new ChannelError(
      "unknown",
      missing ? "Chromium is not installed for Playwright (run `pnpm exec playwright install chromium`)" : "could not start the browser",
      { retryable: false, cause: error },
    );
  }
  const closeBrowser = (): void => void browser.close().catch(() => {});
  options.signal.addEventListener("abort", closeBrowser, { once: true });

  try {
    const blocked = new Set(options.blockResources);
    const context = await browser.newContext({
      storageState: options.authFile,
      locale: options.locale,
      viewport: { width: 1366, height: 900 },
      ...(options.userAgent === "" ? {} : { userAgent: options.userAgent }),
    });
    if (blocked.size > 0) {
      await context.route("**/*", (route) => (blocked.has(route.request().resourceType()) ? route.abort() : route.continue()));
    }
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
    context.setDefaultTimeout(options.navigationTimeoutMs);
    const page = await context.newPage();

    return {
      async load(url, loadOptions) {
        options.signal.throwIfAborted();
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        if (options.renderWaitMs > 0) await page.waitForTimeout(options.renderWaitMs);
        if (loadOptions.scrollList) {
          for (let step = 0; step < options.scrollSteps; step += 1) {
            options.signal.throwIfAborted();
            const moved = await page.evaluate(`(${SCROLL_STEP})(${JSON.stringify(LIST_SCROLLER_SELECTORS)})`);
            if (options.scrollPauseMs > 0) await page.waitForTimeout(options.scrollPauseMs);
            if (moved === false) break;
          }
        }
        return { url: page.url(), status: response?.status() ?? null, html: await page.content() };
      },
      async close() {
        options.signal.removeEventListener("abort", closeBrowser);
        await browser.close().catch(() => {});
      },
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
};

/** One LinkedIn browsing session at a time, process-wide: both session channels share one account, one request counter and one pace. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}

export const sessionMutex = new Mutex();
