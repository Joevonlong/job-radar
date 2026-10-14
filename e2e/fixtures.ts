import { test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";

// everything else of @playwright/test (expect, the types) passes through unchanged; `test` below takes the place of its own
export * from "@playwright/test";

/**
 * The `test` every e2e spec imports (instead of the one of `@playwright/test`; `pnpm lint` enforces it): leaving a page
 * never cuts off a Server Action that is still on its way.
 *
 * A Server Action is a `fetch` POST with a `Next-Action` header (Next 16: `fetchServerAction` in
 * next/dist/client/components/router-reducer/reducers/server-action-reducer.js). The server runs the action to the end
 * before it answers, and a redirect from an action is still a 200 whose body is the target's Flight stream (header
 * `x-action-redirect`), so "the response body has arrived in full" means the write is done, redirect or not. A reload or
 * navigation while the request is still out cancels it: the UI already showed the change (optimistic update), the server
 * never stored it, and the page after the reload contradicts the one before.
 *
 * So every page of every context (the `context` and `page` fixtures and `browser.newContext()` / `browser.newPage()`)
 * gets an init script that counts the action requests the page itself started, from the call to `fetch` until the last
 * byte of the response (or the failure), and `page.goto()`, `reload()`, `goBack()`, `goForward()`, `close()`,
 * `context.close()` and the end of each test first wait until no page of the context has one outstanding. Counting in
 * the page, not from Playwright's network events, leaves no gap between "the page called fetch" and "the test saw the
 * request". An action that has not reached `fetch` yet (Next first encodes its arguments, and queued actions run one
 * at a time) is invisible to it; that window is short but not zero. After the last one settles the wait stays a moment longer (`SETTLE_MS`), so an action queued behind it (the
 * router runs them one at a time) starts and is counted too.
 *
 * Not covered: a full-document navigation the page itself starts (a link click, a form submit), `page.setContent()`,
 * `browser.close()`, and contexts from `browser.newContext()` that the test never closes (only the `context` fixture has
 * an end-of-test wait). Call `waitForServerActions(page)` before those.
 *
 * A test that means to leave mid-action (none does today) calls `page.evaluate(() => location.reload())`.
 * `E2E_SERVER_ACTION_DELAY_MS=<ms>` holds every action request that long before it is sent: it exposes navigation
 * paths the guard does not cover and reads of stored state (the database) that skip the wait, and makes them fail every
 * time instead of now and then (`E2E_SERVER_ACTION_DELAY_MS=1000 pnpm test:e2e e2e/favorites.spec.ts`). It does not
 * catch a spec that imports `test` from `@playwright/test`: it only applies inside this fixture; lint covers imports.
 */

/** How long the guarded calls wait for outstanding actions before they fail (a fixture option, see `test.use`). */
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * How long "no action outstanding" must hold after the last one finished. The router runs actions one at a time: after
 * one's last byte, React decodes and commits it before the next queued action calls `fetch`, and on a loaded CI runner
 * that takes well over 100 ms. The page cannot tell "queue empty" from "next one about to start", so the wait is a
 * quiet period instead, generous enough for that gap; every new action restarts it.
 */
const SETTLE_MS = 400;
const POLL_MS = 20;

/** One outstanding action request, as the page reports it. */
export interface PendingServerAction {
  actionId: string;
  url: string;
  ageMs: number;
}

interface PageActionState {
  pending: PendingServerAction[];
  /** milliseconds since the last action request settled, or null when none has */
  sinceLastSettledMs: number | null;
}

interface ServerActionTracker {
  state: () => PageActionState;
}

declare global {
  interface Window {
    __e2eServerActions?: ServerActionTracker;
  }
}

/** Runs in the page before any of its scripts (an init script: no closures, nothing imported). */
function installServerActionTracker(): void {
  if (window.__e2eServerActions) return;
  const pending = new Map<number, { actionId: string; url: string; started: number }>();
  let next = 0;
  let lastSettled: number | null = null;
  const originalFetch = window.fetch;

  const actionIdOf = (input: RequestInfo | URL, init?: RequestInit): string | null => {
    try {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      return headers.get("next-action");
    } catch {
      return null;
    }
  };
  const urlOf = (input: RequestInfo | URL): string => new URL(input instanceof Request ? input.url : String(input), location.href).href;

  window.fetch = function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const actionId = actionIdOf(input, init);
    const request = originalFetch.call(window, input, init);
    if (actionId === null) return request;
    const id = next++;
    pending.set(id, { actionId, url: urlOf(input), started: performance.now() });
    const settle = () => {
      pending.delete(id);
      lastSettled = performance.now();
    };
    // Done when the whole body has arrived (a copy is read; the caller reads its own), or the request failed.
    // This handler is attached before the caller's, so the copy is taken before the caller touches the body.
    request
      .then((response) => response.clone().arrayBuffer())
      .then(settle, settle);
    return request;
  };

  window.__e2eServerActions = {
    state: () => {
      const now = performance.now();
      return {
        pending: [...pending.values()].map((entry) => ({ actionId: entry.actionId, url: entry.url, ageMs: Math.round(now - entry.started) })),
        sinceLastSettledMs: lastSettled === null ? null : now - lastSettled,
      };
    },
  };
}

class TimeoutSignal extends Error {}

/** `budgetMs` bounds the read: a hung renderer must not outlast the wait's own deadline. */
async function pageState(page: Page, budgetMs: number): Promise<PageActionState | "unresponsive"> {
  if (page.isClosed()) return { pending: [], sinceLastSettledMs: null };
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = page.evaluate(() => window.__e2eServerActions?.state() ?? { pending: [], sinceLastSettledMs: null });
    read.catch(() => undefined); // a read that loses the race below may still reject later
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutSignal()), Math.max(budgetMs, 1));
    });
    return await Promise.race([read, timedOut]);
  } catch (error) {
    // A renderer that does not answer within the budget: the caller fails the wait (it cannot know nothing is pending).
    if (error instanceof TimeoutSignal) return "unresponsive";
    // The page is navigating or closing on its own: whatever it had outstanding is cut off already, nothing to wait for.
    return { pending: [], sinceLastSettledMs: null };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until no page of `context` has a Server Action outstanding (and none finished in the last `SETTLE_MS`). Called by
 * the guarded methods; a spec calls it itself before it reads stored state another way (the database, a config file).
 */
export async function waitForServerActions(target: Page | BrowserContext, why = "waitForServerActions()", timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const context = "context" in target ? target.context() : target;
  const deadline = Date.now() + timeoutMs;
  let lastPending: PendingServerAction[] = [];
  for (;;) {
    const reads = await Promise.all(context.pages().map((p) => pageState(p, deadline - Date.now())));
    const unresponsive = reads.includes("unresponsive");
    const states = reads.filter((read): read is PageActionState => read !== "unresponsive");
    const pending = unresponsive ? lastPending : states.flatMap((state) => state.pending);
    lastPending = pending;
    const settling = states.some((state) => state.sinceLastSettledMs !== null && state.sinceLastSettledMs < SETTLE_MS);
    // an unresponsive page never counts as "nothing outstanding": the wait runs to its deadline and fails
    if (!unresponsive && pending.length === 0 && !settling) return;
    if (Date.now() >= deadline) {
      const list = pending.map((p) => `POST ${new URL(p.url).pathname} (action ${p.actionId}, out for ${p.ageMs} ms)`).join(", ");
      const why2 = unresponsive && pending.length === 0 ? "a page did not answer" : "a Server Action is still in flight";
      throw new Error(`${why}: ${why2} after ${timeoutMs} ms: ${list || "(one just finished)"}. Leaving the page now would cancel it.`);
    }
    await sleep(POLL_MS);
  }
}

const guardedPages = new WeakSet<Page>();
const guardedContexts = new WeakSet<BrowserContext>();
const guardedBrowsers = new WeakSet<Browser>();
const timeouts = new WeakMap<BrowserContext, number>();
const timeoutOf = (context: BrowserContext) => timeouts.get(context) ?? DEFAULT_TIMEOUT_MS;

function guardPage(page: Page): Page {
  if (guardedPages.has(page)) return page;
  guardedPages.add(page);
  const wait = (method: string) => waitForServerActions(page, `page.${method}()`, timeoutOf(page.context()));
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  const goBack = page.goBack.bind(page);
  const goForward = page.goForward.bind(page);
  const close = page.close.bind(page);
  page.goto = async (...args) => {
    await wait("goto");
    return goto(...args);
  };
  page.reload = async (...args) => {
    await wait("reload");
    return reload(...args);
  };
  page.goBack = async (...args) => {
    await wait("goBack");
    return goBack(...args);
  };
  page.goForward = async (...args) => {
    await wait("goForward");
    return goForward(...args);
  };
  page.close = async (...args) => {
    await wait("close");
    return close(...args);
  };
  return page;
}

async function guardContext(context: BrowserContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BrowserContext> {
  timeouts.set(context, timeoutMs);
  if (guardedContexts.has(context)) return context;
  guardedContexts.add(context);
  await context.addInitScript(installServerActionTracker);
  const delayMs = Number(process.env.E2E_SERVER_ACTION_DELAY_MS ?? 0);
  if (delayMs > 0) {
    await context.route("**/*", async (route) => {
      if (route.request().headers()["next-action"] === undefined) return route.fallback();
      await sleep(delayMs);
      // the page may be gone by now (that is the race this exposes): then there is nothing left to continue
      await route.continue().catch(() => undefined);
    });
  }
  for (const page of context.pages()) guardPage(page);
  context.on("page", guardPage);
  const close = context.close.bind(context);
  context.close = async (...args) => {
    await waitForServerActions(context, "context.close()", timeoutOf(context));
    return close(...args);
  };
  return context;
}

function guardBrowser(browser: Browser): void {
  if (guardedBrowsers.has(browser)) return;
  guardedBrowsers.add(browser);
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = async (...args) => guardContext(await newContext(...args));
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    // a page of its own context, still on about:blank: the init script applies from its first navigation on
    await guardContext(page.context());
    return guardPage(page);
  };
}

interface Options {
  /** How long a guarded navigation waits for outstanding Server Actions before it fails. */
  serverActionTimeout: number;
}

export const test = base.extend<Options>({
  serverActionTimeout: [DEFAULT_TIMEOUT_MS, { option: true }],
  browser: [
    async ({ browser }, provide) => {
      guardBrowser(browser);
      await provide(browser);
    },
    { scope: "worker" },
  ],
  context: async ({ context, serverActionTimeout }, provide) => {
    await guardContext(context, serverActionTimeout);
    await provide(context);
    // the end of the test closes the context: what the test started is stored before the next test reads it
    await waitForServerActions(context, "the end of the test", serverActionTimeout);
  },
  page: async ({ page }, provide) => {
    await provide(guardPage(page));
  },
});
