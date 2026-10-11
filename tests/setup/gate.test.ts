// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { setupRedirect, shouldRunScheduled } from "@/lib/setup/gate";
import { createSetupGate } from "@/lib/setup/runner-gate";
import { firstOpenStep, nextStepOf, previousStepOf, SETUP_STEP_IDS } from "@/lib/setup/steps";

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const page = (pathname: string, extra: Partial<Parameters<typeof setupRedirect>[0]> = {}) => setupRedirect({ method: "GET", pathname, accept: HTML, pending: true, ...extra });

describe("setupRedirect", () => {
  it("sends a page navigation to the first open step while the setup is pending", () => {
    expect(page("/")).toBe("/setup?step=language");
    expect(page("/jobs/12")).toBe("/setup?step=language");
    expect(page("/settings", { steps: { language: { status: "done" }, market: { status: "skipped" } } })).toBe("/setup?step=profile");
    expect(page("/", { method: "HEAD" })).toBe("/setup?step=language");
  });

  it("redirects client-side navigations (RSC payloads) and clients without an Accept header", () => {
    expect(page("/insights", { accept: "text/x-component" })).toBe("/setup?step=language");
    expect(page("/insights", { accept: null })).toBe("/setup?step=language");
    expect(page("/insights", { accept: "*/*" })).toBe("/setup?step=language");
  });

  it("never redirects once the setup is complete", () => {
    expect(page("/", { pending: false })).toBeNull();
  });

  it.each([
    ["the wizard itself", "/setup"],
    ["a wizard sub path", "/setup/anything"],
    ["the API", "/api/health"],
    ["the API root", "/api"],
    ["Next's assets", "/_next/static/chunks/app.js"],
    ["a file", "/favicon.ico"],
    ["a file in a folder", "/fonts/archivo.woff2"],
  ])("passes %s through", (_name, pathname) => {
    expect(page(pathname)).toBeNull();
  });

  it("passes Server Actions (POST) and other methods through", () => {
    expect(page("/", { method: "POST" })).toBeNull();
    expect(page("/me", { method: "PUT" })).toBeNull();
  });

  it("passes requests that do not ask for a page through", () => {
    expect(page("/", { accept: "application/json" })).toBeNull();
    expect(page("/", { accept: "image/avif,image/webp" })).toBeNull();
  });

  it("does not treat a path that only starts with the same letters as the wizard", () => {
    expect(page("/setupx")).toBe("/setup?step=language");
  });
});

describe("shouldRunScheduled", () => {
  it.each(["scheduled", "catchup", "suggest"] as const)("holds back %s while pending, runs it once complete", (work) => {
    expect(shouldRunScheduled(work, { pending: true })).toBe(false);
    expect(shouldRunScheduled(work, { pending: false })).toBe(true);
  });

  it("always runs manual requests", () => {
    expect(shouldRunScheduled("manual", { pending: true })).toBe(true);
  });
});

describe("the runner's setup gate", () => {
  it("logs one line per held-back trigger and reads the state at every trigger", () => {
    const log = vi.fn();
    let pending = true;
    const allows = createSetupGate(log, () => ({ pending }));
    expect(allows("scheduled", "the scheduled weekday_morning cycle")).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/^setup not completed: skipping the scheduled weekday_morning cycle/);
    pending = false;
    expect(allows("scheduled", "the scheduled weekday_evening cycle")).toBe(true);
    expect(allows("catchup", "the start-up catch-up")).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("step order", () => {
  it("has eight steps from language to review", () => {
    expect(SETUP_STEP_IDS).toEqual(["language", "market", "profile", "targets", "sources", "ai", "telegram", "review"]);
    expect(nextStepOf("language")).toBe("market");
    expect(nextStepOf("review")).toBeNull();
    expect(previousStepOf("language")).toBeNull();
    expect(previousStepOf("review")).toBe("telegram");
  });

  it("firstOpenStep skips done and skipped steps", () => {
    expect(firstOpenStep({})).toBe("language");
    expect(firstOpenStep({ language: { status: "done" }, market: { status: "done" }, profile: { status: "skipped" } })).toBe("targets");
    expect(firstOpenStep(Object.fromEntries(SETUP_STEP_IDS.map((id) => [id, { status: "done" as const }])))).toBe("review");
  });
});
