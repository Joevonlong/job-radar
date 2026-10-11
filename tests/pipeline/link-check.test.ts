// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { createHttpClient, type FetchLike } from "@/lib/channels/http";
import type { HttpResponse } from "@/lib/channels/types";
import { checkLink, combineLinkStatuses } from "@/lib/pipeline/link-check";

type Step = number | "network" | { status: number; location: string };

/** Every name resolves to a public address (the .test hosts of the fixtures do not exist). */
const PUBLIC = { resolve: async () => ["93.184.216.34"] };

/** A fetch that answers per method from a script and records the calls. */
function scripted(script: { HEAD?: Step; GET?: Step }) {
  const calls: string[] = [];
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push(method);
    urls.push(url);
    const step = script[method as "HEAD" | "GET"];
    if (step === undefined || step === "network") throw new TypeError("fetch failed");
    const status = typeof step === "number" ? step : step.status;
    const location = typeof step === "number" ? null : step.location;
    const response: HttpResponse = {
      status,
      ok: status < 400,
      headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
      text: async () => "",
      json: async () => ({}),
    };
    return response;
  };
  const http = createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch, sleep: async () => {} });
  return { http, calls, urls };
}

describe("link check", () => {
  it("passes its configured timeout to every request", async () => {
    const seen: (number | undefined)[] = [];
    const http = {
      request: async (_url: string, init: { timeoutMs?: number } = {}): Promise<HttpResponse> => {
        seen.push(init.timeoutMs);
        return { status: 404, ok: false, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
      },
      json: async () => {
        throw new Error("not used");
      },
    };
    expect(await checkLink(http, "https://jobs.example.test/1", { ...PUBLIC, timeoutMs: 4321 })).toBe("gone");
    expect(seen).toEqual([4321, 4321]);
  });

  it("is alive after a successful HEAD, without a GET", async () => {
    const { http, calls } = scripted({ HEAD: 200 });
    expect(await checkLink(http, "https://jobs.example.test/1", PUBLIC)).toBe("alive");
    expect(calls).toEqual(["HEAD"]);
  });

  it("confirms a failing HEAD with a GET", async () => {
    const wrongHead = scripted({ HEAD: 405, GET: 200 });
    expect(await checkLink(wrongHead.http, "https://jobs.example.test/1", PUBLIC)).toBe("alive");
    expect(wrongHead.calls).toEqual(["HEAD", "GET"]);

    const headNetwork = scripted({ HEAD: "network", GET: 200 });
    expect(await checkLink(headNetwork.http, "https://jobs.example.test/1", PUBLIC)).toBe("alive");
  });

  it.each([404, 410])("is gone only when the GET says %d", async (status) => {
    const { http, calls } = scripted({ HEAD: status, GET: status });
    expect(await checkLink(http, "https://jobs.example.test/1", PUBLIC)).toBe("gone");
    expect(calls).toEqual(["HEAD", "GET"]);
  });

  it("does not take a 404 on HEAD alone for gone", async () => {
    expect(await checkLink(scripted({ HEAD: 404, GET: 200 }).http, "https://jobs.example.test/1", PUBLIC)).toBe("alive");
  });

  it.each([403, 429, 500, 503, 401])("proves nothing with %d", async (status) => {
    expect(await checkLink(scripted({ HEAD: status, GET: status }).http, "https://jobs.example.test/1", PUBLIC)).toBe("unknown");
  });

  it("proves nothing on network errors", async () => {
    expect(await checkLink(scripted({ HEAD: "network", GET: "network" }).http, "https://jobs.example.test/1", PUBLIC)).toBe("unknown");
  });

  it("lets cancellation through", async () => {
    const controller = new AbortController();
    controller.abort();
    const http = createHttpClient({
      settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
      signal: controller.signal,
      fetch: async () => {
        throw new ChannelError("network", "unreachable");
      },
    });
    await expect(checkLink(http, "https://jobs.example.test/1", PUBLIC)).rejects.toThrow();
  });

  it("combines the checks of a job's links", () => {
    expect(combineLinkStatuses(["gone", "alive"])).toBe("alive");
    expect(combineLinkStatuses(["gone", "gone"])).toBe("gone");
    expect(combineLinkStatuses(["gone", "unknown"])).toBe("unknown");
    expect(combineLinkStatuses([])).toBe("unknown");
  });
});

describe("link check does not reach internal addresses (blind SSRF)", () => {
  it.each([
    "http://localhost:3000/admin",
    "http://127.0.0.1:5433/",
    "http://jobspy:8000/health",
    "http://host.docker.internal:9000/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://printer.local/",
    "ftp://jobs.example.test/1",
    "file:///etc/passwd",
    "https://user:pass@jobs.example.test/1",
  ])("does not send anything to %s", async (url) => {
    const { http, calls } = scripted({ HEAD: 200, GET: 200 });
    expect(await checkLink(http, url, PUBLIC)).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("refuses a public-looking name that resolves to a private address (any of its addresses)", async () => {
    const { http, calls } = scripted({ HEAD: 200 });
    expect(await checkLink(http, "https://evil.example.test/", { resolve: async () => ["93.184.216.34", "10.1.2.3"] })).toBe("unknown");
    expect(await checkLink(http, "https://nx.example.test/", { resolve: async () => { throw new Error("ENOTFOUND"); } })).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("reports a blocked URL through onBlocked, and not an ordinary answer", async () => {
    let blocked = 0;
    const { http } = scripted({ HEAD: 200 });
    await checkLink(http, "http://10.0.0.5/", { ...PUBLIC, onBlocked: () => (blocked += 1) });
    await checkLink(http, "https://jobs.example.test/1", { ...PUBLIC, onBlocked: () => (blocked += 1) });
    expect(blocked).toBe(1);
  });

  it("asks for redirects to be handed back and checks every hop: a redirect into the LAN is not followed", async () => {
    const { http, calls, urls } = scripted({ HEAD: { status: 302, location: "http://192.168.0.10/admin" }, GET: { status: 302, location: "http://192.168.0.10/admin" } });
    expect(await checkLink(http, "https://jobs.example.test/1", PUBLIC)).toBe("unknown");
    expect(urls.every((u) => u === "https://jobs.example.test/1")).toBe(true);
    expect(calls).toEqual(["HEAD"]);
  });

  it("follows a harmless redirect (relative Location too) to a public address and judges the final answer", async () => {
    let step = 0;
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(`${init.method} ${url} ${init.redirect}`);
      step += 1;
      const status = step === 1 ? 301 : 200;
      return { status, ok: status < 400, headers: { get: (n: string) => (n.toLowerCase() === "location" ? "/moved/1" : null) }, text: async () => "", json: async () => ({}) };
    };
    const http = createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch, sleep: async () => {} });
    expect(await checkLink(http, "https://jobs.example.test/1", PUBLIC)).toBe("alive");
    expect(urls).toEqual(["HEAD https://jobs.example.test/1 manual", "HEAD https://jobs.example.test/moved/1 manual"]);
  });

  it("gives up on a redirect loop", async () => {
    const { http, calls } = scripted({ HEAD: { status: 302, location: "https://jobs.example.test/1" }, GET: { status: 302, location: "https://jobs.example.test/1" } });
    expect(await checkLink(http, "https://jobs.example.test/1", PUBLIC)).toBe("unknown");
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.length).toBeLessThanOrEqual(14);
  });
});

describe("link check: User-Agent", () => {
  it("sends the configured User-Agent on HEAD and GET", async () => {
    const agents: (string | undefined)[] = [];
    const fetch: FetchLike = async (_url, init) => {
      agents.push(init.headers?.["user-agent"]);
      const status = init.method === "HEAD" ? 405 : 200;
      return { status, ok: status < 400, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
    };
    const http = createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch, sleep: async () => {} });
    expect(await checkLink(http, "https://jobs.example.test/1", { ...PUBLIC, userAgent: "JobRadar/2 (test)" })).toBe("alive");
    expect(agents).toEqual(["JobRadar/2 (test)", "JobRadar/2 (test)"]);
  });
});

describe("link check: the GET body is not downloaded", () => {
  it("reads only a first piece of a large body and cancels the rest", async () => {
    let pulled = 0;
    let cancelled = false;
    const fetch: FetchLike = async (_url, init) => {
      const status = init.method === "HEAD" ? 405 : 200;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024).fill(97));
          if (pulled > 1000) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return { status, ok: status < 400, headers: { get: () => null }, body, text: async () => "a".repeat(64 * 1024 * 1000), json: async () => ({}) };
    };
    const http = createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch, sleep: async () => {} });
    expect(await checkLink(http, "https://jobs.example.test/1", PUBLIC)).toBe("alive");
    expect(pulled).toBeLessThan(5);
    expect(cancelled).toBe(true);
  });
});
