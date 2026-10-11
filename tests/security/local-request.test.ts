// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isLocalRequest, isLoopbackAddress, isLoopbackBind, isPrivateAddress, localExemption, localExemptionEnabled, PROXY_HEADERS, webListensOnLoopback } from "@/lib/security/local-request";

const headers = (values: Record<string, string>) => new Headers(values);
/** What compose passes to the web container. */
const COMPOSE_ENV = { JOB_RADAR_WEB_BIND: "127.0.0.1" };
/** `pnpm start` / `next dev` outside compose: the variable is absent. */
const NO_BIND: Record<string, string | undefined> = {};

describe("isLocalRequest", () => {
  it.each([
    ["127.0.0.1:3000", true],
    ["localhost:3000", true],
    ["LOCALHOST", true],
    ["[::1]:3000", true],
    ["box.example-tailnet.ts.net", false],
    ["192.168.1.20:3000", false],
    ["127.0.0.2:3000", false],
    ["localhost.evil.example", false],
    ["", false],
  ])("Host %s -> %s", (host, local) => {
    expect(isLocalRequest(headers(host === "" ? {} : { host }))).toBe(local);
  });

  it("a request without a Host header is not local", () => {
    expect(isLocalRequest(headers({}))).toBe(false);
  });

  it.each(PROXY_HEADERS)("any proxy trace (%s) makes it non-local", (name) => {
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", [name]: "x" }))).toBe(false);
  });

  it("tailscale serve: ts.net host plus forwarding headers", () => {
    expect(isLocalRequest(headers({ host: "box.example-tailnet.ts.net", "x-forwarded-for": "100.64.0.2", "tailscale-user-login": "me@example.com" }))).toBe(false);
  });

  it("the forwarding headers Next fills in itself for a direct request keep it local (plain, and from inside Docker)", () => {
    const next = { "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-port": "3000", "x-forwarded-proto": "http" };
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", ...next, "x-forwarded-for": "127.0.0.1" }))).toBe(true);
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-host": "localhost:3000", "x-forwarded-for": "::ffff:127.0.0.1" }))).toBe(true);
    // Docker Desktop / the bridge network (compose sets JOB_RADAR_WEB_BIND): the peer is the gateway
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", ...next, "x-forwarded-for": "172.18.0.1" }), COMPOSE_ENV)).toBe(true);
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", ...next, "x-forwarded-for": "192.168.65.1" }), COMPOSE_ENV)).toBe(true);
  });

  it("without JOB_RADAR_WEB_BIND (pnpm start, next dev) only loopback peers count", () => {
    const next = { "x-forwarded-host": "localhost:3000", "x-forwarded-port": "3000", "x-forwarded-proto": "http" };
    // a LAN machine reaching a server that listens on every interface, with a forged Host: localhost
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "192.168.1.50" }), NO_BIND)).toBe(false);
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "10.0.0.7" }), NO_BIND)).toBe(false);
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "::ffff:192.168.1.50" }), NO_BIND)).toBe(false);
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "fe80::1%en0" }), NO_BIND)).toBe(false);
    expect(localExemption(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "192.168.1.50" }), NO_BIND)).toBe(false);
    // the same machine still is
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "127.0.0.1" }), NO_BIND)).toBe(true);
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "::1" }), NO_BIND)).toBe(true);
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "::ffff:127.0.0.1" }), NO_BIND)).toBe(true);
    // with the variable present (compose), the same LAN-range peer is taken for the Docker gateway
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "192.168.1.50" }), COMPOSE_ENV)).toBe(true);
    // an empty value (a blank line in .env) counts as absent; compose never passes an empty one
    expect(isLocalRequest(headers({ host: "localhost:3000", ...next, "x-forwarded-for": "172.18.0.1" }), { JOB_RADAR_WEB_BIND: " " })).toBe(false);
  });

  it.each([
    ["127.0.0.1", true],
    ["127.9.9.9", true],
    ["::1", true],
    ["[::1]", true],
    ["::ffff:127.0.0.1", true],
    ["0:0:0:0:0:ffff:127.0.0.1", true],
    ["10.0.0.1", false],
    ["192.168.1.50", false],
    ["::ffff:192.168.1.50", false],
    ["fe80::1", false],
    ["", false],
  ])("isLoopbackAddress(%s) -> %s", (value, expected) => {
    expect(isLoopbackAddress(value)).toBe(expected);
  });

  it("a client address from a proxy in front makes it non-local, even with Host: localhost", () => {
    // tailscale serve: the tailnet client (100.64/10)
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-for": "100.64.0.2" }))).toBe(false);
    // a proxy appends the client to a forged loopback entry
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1, 100.101.102.103" }))).toBe(false);
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-for": "203.0.113.9" }))).toBe(false);
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-for": "" }))).toBe(false);
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-for": "garbage" }))).toBe(false);
    // TLS ended in a proxy
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-proto": "https" }))).toBe(false);
  });

  it.each([
    ["127.0.0.1", true],
    ["127.9.9.9", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.65.1", true],
    ["169.254.1.1", true],
    ["::1", true],
    ["[::1]", true],
    ["::ffff:172.18.0.1", true],
    ["0:0:0:0:0:ffff:10.0.0.1", true],
    ["fd12:3456::1", true],
    ["fe80::1%eth0", true],
    ["100.64.0.2", false],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["::ffff:100.64.0.2", false],
    ["fc:1::1", false],
    ["2001:db8::1", false],
    ["fd7a:115c:a1e0::1", false],
    ["256.1.1.1", false],
    ["", false],
  ])("isPrivateAddress(%s) -> %s", (value, expected) => {
    expect(isPrivateAddress(value)).toBe(expected);
  });

  it("X-Forwarded-Host must name this machine too", () => {
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-host": "localhost:3000" }))).toBe(true);
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-host": "jobs.example.com" }))).toBe(false);
    expect(isLocalRequest(headers({ host: "127.0.0.1:3000", "x-forwarded-host": "localhost, jobs.example.com" }))).toBe(false);
  });
});

describe("bind address and the local exemption", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["localhost", true],
    ["::1", true],
    ["0.0.0.0", false],
    ["192.168.1.20", false],
    ["127.0.0.300", false],
    ["garbage", false],
  ])("bind %s is loopback: %s", (bind, loopback) => {
    expect(isLoopbackBind(bind)).toBe(loopback);
  });

  it("a forged Host: localhost is not exempt when the web listens beyond loopback", () => {
    const forged = headers({ host: "localhost:3000" });
    expect(localExemption(forged, COMPOSE_ENV)).toBe(true);
    expect(localExemption(forged, { JOB_RADAR_WEB_BIND: "0.0.0.0" })).toBe(false);
    expect(localExemption(forged, { JOB_RADAR_WEB_BIND: "192.168.1.20" })).toBe(false);
  });

  it("without JOB_RADAR_WEB_BIND the listen address is unknown: no exemption, whatever the headers claim", () => {
    // a LAN machine reaching `next start` (every interface) with a forged Host and a forged loopback X-Forwarded-For:
    // Next keeps a client-supplied X-Forwarded-For, so the headers look exactly like a request from this machine
    const spoofed = headers({ host: "localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http", "x-forwarded-port": "3000" });
    expect(isLocalRequest(spoofed, NO_BIND)).toBe(true);
    expect(localExemptionEnabled(NO_BIND)).toBe(false);
    expect(localExemption(spoofed, NO_BIND)).toBe(false);
    expect(localExemption(spoofed, { JOB_RADAR_WEB_BIND: "" })).toBe(false);
    expect(localExemption(spoofed, { JOB_RADAR_WEB_BIND: "  " })).toBe(false);
    // the bind is known to be loopback (compose, or pnpm start / pnpm dev listening on it): nobody else can connect
    expect(localExemption(spoofed, COMPOSE_ENV)).toBe(true);
    expect(localExemption(spoofed, { JOB_RADAR_WEB_BIND: "::1" })).toBe(true);
  });

  it("webListensOnLoopback needs an explicit loopback value", () => {
    expect(webListensOnLoopback({})).toBe(false);
    expect(webListensOnLoopback({ JOB_RADAR_WEB_BIND: "" })).toBe(false);
    expect(webListensOnLoopback({ JOB_RADAR_WEB_BIND: "127.0.0.1" })).toBe(true);
    expect(webListensOnLoopback({ JOB_RADAR_WEB_BIND: "localhost" })).toBe(true);
    expect(webListensOnLoopback({ JOB_RADAR_WEB_BIND: "0.0.0.0" })).toBe(false);
  });

  it("JOB_RADAR_WEB_LOCAL_LOGIN=1 switches the exemption off", () => {
    expect(localExemptionEnabled({ ...COMPOSE_ENV, JOB_RADAR_WEB_LOCAL_LOGIN: "1" })).toBe(false);
    expect(localExemptionEnabled({ ...COMPOSE_ENV, JOB_RADAR_WEB_LOCAL_LOGIN: "0" })).toBe(true);
    expect(localExemption(headers({ host: "127.0.0.1:3000" }), { ...COMPOSE_ENV, JOB_RADAR_WEB_LOCAL_LOGIN: "1" })).toBe(false);
  });
});
