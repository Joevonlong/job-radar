import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "./fixtures";

/**
 * The guard in e2e/fixtures.ts, against a tiny server of its own (not the app): an "action" is a POST with a
 * `Next-Action` header, as Next sends it. The server stores the write only when the request is still open once its
 * (slow) work is done, the way a cancelled request never reaches the database; it counts what it stored and what was cut off.
 */

interface Counts {
  received: number;
  stored: number;
  cutOff: number;
  /** answers whose last byte went out */
  finished: number;
}

async function startServer(workMs: number) {
  const counts: Counts = { received: 0, stored: 0, cutOff: 0, finished: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>guard</title><p>page</p>");
      return;
    }
    counts.received++;
    let gone = false;
    res.on("close", () => {
      if (!res.writableFinished) gone = true;
    });
    res.on("finish", () => counts.finished++);
    req.resume();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/hang") return;
    if (path === "/stream") {
      // the shape of an action that redirects: stored first, then a 200 whose Flight body streams for a while
      counts.stored++;
      res.writeHead(200, { "content-type": "text/x-component", "x-action-redirect": "/elsewhere;push" });
      res.write("0:first\n");
      setTimeout(() => {
        if (gone) counts.cutOff++;
        else res.end("1:last\n");
      }, workMs);
      return;
    }
    setTimeout(() => {
      if (gone) {
        counts.cutOff++;
        return;
      }
      counts.stored++;
      res.writeHead(200, { "content-type": "text/x-component" }).end("0:done\n");
    }, workMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { url, counts, stop };
}

/** Start a POST from the page without waiting for it (as a click handler would). */
function post(page: Page, path: string, actionId: string | null) {
  return page.evaluate(
    ([target, id]) => {
      void fetch(target, { method: "POST", headers: id === null ? {} : { "Next-Action": id }, body: "[]" }).catch(() => undefined);
    },
    [path, actionId] as const,
  );
}

test.describe("server action guard", () => {
  test("reload waits for an action that is still on its way, and the write is stored", async ({ page }) => {
    const server = await startServer(800);
    try {
      await page.goto(server.url);
      await post(page, "/save", "a1");
      await page.reload();
      expect(server.counts).toMatchObject({ received: 1, stored: 1, cutOff: 0 });
    } finally {
      await server.stop();
    }
  });

  test("without the guard (a reload from inside the page) the same write is lost", async ({ page }) => {
    const server = await startServer(800);
    try {
      await page.goto(server.url);
      await post(page, "/save", "a1");
      await expect.poll(() => server.counts.received).toBe(1);
      await page.evaluate(() => location.reload());
      await page.waitForLoadState("load");
      await expect.poll(() => server.counts.cutOff + server.counts.stored).toBe(1);
      expect(server.counts).toMatchObject({ stored: 0, cutOff: 1 });
    } finally {
      await server.stop();
    }
  });

  test("a streamed answer (the shape of a redirecting action) counts until its last byte", async ({ page }) => {
    const server = await startServer(800);
    try {
      await page.goto(server.url);
      await post(page, "/stream", "a2");
      await expect.poll(() => server.counts.received).toBe(1);
      await page.reload();
      expect(server.counts).toMatchObject({ stored: 1, finished: 1, cutOff: 0 });
    } finally {
      await server.stop();
    }
  });

  test("goto, and another page of the same context, wait for an action of the first page", async ({ page, context }) => {
    const server = await startServer(600);
    try {
      await page.goto(server.url);
      await post(page, "/save", "a3");
      const other = await context.newPage();
      await other.goto(server.url);
      expect(server.counts.stored).toBe(1);
      await post(page, "/save", "a4");
      await page.goto(`${server.url}?again`);
      expect(server.counts).toMatchObject({ stored: 2, cutOff: 0 });
    } finally {
      await server.stop();
    }
  });

  test("a POST without the Next-Action header is not waited for", async ({ page }) => {
    const server = await startServer(800);
    try {
      await page.goto(server.url);
      await post(page, "/save", null);
      await expect.poll(() => server.counts.received).toBe(1);
      await page.reload();
      await expect.poll(() => server.counts.cutOff + server.counts.stored).toBe(1);
      expect(server.counts.cutOff).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test.describe("with a short limit", () => {
    test.use({ serverActionTimeout: 400 });

    test("an action that never answers fails the reload, naming the action and its path", async ({ page }) => {
      const server = await startServer(0);
      try {
        await page.goto(server.url);
        await post(page, "/hang", "stuck-action");
        await expect(page.reload()).rejects.toThrow(/page\.reload\(\): a Server Action is still in flight after 400 ms: POST \/hang \(action stuck-action/);
        // let go of it (a reload from inside the page cuts it off), so the end of the test has nothing to wait for
        await page.evaluate(() => location.reload());
        await page.waitForLoadState("load");
      } finally {
        await server.stop();
      }
    });
  });
});
