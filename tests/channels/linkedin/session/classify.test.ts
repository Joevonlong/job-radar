// @vitest-environment node
import { describe, expect, it } from "vitest";

import { classifyPage } from "@/lib/channels/linkedin/session/classify";

import { fixture } from "./helpers";

const page = (html: string, extra: { status?: number | null; url?: string } = {}) => classifyPage({ status: extra.status === undefined ? 200 : extra.status, url: extra.url ?? "https://www.linkedin.com/jobs/search/?keywords=x", html });

describe("classifyPage: content", () => {
  it.each(["search-results.html", "search-results-empty.html", "recommended.html", "job-detail.html", "job-detail-de.html", "job-detail-jsonld-only.html", "job-detail-closed.html", "layout-unknown.html"])("%s is a normal page", (name) => {
    expect(page(fixture(name))).toEqual({ kind: "ok" });
  });

  it("does not mistake a job description that talks about security checks for a verification page", () => {
    const html = fixture("job-detail.html").replace("Build the perception stack", "Pass a quick security check and a captcha review, then build the perception stack");
    expect(page(html)).toEqual({ kind: "ok" });
  });
});

describe("classifyPage: pages that mean stop", () => {
  it("recognises the sign-in page (by its form) as a lost login", () => {
    expect(page(fixture("login-wall.html"))).toMatchObject({ kind: "login_required" });
  });

  it("recognises the auth wall", () => {
    expect(page(fixture("authwall.html"))).toMatchObject({ kind: "login_required" });
  });

  it("recognises a verification page (CAPTCHA / quick security check)", () => {
    expect(page(fixture("checkpoint.html"))).toMatchObject({ kind: "checkpoint" });
  });

  it("goes by the URL first: a redirect to a login or checkpoint path is decisive, whatever the page says", () => {
    expect(page(fixture("search-results.html"), { url: "https://www.linkedin.com/checkpoint/challenge/AgE?x=1" })).toMatchObject({ kind: "checkpoint" });
    expect(page(fixture("search-results.html"), { url: "https://www.linkedin.com/uas/captcha" })).toMatchObject({ kind: "checkpoint" });
    expect(page("", { url: "https://www.linkedin.com/login?session_redirect=x" })).toMatchObject({ kind: "login_required" });
    expect(page("", { url: "https://www.linkedin.com/authwall?trk=x" })).toMatchObject({ kind: "login_required" });
    expect(page("", { url: "https://www.linkedin.com/uas/login" })).toMatchObject({ kind: "login_required" });
  });

  it("reads German verification text", () => {
    expect(page("<html><body><h1>Kurze Sicherheitsüberprüfung</h1><p>Bitte bestätigen.</p></body></html>")).toMatchObject({ kind: "checkpoint" });
  });

  it("treats LinkedIn's denial statuses as denied", () => {
    expect(page("", { status: 999 })).toEqual({ kind: "denied", status: 999 });
    expect(page("", { status: 429 })).toEqual({ kind: "denied", status: 429 });
    expect(page("", { status: 403 })).toEqual({ kind: "denied", status: 403 });
    expect(page("", { status: 401 })).toMatchObject({ kind: "login_required" });
  });

  it("tells a vanished job from the walls", () => {
    expect(page(fixture("job-unavailable.html"))).toEqual({ kind: "unavailable" });
    expect(page(fixture("job-unavailable.html"), { status: 404 })).toEqual({ kind: "unavailable" });
  });
});
