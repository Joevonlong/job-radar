// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import type { BreakdownContent } from "@/lib/breakdown/content";
import { buildBreakdownView } from "@/lib/breakdown/view";
import { buildSkillAliasMap } from "@/lib/dashboard/skills";
import type { JobBreakdownRow } from "@/lib/db/repos/breakdowns";
import { descriptionHash } from "@/lib/translation/hash";

import { shippedCatalog } from "../ai/helpers";
import { JD } from "./helpers";

const STACK = "Our stack: Python, Kubernetes and AWS. Nice to have: Terraform.";
const loc = (quote: string) => ({ quote, offset: JD.indexOf(quote) });
const tech = (name: string, category: BreakdownContent["tech_stack"][number]["category"], requirement: "must" | "nice") => ({ name, category, requirement, ...loc(STACK) });

const content = (over: Partial<BreakdownContent> = {}): BreakdownContent => ({
  responsibilities: [{ text: "构建检索管线", ...loc("Build and operate retrieval pipelines in production.") }],
    tech_stack: [tech("Terraform", "cloud_infra", "nice"), tech("Kubernetes", "cloud_infra", "must"), tech("Python", "languages", "must"), tech("AWS", "cloud_infra", "must")],
    experience: { years_min: 5, years_quote: loc("You have 5+ years of experience in software engineering."), items: [] },
    projects: [],
    soft_skills: [{ text: "文档", requirement: "must", ...loc("Write clear documentation.") }],
    languages: [{ language: "English", level: "C1", requirement: "must", ...loc("Fluent English is required.") }],
    other: [],
    ...over,
});

const row = (c: BreakdownContent, over: Partial<JobBreakdownRow> = {}): JobBreakdownRow => ({
  jobId: 1,
  sourceHash: descriptionHash(JD),
  promptVersion: BREAKDOWN_PROMPT_VERSION,
  outputLang: "zh",
  provider: "codex-cli",
  model: "gpt-5.5",
  content: c,
  droppedItems: 0,
  analyzedAt: new Date("2026-10-08T12:02:00Z"),
  ...over,
});

const aliases = buildSkillAliasMap([{ name: "Kubernetes", aliases: ["k8s"] }]);
const input = (over: Partial<Parameters<typeof buildBreakdownView>[0]> = {}) => ({
  row: row(content()),
  description: JD,
  signalQuotes: [] as string[],
  profileSkills: ["Python", "k8s"],
  profileYears: 6,
  aliases,
  ...over,
});

describe("buildBreakdownView", () => {
  it("is null without a row", () => {
    expect(buildBreakdownView(input({ row: null }))).toEqual({ view: null, extraQuotes: [] });
  });

  it("groups the tech stack in the fixed category order, must before nice, empty groups left out", () => {
    const { view } = buildBreakdownView(input());
    expect(view?.content?.techGroups.map((g) => g.category)).toEqual(["languages", "cloud_infra"]);
    expect(view?.content?.techGroups[1]?.items.map((t) => t.name)).toEqual(["Kubernetes", "AWS", "Terraform"]);
  });

  it("compares with the profile through aliases, counts must / nice and lists what is missing, must first", () => {
    const { view } = buildBreakdownView(input());
    expect(view?.match).toMatchObject({ state: "ok", must: { have: 2, total: 3 }, nice: { have: 0, total: 1 } });
    if (view?.match.state !== "ok") throw new Error("expected a match");
    expect(view.match.missing.map((t) => t.name)).toEqual(["AWS", "Terraform"]);
    const kube = view.content?.techGroups[1]?.items.find((t) => t.name === "Kubernetes");
    expect(kube?.have).toBe(true);
  });

  it("has no match without profile skills, and every have is null", () => {
    const { view } = buildBreakdownView(input({ profileSkills: [] }));
    expect(view?.match).toEqual({ state: "none" });
    expect(view?.content?.techGroups.flatMap((g) => g.items).every((t) => t.have === null)).toBe(true);
  });

  it("compares the years: met, not met, profile without years", () => {
    const years = (profileYears: number | null) => {
      const match = buildBreakdownView(input({ profileYears })).view?.match;
      return match?.state === "ok" ? match.years : "none";
    };
    expect(years(6)).toEqual({ required: 5, mine: 6, ok: true });
    expect(years(3)).toEqual({ required: 5, mine: 3, ok: false });
    expect(years(null)).toEqual({ required: 5, mine: null, ok: null });
  });

  it("marks staleness: another JD, another prompt version", () => {
    expect(buildBreakdownView(input({ description: `${JD} changed` })).view?.stale).toEqual({ jd: true, prompt: false, lang: false });
    // Written in another language than ai.output now says (same primary language counts as the same)
    expect(buildBreakdownView(input({ outputLang: "en" })).view?.stale).toEqual({ jd: false, prompt: false, lang: true });
    expect(buildBreakdownView(input({ outputLang: "zh-CN" })).view?.stale.lang).toBe(false);
    expect(buildBreakdownView(input({ row: row(content(), { promptVersion: "breakdown-v0" }) })).view).toMatchObject({ stale: { jd: false, prompt: true }, content: null });
  });

  it("gives a quote equal to a signal quote the signal's index, appends the others once each", () => {
    const { view, extraQuotes } = buildBreakdownView(input({ signalQuotes: ["Write clear documentation."] }));
    expect(view?.content?.softSkills[0]?.quoteIndex).toBe(0);
    // STACK is shared by four tech items: one extra quote, one index
    expect(extraQuotes.filter((q) => q === STACK)).toHaveLength(1);
    const indexes = view?.content?.techGroups.flatMap((g) => g.items.map((t) => t.quoteIndex));
    expect(new Set(indexes).size).toBe(1);
    expect(indexes?.[0]).toBe(1 + extraQuotes.indexOf(STACK));
  });

  it("a quote that spans lines has no highlight to jump to", () => {
    const multi = "retrieval pipelines in production.\n- Write clear";
    const c = content({ other: [{ text: "x", requirement: "must", quote: multi, offset: JD.indexOf(multi) }] });
    const { view } = buildBreakdownView(input({ row: row(c) }));
    expect(view?.content?.other[0]).toMatchObject({ quote: multi, quoteIndex: null });
  });

  it("shows the catalog's CLI default model for a row that stored codex's placeholder", () => {
    const catalog = shippedCatalog();
    const cliDefault = catalog.providers["codex-cli"].models.find((m) => m.cli_default)?.id;
    const old = buildBreakdownView(input({ row: row(content(), { model: "codex-default" }), catalog })).view;
    expect(old?.meta).toMatchObject({ model: cliDefault, modelByCliDefault: true });
    const named = buildBreakdownView(input({ catalog })).view;
    expect(named?.meta).toMatchObject({ model: "gpt-5.5", modelByCliDefault: false });
    const noCatalog = buildBreakdownView(input({ row: row(content(), { model: "codex-default" }) })).view;
    expect(noCatalog?.meta).toMatchObject({ model: "codex-default", modelByCliDefault: false });
  });
});
