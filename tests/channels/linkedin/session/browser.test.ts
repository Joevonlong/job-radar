// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openPlaywrightBrowser, type BrowserOptions } from "@/lib/channels/linkedin/session/browser";

import { tempDir } from "./helpers";

/**
 * The real Playwright adapter against a local web server (never LinkedIn): the saved login is sent, blocked resources are
 * not fetched, redirects and statuses are reported, and a lazily rendered list is scrolled until its cards exist. Skipped when
 * Chromium is not installed for Playwright on this machine.
 */
async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright-core");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const installed = await chromiumInstalled();

const LAZY_PAGE = `<!doctype html><html><body>
<div class="scaffold-layout__list" style="height:200px;overflow:auto"><div style="height:200px;overflow:auto" id="scroller"><ul id="list"></ul><div style="height:3000px"></div></div></div>
<img src="/pixel.png">
<script>
  let n = 0;
  const add = () => { for (let i = 0; i < 5; i++) { n += 1; const li = document.createElement('li'); li.setAttribute('data-occludable-job-id', String(4385000000 + n)); li.textContent = 'card ' + n; document.getElementById('list').appendChild(li); } };
  add();
  document.getElementById('scroller').addEventListener('scroll', () => { if (n < 20) add(); });
</script>
</body></html>`;

describe.skipIf(!installed)("openPlaywrightBrowser", () => {
  const seen: Array<{ url: string; cookie: string | undefined }> = [];
  let server: http.Server;
  let origin = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", cookie: req.headers.cookie });
      if (req.url === "/go") {
        res.writeHead(302, { Location: "/login" }).end();
      } else if (req.url === "/login") {
        res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body><h1>Sign in</h1></body></html>");
      } else if (req.url === "/gone") {
        res.writeHead(404, { "Content-Type": "text/html" }).end("<html><body>gone</body></html>");
      } else if (req.url === "/pixel.png") {
        res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from("iVBORw0KGgo=", "base64"));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" }).end(LAZY_PAGE);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function options(overrides: Partial<BrowserOptions> = {}): BrowserOptions {
    const authFile = path.join(tempDir(), "li.json");
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [{ name: "li_at", value: "placeholder-not-a-secret", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
    return {
      authFile,
      headless: true,
      navigationTimeoutMs: 15_000,
      renderWaitMs: 0,
      scrollSteps: 6,
      scrollPauseMs: 50,
      locale: "en-US",
      blockResources: ["image", "font", "media"],
      userAgent: "",
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  it("sends the saved login, blocks images, reports status and the final URL, and scrolls a lazy list", { timeout: 60_000 }, async () => {
    const browser = await openPlaywrightBrowser(options());
    try {
      const scrolled = await browser.load(`${origin}/jobs/search/`, { scrollList: true });
      expect(scrolled.status).toBe(200);
      expect((scrolled.html.match(/<li data-occludable-job-id/g) ?? []).length).toBeGreaterThan(5);
      expect(seen.find((r) => r.url.startsWith("/jobs/search/"))?.cookie).toContain("li_at=placeholder-not-a-secret");
      expect(seen.some((r) => r.url === "/pixel.png")).toBe(false);

      const unscrolled = await browser.load(`${origin}/jobs/search/?start=25`, { scrollList: false });
      expect((unscrolled.html.match(/<li data-occludable-job-id/g) ?? []).length).toBe(5);

      const redirected = await browser.load(`${origin}/go`, { scrollList: false });
      expect(new URL(redirected.url).pathname).toBe("/login");
      expect(redirected.status).toBe(200);

      expect((await browser.load(`${origin}/gone`, { scrollList: false })).status).toBe(404);
    } finally {
      await browser.close();
    }
  });

  it("does not block anything it was not told to, and a page that never loads fails instead of hanging", { timeout: 60_000 }, async () => {
    const open = options({ blockResources: [], navigationTimeoutMs: 1500 });
    const browser = await openPlaywrightBrowser(open);
    try {
      await browser.load(`${origin}/jobs/search/?x=1`, { scrollList: false });
      expect(seen.some((r) => r.url === "/pixel.png")).toBe(true);
      await expect(browser.load("http://127.0.0.1:9/", { scrollList: false })).rejects.toThrow();
    } finally {
      await browser.close();
    }
  });

  it("stops when the cycle is cancelled", { timeout: 60_000 }, async () => {
    const controller = new AbortController();
    const browser = await openPlaywrightBrowser(options({ signal: controller.signal }));
    try {
      controller.abort();
      await expect(browser.load(`${origin}/jobs/search/`, { scrollList: false })).rejects.toThrow();
    } finally {
      await browser.close();
    }
  });
});
