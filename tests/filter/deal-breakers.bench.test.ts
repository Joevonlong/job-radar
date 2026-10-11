/**
 * Performance budget of the deal-breakers: the filter step re-evaluates every open job in every run, so 20,000 open jobs
 * × 20 rules (one of them the visa rule, which runs the packs' visa patterns) must add less than 2.5 s (twice that on CI, whose
 * machines are slower and shared): 2 s for the user's rules as before, and the visa rule, which alone must stay under 0.8 s
 * (measured: about 1.7 s for all 20 and 0.45 s for the visa rule on an idle laptop, a fifth more inside the full parallel test
 * run). Measured as CPU time of this process, not wall time: a full parallel test run makes a busy machine wait, which says
 * nothing about the rules.
 *
 * The postings are multi-line like real ones, and a third of them carry a visa phrase (offers, refusals, permits, mentions, in
 * English and German), half a decoy that passes the visa prefilter without being about visas ("work authorization", "permitted"),
 * so the visa rule's slow path (cutting lines into sentences, every pattern) is measured, not only its quick first look.
 */
import { describe, expect, it } from "vitest";

import { DEAL_BREAKER_DEFAULTS } from "@/lib/config/schemas/pipeline";
import { dealBreakerSchema } from "@/lib/config/schemas/preferences";
import type { GermanLevel } from "@/lib/domain/types";
import { compileDealBreakers, dealBreakerVetoes, startDealBreakerRun, type DealBreakerJob } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";
import { visaRulesFor } from "@/lib/visa/rules";

import { shippedPipeline } from "../pipeline/helpers";

const JOBS = 20_000;
const BUDGET_MS = process.env.CI ? 5_000 : 2_500;
const VISA_BUDGET_MS = process.env.CI ? 1_600 : 800;

/** A small deterministic generator, so every run measures the same text. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const WORDS =
  "we are looking for an engineer to build reliable systems with our team in Berlin Munich Hamburg remote hybrid office customers platform data models pipelines Kubernetes Python TypeScript Go Rust Java experience years strong communication Deutschkenntnisse Englisch fließend Erfahrung Kunden Projekte Verantwortung Teamarbeit Entwicklung Betrieb travel Reisetätigkeit on-site vor Ort benefits Urlaub Gehalt bonus pension".split(
    " ",
  );
const LEVELS: GermanLevel[] = ["unknown", "none", "preferred", "A2", "B1", "B2", "C1", "C2"];

/** What a third of the postings say about visas: each lands on the visa rule's slow path. */
const VISA_LINES = [
  "We are unable to offer visa sponsorship for this role.",
  "Relocation support and visa sponsorship are available.",
  "Benefits:\n- Visa sponsorship\n- Relocation package\n- Gym",
  "You must hold a valid work permit for Germany.",
  "Questions about visas and relocation? Ask us in the first call.",
  "Wir unterstützen dich beim Visumprozess und bieten ein Relocation-Paket.",
  "Ein Visa-Sponsoring ist leider nicht möglich.",
  "## Visa sponsorship\nNot available for this role.",
  "Relocation support is not available for this role.",
];
/** Decoys: they pass the visa prefilter, and nothing in them is about the candidate's visa. */
const DECOYS = [
  "Work authorization documents are handled by HR during onboarding.",
  "Remote work is permitted two days a week.",
  "You will authorize deployments and review permissions.",
  "We help our customers with visa applications as part of our product.",
];

function jobs(): DealBreakerJob[] {
  const next = random(7);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  return Array.from({ length: JOBS }, (_, i) => {
    // about 3,000 characters: a typical description after cleanup, in lines of three sentences
    const sentences = Array.from({ length: 40 }, () => `${Array.from({ length: 10 }, () => pick(WORDS)).join(" ")}.`);
    if (i % 50 === 0) sentences.push("Reisetätigkeit von bis zu 60 %.");
    if (i % 3 === 0) sentences.splice(Math.floor(next() * sentences.length), 0, pick(VISA_LINES));
    if (i % 2 === 0) sentences.splice(Math.floor(next() * sentences.length), 0, pick(DECOYS));
    const lines: string[] = [];
    for (let at = 0; at < sentences.length; at += 3) lines.push(sentences.slice(at, at + 3).join(" "));
    return { title: `${pick(["Senior", "Staff", "Junior", ""])} ${pick(WORDS)} Engineer`.trim(), description: lines.join("\n"), germanLevel: pick(LEVELS) };
  });
}

/** CPU milliseconds of `work` in this process. */
function cpuMs(work: () => void): number {
  const started = process.cpuUsage();
  work();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

const rules = [
  { id: "gate", label: "Gate", type: "language_gate" },
  { id: "visa", label: "Visa", type: "visa_not_offered" },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `terms-${i}`, label: "Terms", type: "phrase", terms: [`blockchain${i}`, "cold calling", `Stadt${i}`] })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `title-${i}`, label: "Title", type: "phrase", terms: [`Sales${i}`], scope: "title" })),
  { id: "travel", label: "Travel", type: "phrase", patterns: ["Reisetätigkeit.{0,30}(?:[5-9]\\d|100)\\s?%", "travel.{0,30}(?:[5-9]\\d|100)\\s?%"] },
  { id: "onsite", label: "On-site", type: "phrase", patterns: ["100\\s?%\\s*(?:on-?site|vor Ort)"], scope: "description" },
  { id: "travel-word", label: "Travel word", type: "phrase", terms: ["travel"], unless: ["\\bno travel\\b", "travel (?:is )?not required"] },
  { id: "oncall", label: "On call", type: "phrase", patterns: ["\\bon-?call\\b", "Rufbereitschaft"] },
  { id: "agency", label: "Agency", type: "phrase", terms: ["Personaldienstleister", "Arbeitnehmerüberlassung"], unless: ["\\bkein\\b"] },
].map((raw) => dealBreakerSchema.parse(raw));

// the run's time budget is wall time and not what is measured here: a large one, so a busy machine stops no rule
const compile = (list: typeof rules) =>
  compileDealBreakers(list, { language: "de", me: { languages: [{ de: "B1" }], needs_visa_sponsorship: true }, limits: { ...DEAL_BREAKER_DEFAULTS, rule_budget_ms: 600_000 }, visa: visaRulesFor(shippedPipeline()) });

/** Vetoes per rule id over all jobs, in batches as the filter step reads them, and the CPU time it took. */
function measure(list: typeof rules, subjects: readonly DealBreakerJob[]): { ms: number; vetoes: Map<string, number> } {
  const run = startDealBreakerRun(compile(list), vmTimeBox);
  expect(run.warnings).toEqual([]);
  const vetoes = new Map<string, number>();
  const ms = cpuMs(() => {
    for (let from = 0; from < subjects.length; from += 200) {
      for (const ids of dealBreakerVetoes(run, subjects.slice(from, from + 200)).vetoes) for (const id of ids) vetoes.set(id, (vetoes.get(id) ?? 0) + 1);
    }
  });
  expect(run.warnings).toEqual([]);
  return { ms, vetoes };
}

describe("deal-breakers performance", () => {
  const subjects = jobs();

  it("measures postings a third of which talk about visas", () => {
    const visa = subjects.filter((job) => /visa|visum|relocation|permit/iu.test(job.description ?? "")).length;
    expect(visa).toBeGreaterThanOrEqual(JOBS / 3);
  });

  it(`checks ${JOBS} jobs against ${rules.length} rules within ${BUDGET_MS} ms`, () => {
    expect(rules).toHaveLength(20);
    expect(compile(rules).rules).toHaveLength(20);
    const { ms, vetoes } = measure(rules, subjects);
    expect(vetoes.get("visa") ?? 0).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it(`checks ${JOBS} jobs against the visa rule alone within ${VISA_BUDGET_MS} ms`, () => {
    const { ms, vetoes } = measure(rules.filter((rule) => rule.type === "visa_not_offered"), subjects);
    // the refusals, the permit and the German refusal: 4 of the 9 visa lines, on a third of the jobs
    expect(vetoes.get("visa") ?? 0).toBeGreaterThan(JOBS / 3 / 9 * 3);
    expect(ms).toBeLessThan(VISA_BUDGET_MS);
  });
});
