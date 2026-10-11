// @vitest-environment node
/**
 * The connection-time address check of requests to URLs that came from data: the address the socket connects to is the
 * one that was checked (no second DNS lookup an attacker's short-TTL record could answer differently).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { createHttpClient } from "@/lib/channels/http";
import { createPublicOnlyFetch, NonPublicAddressError, publicOnlyLookup, sharedPublicOnlyFetch } from "@/lib/net/public-fetch";
import { publicUrlGuard, requestPublicUrl, type HostResolver } from "@/lib/net/public-url";

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("internal service");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const PUBLIC = "93.184.216.34";
/** A name that only the injected resolver knows (`.test` never resolves in public DNS). */
const url = () => `http://rebind.example.test:${port}/status`;

function lookupOnce(lookup: ReturnType<typeof publicOnlyLookup>, host: string, options: { all?: boolean; family?: number } = {}) {
  return new Promise<{ error: Error | null; address: unknown; family: unknown }>((resolve) => {
    lookup(host, { all: options.all ?? false, family: options.family ?? 0 }, (error, address, family) => resolve({ error, address, family }));
  });
}

describe("publicOnlyLookup", () => {
  it("answers with the resolved public addresses, in the shape net.connect asks for", async () => {
    const lookup = publicOnlyLookup(async () => [PUBLIC, "2606:2800:220:1:248:1893:25c8:1946"]);
    expect(await lookupOnce(lookup, "jobs.example.com")).toEqual({ error: null, address: PUBLIC, family: 4 });
    const all = await lookupOnce(lookup, "jobs.example.com", { all: true });
    expect(all.address).toEqual([
      { address: PUBLIC, family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect((await lookupOnce(lookup, "jobs.example.com", { family: 6 })).address).toBe("2606:2800:220:1:248:1893:25c8:1946");
  });

  it("refuses when any address is not public", async () => {
    for (const bad of [["127.0.0.1"], [PUBLIC, "172.18.0.5"], ["::1"], ["169.254.169.254"]]) {
      const result = await lookupOnce(publicOnlyLookup(async () => bad), "jobs.example.com");
      expect(result.error).toBeInstanceOf(NonPublicAddressError);
    }
    expect((await lookupOnce(publicOnlyLookup(async () => []), "jobs.example.com")).error).not.toBeNull();
  });
});

describe("createPublicOnlyFetch", () => {
  it("never connects to a name that resolves to this machine", async () => {
    hits = 0;
    const fetch = createPublicOnlyFetch({ resolve: async () => ["127.0.0.1"] });
    await expect(fetch(url(), { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it("connects to exactly the address it checked", async () => {
    hits = 0;
    // the test lets loopback pass so that the connection can be observed: the name exists only in the injected resolver
    const fetch = createPublicOnlyFetch({ resolve: async () => ["127.0.0.1"], refuse: () => false });
    const response = await fetch(url(), { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("internal service");
    expect(hits).toBe(1);
  });

  it("close() releases the pool: later requests are refused; the shared fetch is one instance", async () => {
    const fetch = createPublicOnlyFetch({ resolve: async () => ["127.0.0.1"], refuse: () => false });
    expect((await fetch(url(), { signal: AbortSignal.timeout(5000) })).status).toBe(200);
    await fetch.close();
    await expect(fetch(url(), { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(sharedPublicOnlyFetch()).toBe(sharedPublicOnlyFetch());
  });

  it("DNS rebinding: the pre-check sees a public address, the connection would get loopback, nothing is sent", async () => {
    hits = 0;
    let calls = 0;
    // first answer public (the guard), every later one loopback (what the connection would get from a short-TTL record)
    const rebinding: HostResolver = async () => (calls++ === 0 ? [PUBLIC] : ["127.0.0.1"]);
    const client = createHttpClient({ settings: { timeoutMs: 5000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch: createPublicOnlyFetch({ resolve: rebinding }) });
    await expect(requestPublicUrl(client, url(), { guard: publicUrlGuard(rebinding) })).rejects.toBeInstanceOf(ChannelError);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(hits).toBe(0);
  });
});
