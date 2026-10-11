// @vitest-environment node
import { describe, expect, it } from "vitest";

import { authDecision, isPublicRoute, loginRedirectTarget, safeNextPath, type AuthInput } from "@/lib/security/auth-gate";

const base: AuthInput = { pathname: "/jobs", method: "GET", accept: "text/html", local: false, configured: true, sessionValid: false };
const decide = (extra: Partial<AuthInput>) => authDecision({ ...base, ...extra });

describe("authDecision", () => {
  it("without a password everything passes", () => {
    expect(decide({ configured: false })).toBe("pass");
    expect(decide({ configured: false, method: "POST", accept: "text/x-component" })).toBe("pass");
  });

  it("local requests and valid sessions pass", () => {
    expect(decide({ local: true })).toBe("pass");
    expect(decide({ sessionValid: true, method: "POST" })).toBe("pass");
  });

  it("a page navigation goes to the login page, everything else gets 401", () => {
    expect(decide({})).toBe("login_redirect");
    expect(decide({ method: "HEAD" })).toBe("login_redirect");
    // Server Action, API call, RSC navigation, prefetch, a file
    expect(decide({ method: "POST", accept: "text/x-component" })).toBe("unauthorized");
    expect(decide({ pathname: "/api/search", accept: "application/json" })).toBe("unauthorized");
    expect(decide({ accept: "text/x-component" })).toBe("unauthorized");
    expect(decide({ accept: "*/*" })).toBe("unauthorized");
    expect(decide({ accept: null })).toBe("unauthorized");
  });

  it("open routes are open only for their methods", () => {
    expect(decide({ pathname: "/api/health", accept: "*/*" })).toBe("pass");
    expect(decide({ pathname: "/login" })).toBe("pass");
    expect(decide({ pathname: "/api/auth/login", method: "POST", accept: "application/json" })).toBe("pass");
    // a Server Action posted to /login (Next-Action header) needs a session like any other
    expect(decide({ pathname: "/login", method: "POST", accept: "text/x-component" })).toBe("unauthorized");
    expect(decide({ pathname: "/api/health", method: "POST" })).toBe("unauthorized");
    expect(decide({ pathname: "/api/auth/login", method: "GET", accept: "application/json" })).toBe("unauthorized");
    expect(decide({ pathname: "/api/auth/logout", method: "POST" })).toBe("unauthorized");
    // encoded or decorated spellings are not the open routes
    for (const pathname of ["/%6cogin", "/login/", "/LOGIN", "/login/../settings", "/api/health/", "/api/auth/login/"]) expect(isPublicRoute(pathname, "GET") && pathname !== "/login").toBe(false);
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/jobs?view=table", "/jobs?view=table"],
    ["/", "/"],
    ["/jobs/12#notes", "/jobs/12#notes"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
    ["jobs", "/"],
    ["/login", "/"],
    ["/login?next=/x", "/"],
    ["/api/control/requests", "/"],
    ["/api", "/"],
    ["/jobs\u0000", "/"],
    ["/x\ny", "/"],
    ["", "/"],
    [null, "/"],
  ])("%s -> %s", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });

  it("the redirect target keeps path and query, encoded", () => {
    expect(loginRedirectTarget("/jobs", "?view=table&x=1")).toBe("/login?next=%2Fjobs%3Fview%3Dtable%26x%3D1");
    expect(loginRedirectTarget("/", "")).toBe("/login");
    expect(loginRedirectTarget("/api/x", "")).toBe("/login");
  });
});
