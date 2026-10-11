/**
 * Performance budget of the deal-breakers: the filter step re-evaluates every open job in every run, so 20,000 open jobs
 * × 20 rules must add less than 2 s (twice that on CI, whose machines are slower and shared). Measured as CPU time of
 * this process, not wall time: a full parallel test run makes a busy machine wait, which says nothing about the rules.
 */
import { describe, expect, it } from "vitest";

import { DEAL_BREAKER_DEFAULTS } from "@/lib/config/schemas/pipeline";
import { dealBreakerSchema } from "@/lib/config/schemas/preferences";
import type { GermanLevel } from "@/lib/domain/types";
import { compileDealBreakers, dealBreakerVetoes, startDealBreakerRun, type DealBreakerJob } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";

const JOBS = 20_000;
const BUDGET_MS = process.env.CI ? 4_000 : 2_000;

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

function jobs(): DealBreakerJob[] {
  const next = random(7);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  return Array.from({ length: JOBS }, (_, i) => {
    // about 3,000 characters: a typical description after cleanup
    const sentences = Array.from({ length: 40 }, () => `${Array.from({ length: 10 }, () => pick(WORDS)).join(" ")}.`);
    if (i % 50 === 0) sentences.push("Reisetätigkeit von bis zu 60 %.");
    return { title: `${pick(["Senior", "Staff", "Junior", ""])} ${pick(WORDS)} Engineer`.trim(), description: sentences.join(" "), germanLevel: pick(LEVELS) };
  });
}

const rules = [
  { id: "gate", label: "Gate", type: "language_gate" },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `terms-${i}`, label: "Terms", type: "phrase", terms: [`blockchain${i}`, "cold calling", `Stadt${i}`] })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `title-${i}`, label: "Title", type: "phrase", terms: [`Sales${i}`], scope: "title" })),
  { id: "travel", label: "Travel", type: "phrase", patterns: ["Reisetätigkeit.{0,30}(?:[5-9]\\d|100)\\s?%", "travel.{0,30}(?:[5-9]\\d|100)\\s?%"] },
  { id: "onsite", label: "On-site", type: "phrase", patterns: ["100\\s?%\\s*(?:on-?site|vor Ort)"], scope: "description" },
  { id: "travel-word", label: "Travel word", type: "phrase", terms: ["travel"], unless: ["\\bno travel\\b", "travel (?:is )?not required"] },
  { id: "oncall", label: "On call", type: "phrase", patterns: ["\\bon-?call\\b", "Rufbereitschaft"] },
  { id: "agency", label: "Agency", type: "phrase", terms: ["Personaldienstleister", "Arbeitnehmerüberlassung"], unless: ["\\bkein\\b"] },
].map((raw) => dealBreakerSchema.parse(raw));

describe("deal-breakers performance", () => {
  it(`checks ${JOBS} jobs against ${rules.length} rules within ${BUDGET_MS} ms`, () => {
    expect(rules).toHaveLength(20);
    const subjects = jobs();
    // the run's time budget is wall time and not what is measured here: a large one, so a busy machine stops no rule
    const compiled = compileDealBreakers(rules, { language: "de", me: { languages: [{ de: "B1" }] }, limits: { ...DEAL_BREAKER_DEFAULTS, rule_budget_ms: 600_000 } });
    expect(compiled.rules).toHaveLength(20);
    const run = startDealBreakerRun(compiled, vmTimeBox);
    expect(run.warnings).toEqual([]);
    const started = process.cpuUsage();
    let vetoed = 0;
    // in batches, as the filter step reads them
    for (let from = 0; from < subjects.length; from += 200) {
      for (const ids of dealBreakerVetoes(run, subjects.slice(from, from + 200)).vetoes) if (ids.length > 0) vetoed += 1;
    }
    const used = process.cpuUsage(started);
    const elapsed = (used.user + used.system) / 1000;
    expect(vetoed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(run.warnings).toEqual([]);
  });
});
