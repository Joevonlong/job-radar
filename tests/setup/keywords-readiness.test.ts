// @vitest-environment node
import { describe, expect, it } from "vitest";

import { cleanTitles, planKeywordGroups } from "@/lib/setup/keywords";
import { buildReadiness, readinessParams } from "@/lib/setup/readiness";
import { localeFromAcceptLanguage } from "@/lib/setup/steps/language";

const SHIPPED = { engineering: ["AI Engineer", "ML Engineer"], solutions: ["Solutions Engineer"] };

describe("keyword groups from the target titles", () => {
  it("replaces the groups as a whole while they are still the shipped default", () => {
    const plan = planKeywordGroups({ engineering: ["AI Engineer", "ML Engineer"], solutions: ["Solutions Engineer"] }, SHIPPED, ["Data Engineer", " Analyst "]);
    expect(plan).toEqual({ mode: "replace", groups: { targets: ["Data Engineer", "Analyst"] } });
  });

  it("keeps groups the user changed and only adds the targets group", () => {
    const plan = planKeywordGroups({ engineering: ["AI Engineer"], mine: ["Platform Engineer"] }, SHIPPED, ["Data Engineer"]);
    expect(plan).toEqual({ mode: "merge", groups: { engineering: ["AI Engineer"], mine: ["Platform Engineer"], targets: ["Data Engineer"] } });
  });

  it("replaces an existing targets group in place", () => {
    const plan = planKeywordGroups({ mine: ["Platform Engineer"], targets: ["Old Title"] }, SHIPPED, ["New Title"]);
    expect(plan.mode).toBe("merge");
    expect(Object.keys(plan.groups)).toEqual(["mine", "targets"]);
    expect(plan.groups.targets).toEqual(["New Title"]);
  });

  it("changes nothing without titles, and never replaces when the default is unknown", () => {
    expect(planKeywordGroups(SHIPPED, SHIPPED, ["  ", ""])).toEqual({ mode: "none", groups: SHIPPED });
    expect(planKeywordGroups(SHIPPED, null, ["Data Engineer"]).mode).toBe("merge");
  });

  it("cleans titles: trimmed, no empties, no case-insensitive duplicates", () => {
    expect(cleanTitles([" A ", "", "a", "B", "b ", "C"])).toEqual(["A", "B", "C"]);
  });
});

describe("readiness", () => {
  const ok = { profileMissing: [], channels: { enabled: ["indeed"], missingEnv: [] }, ai: { enabled: ["codex-cli"], missingKey: [] }, runnerOnline: true, aiWorker: "online" as const };

  it("is all ok when everything is there", () => {
    expect(buildReadiness(ok).map((i) => i.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("names what is missing", () => {
    const items = buildReadiness({ ...ok, profileMissing: ["summary", "skills"], channels: { enabled: ["indeed", "jsearch"], missingEnv: ["jsearch"] }, ai: { enabled: ["anthropic"], missingKey: ["anthropic"] }, runnerOnline: false, aiWorker: "offline" });
    expect(items.find((i) => i.id === "profile")).toMatchObject({ status: "warn", fields: ["summary", "skills"] });
    const profile = items.find((i) => i.id === "profile")!;
    expect(readinessParams(profile, (field) => `<${field}>`, "、").fields).toBe("<summary>、<skills>");
    expect(items.find((i) => i.id === "channels")).toMatchObject({ status: "warn", params: { count: 1, missing: "jsearch" } });
    expect(items.find((i) => i.id === "ai")).toMatchObject({ status: "fail", params: { state: "noKey", on: 1, count: 0, missing: "anthropic" } });
    expect(items.find((i) => i.id === "runner")?.status).toBe("fail");
    expect(items.find((i) => i.id === "aiWorker")?.status).toBe("warn");
  });

  it("fails without any usable channel, and warns when the database cannot be read", () => {
    const items = buildReadiness({ ...ok, channels: { enabled: [], missingEnv: [] }, runnerOnline: null, aiWorker: null, profileMissing: null });
    expect(items.find((i) => i.id === "channels")?.status).toBe("fail");
    expect(items.find((i) => i.id === "runner")).toMatchObject({ status: "warn", params: { state: "unknown" } });
    expect(items.find((i) => i.id === "profile")?.status).toBe("fail");
  });

  it("counts the AI providers that are on apart from the ones that can run", () => {
    const some = buildReadiness({ ...ok, ai: { enabled: ["codex-cli", "claude-cli", "anthropic"], missingKey: ["anthropic"] } }).find((i) => i.id === "ai");
    expect(some).toMatchObject({ status: "warn", params: { state: "someMissing", on: 3, count: 2, missing: "anthropic" } });
    expect(buildReadiness({ ...ok, ai: { enabled: [], missingKey: [] } }).find((i) => i.id === "ai")).toMatchObject({ status: "fail", params: { state: "none", on: 0 } });
  });

  it("does not need an ai-worker when AI runs in the container", () => {
    expect(buildReadiness({ ...ok, aiWorker: "notNeeded" }).find((i) => i.id === "aiWorker")?.status).toBe("ok");
  });
});

describe("interface language from Accept-Language", () => {
  it.each([
    ["en-US,en;q=0.9,zh;q=0.8", "en"],
    ["zh-CN,zh;q=0.9", "zh"],
    ["de-DE,de;q=0.9,en;q=0.5", "en"],
    ["fr;q=0.2, zh-TW;q=0.7", "zh"],
    ["de", null],
    [null, null],
  ])("%s -> %s", (header, expected) => {
    expect(localeFromAcceptLanguage(header)).toBe(expected);
  });
});
