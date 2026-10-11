// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildAllowlist, checkRequestHosts, isAllowedHost, parseHostEntry, parseHostList, refusalMessage, serverActionOrigins, splitHostPort, type Allowlist } from "@/lib/security/host-allowlist";

const defaults = buildAllowlist();

function check(headers: { host?: string | null; forwardedHost?: string | null; origin?: string | null; method?: string }, allowlist: Allowlist = defaults) {
  return checkRequestHosts({ method: headers.method ?? "GET", host: headers.host ?? null, forwardedHost: headers.forwardedHost ?? null, origin: headers.origin ?? null }, allowlist);
}

describe("splitHostPort", () => {
  it("splits names, ports and bracketed IPv6", () => {
    expect(splitHostPort("LocalHost:3000")).toEqual({ host: "localhost", port: "3000" });
    expect(splitHostPort("[::1]:3100")).toEqual({ host: "[::1]", port: "3100" });
    expect(splitHostPort("box.example-tailnet.ts.net.")).toEqual({ host: "box.example-tailnet.ts.net", port: null });
    expect(splitHostPort("box.example-tailnet.ts.net.:443")).toEqual({ host: "box.example-tailnet.ts.net", port: "443" });
    expect(splitHostPort("[0:0:0:0:0:0:0:1]")).toEqual({ host: "[0:0:0:0:0:0:0:1]", port: null });
  });

  it("refuses what is not a host", () => {
    for (const bad of ["", "a b", "evil.example/x", "user@host", "::1", "[::1", "[::1]x", "host:port", "host:1:2", "[]"]) expect(splitHostPort(bad)).toBeNull();
  });
});

describe("parseHostEntry / parseHostList", () => {
  it("accepts names, wildcards, ports and tolerates a scheme and path", () => {
    expect(parseHostEntry("jobs.example.com")).toEqual({ host: "jobs.example.com", wildcard: false, port: null });
    expect(parseHostEntry("*.example.com")).toEqual({ host: "example.com", wildcard: true, port: null });
    expect(parseHostEntry("https://jobs.example.com:8443/radar")).toEqual({ host: "jobs.example.com", wildcard: false, port: "8443" });
    expect(parseHostEntry("192.168.1.20")).toEqual({ host: "192.168.1.20", wildcard: false, port: null });
    expect(parseHostEntry("[fd7a:115c:a1e0::1]:3000")).toEqual({ host: "[fd7a:115c:a1e0::1]", wildcard: false, port: "3000" });
  });

  it("refuses a wildcard over a single label or an IPv6 address", () => {
    expect(parseHostEntry("*.com")).toBeNull();
    expect(parseHostEntry("*.net.")).toBeNull();
    expect(parseHostEntry("*.[::1]")).toBeNull();
    expect(parseHostEntry("*.ts.net")).not.toBeNull();
  });

  it("drops empty and invalid entries", () => {
    expect(parseHostList(" a.example , ,bad host,*.b.example,*.com ")).toEqual([
      { host: "a.example", wildcard: false, port: null },
      { host: "b.example", wildcard: true, port: null },
    ]);
    expect(parseHostList(undefined)).toEqual([]);
  });
});

describe("isAllowedHost", () => {
  it("allows the loopback names on any port and Tailscale names", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:3100", "[::1]:3105", "box.example-tailnet.ts.net", "box.example-tailnet.ts.net:443", "box.example-tailnet.ts.net.:443"]) expect(isAllowedHost(host, defaults.hosts)).toBe(true);
  });

  it("refuses other names, including look-alikes and other IP forms", () => {
    for (const host of ["evil.example", "evil.example:3000", "localhost.evil.example", "127.0.0.1.evil.example", "ts.net", "evilts.net", "192.168.1.10:3000", "127.1", "2130706433", "0x7f000001", "[::ffff:127.0.0.1]", "127.0.0.2"]) {
      expect(isAllowedHost(host, defaults.hosts), host).toBe(false);
    }
  });

  it("honours a port in an entry; IP literals are matched as written", () => {
    const allowlist = buildAllowlist("jobs.example.com:8443,192.168.1.20,[fd7a::1]");
    expect(isAllowedHost("jobs.example.com:8443", allowlist.hosts)).toBe(true);
    expect(isAllowedHost("jobs.example.com", allowlist.hosts)).toBe(false);
    expect(isAllowedHost("192.168.1.20:3000", allowlist.hosts)).toBe(true);
    expect(isAllowedHost("[fd7a::1]:3000", allowlist.hosts)).toBe(true);
  });
});

describe("checkRequestHosts", () => {
  it("lets the dashboard's own requests through", () => {
    expect(check({ host: "127.0.0.1:3000" })).toEqual({ ok: true });
    expect(check({ host: "127.0.0.1:3000", forwardedHost: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", method: "POST" })).toEqual({ ok: true });
    expect(check({ host: "box.example-tailnet.ts.net", origin: "https://box.example-tailnet.ts.net", method: "POST" })).toEqual({ ok: true });
    expect(check({ host: "box.example-tailnet.ts.net.", origin: "https://box.example-tailnet.ts.net", method: "POST" })).toEqual({ ok: true });
  });

  it("refuses a rebound name in Host (the DNS rebinding case)", () => {
    expect(check({ host: "x.evil.example:3000", origin: "http://x.evil.example:3000", method: "POST" })).toEqual({ ok: false, header: "host", value: "x.evil.example:3000" });
  });

  it("refuses a missing Host", () => {
    expect(check({ host: null }).ok).toBe(false);
  });

  it("refuses a foreign X-Forwarded-Host (Next compares Server Action origins with it)", () => {
    expect(check({ host: "127.0.0.1:3000", forwardedHost: "evil.example", origin: "http://evil.example", method: "POST" })).toEqual({ ok: false, header: "x-forwarded-host", value: "evil.example" });
    expect(check({ host: "127.0.0.1:3000", forwardedHost: "127.0.0.1:3000, evil.example" }).ok).toBe(false);
  });

  it("refuses a foreign or broken Origin", () => {
    expect(check({ host: "127.0.0.1:3000", origin: "https://evil.example", method: "POST" })).toEqual({ ok: false, header: "origin", value: "https://evil.example" });
    expect(check({ host: "127.0.0.1:3000", origin: "not a url" }).ok).toBe(false);
  });

  it("refuses a state-changing request from another allowed host (cross-site CSRF)", () => {
    expect(check({ host: "localhost:3000", origin: "https://evil.example-other.ts.net", method: "POST" })).toEqual({ ok: false, header: "origin", value: "https://evil.example-other.ts.net" });
    expect(check({ host: "localhost:3000", origin: "http://localhost:5173", method: "POST" }).ok).toBe(false);
    expect(check({ host: "127.0.0.1:3000", origin: "http://localhost:3000", method: "POST" }).ok).toBe(false);
    // reading is not state-changing (and CORS keeps the answer from the other site)
    expect(check({ host: "localhost:3000", origin: "http://localhost:5173", method: "GET" }).ok).toBe(true);
  });

  it("compares a state-changing request's origin with the first X-Forwarded-Host entry", () => {
    const allowlist = buildAllowlist("jobs.example.com");
    expect(check({ host: "127.0.0.1:3000", forwardedHost: "box.example-tailnet.ts.net", origin: "https://box.example-tailnet.ts.net", method: "POST" })).toEqual({ ok: true });
    expect(check({ host: "box.example-tailnet.ts.net", forwardedHost: "127.0.0.1:3000", origin: "https://box.example-tailnet.ts.net", method: "POST" }, allowlist).ok).toBe(false);
  });

  it("refuses Origin: null for a state-changing request only", () => {
    expect(check({ host: "127.0.0.1:3000", origin: "null", method: "GET" }).ok).toBe(true);
    expect(check({ host: "127.0.0.1:3000", origin: "null", method: "POST" }).ok).toBe(false);
  });

  it("allows a reverse proxy's name once it is configured, also as a different origin", () => {
    const allowlist = buildAllowlist("jobs.example.com");
    expect(check({ host: "127.0.0.1:3000", forwardedHost: "jobs.example.com", origin: "https://jobs.example.com", method: "POST" }, allowlist)).toEqual({ ok: true });
    // a proxy that rewrites the host without X-Forwarded-Host: the origin is listed explicitly
    expect(check({ host: "127.0.0.1:3000", origin: "https://jobs.example.com", method: "POST" }, allowlist)).toEqual({ ok: true });
    expect(check({ host: "127.0.0.1:3000", forwardedHost: "jobs.example.com" }).ok).toBe(false);
  });
});

describe("refusalMessage", () => {
  it("names the header, the variable to set, and never echoes control characters", () => {
    const message = refusalMessage({ ok: false, header: "host", value: "evil.example\u0000\n" });
    expect(message).toContain('Host "evil.example??"');
    expect(message).toContain("JOB_RADAR_ALLOWED_HOSTS");
    expect(message).not.toContain("public_base_url");
  });
});

describe("serverActionOrigins", () => {
  it("lists only the explicitly configured names, in Next's pattern syntax", () => {
    expect(serverActionOrigins(undefined)).toEqual([]);
    expect(serverActionOrigins("jobs.example.com, *.corp.example, proxy.example:8443")).toEqual(["jobs.example.com", "**.corp.example", "proxy.example:8443"]);
  });
});
