// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createPriorityScorer, orderByPriority, type PriorityInputs, type PriorityJob } from "@/lib/scoring/priority";

import { shippedPipeline } from "../pipeline/helpers";
import { aiConfig, examplePreferences, exampleMe } from "./helpers";

const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = 86_400_000;

function inputs(over: Partial<PriorityInputs> = {}, edit?: (raw: Record<string, unknown>) => void): PriorityInputs {
  const config = aiConfig(edit);
  return {
    priority: config.scoring.priority,
    languagePenalty: config.scoring.language_penalty,
    preferences: examplePreferences(),
    keywordGroupTerms: ["Machine Learning Engineer", "AI Solutions Engineer", "KI-Entwickler"],
    pipeline: shippedPipeline(),
    bonusCap: 15,
    me: exampleMe(),
    now: NOW,
    ...over,
  };
}

const place = (city: string, countryCode = "DE") => ({ label: city, city, countryCode, isPrimary: true });

function job(over: Partial<PriorityJob> = {}): PriorityJob {
  return {
    title: "Something else entirely",
    locations: [place("Berlin")],
    workplace: "onsite",
    seniority: "senior",
    germanLevel: "unknown",
    signalBonus: 0,
    postedAt: null,
    firstSeenAt: new Date(NOW.getTime() - DAY),
    ...over,
  };
}

const score = (j: Partial<PriorityJob>, i: PriorityInputs = inputs()) => createPriorityScorer(i)(job(j));

describe("title match", () => {
  it("a target title in the title is a full match; a longer form of a word counts", () => {
    expect(score({ title: "Senior AI Engineer – EU" }).title).toBe(1);
    expect(score({ title: "Staff Forward Deployed Engineer" }).title).toBe(1);
    expect(score({ title: "Manager, Forward Deployed Engineering" }).title).toBe(1); // engineering ~ engineer
  });

  it("a search keyword counts a little less than a target title", () => {
    expect(score({ title: "Machine Learning Engineer (m/w/d)" }).title).toBe(0.9);
    expect(score({ title: "KI-Entwickler Agenten" }).title).toBe(0.9);
  });

  it("all words present but not together are a weaker match, half of the words weaker still", () => {
    expect(score({ title: "Senior Android Engineer - AI Product" }).title).toBe(0.8); // "AI" and "Engineer" of the target "AI Engineer", not next to each other
    expect(score({ title: "Senior AI Specialist" }).title).toBe(0.25); // "AI" of "AI Engineer": half of the words x 0.5
  });

  it("words that are too common to count alone do not make a partial match", () => {
    expect(score({ title: "Cooling Flow System Design Engineer" }).title).toBe(0);
    expect(score({ title: "Senior Fullstack-Entwickler – Go & Vue.js" }).title).toBe(0);
  });

  it("short words must match exactly: 'ai' is not in 'Aid'", () => {
    expect(score({ title: "Aid Worker Engineer" }).title).toBe(0);
  });
});

describe("the other components", () => {
  it("location: a wanted city (also by alias) beats a nearby place, remote and the rest", () => {
    const exact = score({ locations: [place("Munich")] }).location;
    const nearby = score({ locations: [place("Potsdam")] }).location;
    const remote = score({ locations: [place("Lisbon", "PT")], workplace: "remote" }).location;
    const other = score({ locations: [place("Lisbon", "PT")], workplace: "onsite" }).location;
    expect([exact, nearby, remote, other]).toEqual([1, 0.6, 0.7, 0.3]);
    // the filter kept it with a "scope unknown" note ("Remote - Virginia"): barely counts
    expect(score({ locations: [{ label: "Remote - Virginia", city: null, countryCode: null, isPrimary: true }], workplace: "remote", locationUnclear: true }).location).toBe(0.1);
    // ... unless the place is one of the wanted cities
    expect(score({ locations: [place("Berlin")], locationUnclear: true }).location).toBe(1);
    // a label without a city ("Munich, Bavaria") still names the city
    expect(score({ locations: [{ label: "Munich, Bavaria", city: null, countryCode: "DE", isPrimary: true }] }).location).toBe(1);
  });

  it("a metro area, a country-only remote posting and a country-only on-site posting are in scope, not unclear", () => {
    const label = (text: string, countryCode: string | null = "DE") => ({ label: text, city: text, countryCode, isPrimary: true });
    expect(score({ locations: [label("Greater Munich Metropolitan Area")], workplace: "hybrid" }).location).toBe(1);
    expect(score({ locations: [label("Berlin Metropolitan Area", null)] }).location).toBe(1);
    expect(score({ locations: [{ label: "Germany (Remote)", city: null, countryCode: "DE", isPrimary: true }], workplace: "remote", countryLevel: true }).location).toBe(0.7);
    expect(score({ locations: [{ label: "Germany", city: null, countryCode: "DE", isPrimary: true }], workplace: "hybrid", countryLevel: true }).location).toBe(0.5);
    // a Munich elsewhere is not the wanted one
    expect(score({ locations: [label("Munich", "US")] }).location).toBe(0.3);
  });

  it("signals: the stored bonus as a share of the cap, never above 1", () => {
    expect(score({ signalBonus: 0 }).signals).toBe(0);
    expect(score({ signalBonus: 7.5 }).signals).toBe(0.5);
    expect(score({ signalBonus: 40 }).signals).toBe(1);
    expect(score({ signalBonus: 10 }, inputs({ bonusCap: 0 })).signals).toBe(0);
  });

  it("seniority: from the table of ai.yaml when it does not follow the preferences; a level the table lacks reads as unknown", () => {
    const table = inputs({}, (raw) => {
      ((raw.scoring as Record<string, Record<string, unknown>>).priority as Record<string, unknown>).seniority_from_preferences = false;
    });
    expect(score({ seniority: "senior" }, table).seniority).toBe(1);
    expect(score({ seniority: "junior" }, table).seniority).toBe(0.2);
    expect(score({ seniority: "unknown" }, table).seniority).toBe(0.6);
    expect(score({ seniority: "weird" }, table).seniority).toBe(0.6);
  });

  it("seniority: follows the wanted level of preferences.yaml when the inputs carry it", () => {
    const wanting = (seniority: "all" | "entry" | "mid" | "senior" | "lead") =>
      inputs({ preferences: { ...examplePreferences(), seniority } }, (raw) => {
        ((raw.scoring as Record<string, Record<string, unknown>>).priority as Record<string, unknown>).seniority_from_preferences = true;
      });
    const fit = (level: string, i: PriorityInputs) => score({ seniority: level }, i).seniority;
    // a junior search ranks junior postings first, senior ones last
    expect(fit("junior", wanting("entry"))).toBe(1);
    expect(fit("senior", wanting("entry"))).toBeLessThan(fit("mid", wanting("entry")));
    expect(fit("senior", wanting("entry"))).toBeLessThan(fit("junior", wanting("entry")));
    // a senior search keeps senior on top
    expect(fit("senior", wanting("senior"))).toBe(1);
    expect(fit("junior", wanting("senior"))).toBeLessThan(fit("mid", wanting("senior")));
    // "all" fits every level, also an unread one
    expect(fit("junior", wanting("all"))).toBe(1);
    expect(fit("principal", wanting("all"))).toBe(1);
    expect(fit("unknown", wanting("mid"))).toBe(0.6);
  });

  it("seniority: a file without seniority_from_preferences keeps the table of ai.yaml (existing configs do not change)", () => {
    const old = inputs({ preferences: { ...examplePreferences(), seniority: "entry" } }, (raw) => {
      delete ((raw.scoring as Record<string, Record<string, unknown>>).priority as Record<string, unknown>).seniority_from_preferences;
    });
    expect(old.priority.seniority_from_preferences).toBe(false);
    expect(score({ seniority: "junior" }, old).seniority).toBe(0.2);
    expect(score({ seniority: "senior" }, old).seniority).toBe(1);
  });

  it("recency: linear over recency_days, posted date before first seen", () => {
    expect(score({ firstSeenAt: NOW }).recency).toBe(1);
    expect(score({ firstSeenAt: new Date(NOW.getTime() - 7 * DAY) }).recency).toBe(0.5);
    expect(score({ firstSeenAt: new Date(NOW.getTime() - 30 * DAY) }).recency).toBe(0);
    expect(score({ postedAt: new Date(NOW.getTime() - 14 * DAY), firstSeenAt: NOW }).recency).toBe(0);
  });

  it("German gap: only what the user's German (B1) cannot cover, scaled to the largest deduction", () => {
    expect(score({ germanLevel: "B1" }).languageGap).toBe(0);
    expect(score({ germanLevel: "none" }).languageGap).toBe(0);
    expect(score({ germanLevel: "B2" }).languageGap).toBe(10 / 25);
    expect(score({ germanLevel: "C2" }).languageGap).toBe(1);
  });
});

describe("the priority", () => {
  it("is the weighted sum of the components minus the German gap", () => {
    const b = score({ title: "Senior AI Engineer", signalBonus: 15, firstSeenAt: NOW, germanLevel: "C2" });
    // 40 + 25 + 15 + 10 + 10 - 10
    expect(b.priority).toBe(90);
  });

  it("a posting the filter could not place keeps only `unclear_location_factor` of its priority", () => {
    const place = { label: "Remote - Virginia", city: null, countryCode: null, isPrimary: true };
    const clear = score({ title: "Senior AI Engineer", locations: [place], workplace: "remote", signalBonus: 15, firstSeenAt: NOW });
    const unclear = score({ title: "Senior AI Engineer", locations: [place], workplace: "remote", locationUnclear: true, signalBonus: 15, firstSeenAt: NOW });
    // 40 + 25 + 10.5 (remote 0.7) + 10 + 10 = 95.5, against (40 + 25 + 1.5 + 10 + 10) x 0.7 = 60.55
    expect(clear.priority).toBe(95.5);
    expect(unclear.priority).toBe(60.55);
  });

  it("follows the weights of ai.yaml (C8)", () => {
    const heavySignals = inputs({}, (raw) => {
      const weights = (raw.scoring as { priority: { weights: Record<string, number> } }).priority.weights;
      weights.title = 0;
      weights.signals = 100;
    });
    const titled = createPriorityScorer(heavySignals)(job({ title: "Senior AI Engineer" }));
    const paid = createPriorityScorer(heavySignals)(job({ signalBonus: 15 }));
    expect(paid.priority).toBeGreaterThan(titled.priority);
  });

  it("puts a relevant job before an irrelevant newer one, and breaks ties newest first, then by id", () => {
    const scorer = createPriorityScorer(inputs());
    const rows = [
      { jobId: 1, firstSeenAt: NOW, j: job({ title: "Senior Fullstack-Entwickler .NET & Angular", firstSeenAt: NOW }) },
      { jobId: 2, firstSeenAt: new Date(NOW.getTime() - 10 * DAY), j: job({ title: "Staff Forward Deployed Engineer", firstSeenAt: new Date(NOW.getTime() - 10 * DAY) }) },
      { jobId: 3, firstSeenAt: NOW, j: job({ title: "Senior AI Engineer – EU", firstSeenAt: NOW }) },
      { jobId: 4, firstSeenAt: NOW, j: job({ title: "Senior AI Engineer – EU", firstSeenAt: NOW }) },
    ];
    const ordered = orderByPriority(rows, (row) => scorer(row.j));
    expect(ordered.map((r) => r.jobId)).toEqual([4, 3, 2, 1]);
  });
});
