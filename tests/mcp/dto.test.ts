// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { JobCard } from "@/lib/db/queries/types";
import type { Application } from "@/lib/db/repos/applications";
import { applicationItemDto, jobCardDto, jobDetailDto, toApplicationItemDto, toJobCardDto, toJobDetailDto } from "@/lib/mcp/dto";
import { availableDescription } from "@/lib/mcp/guard";

/** Values that must never leave through the MCP server; each is put where the queries return it. */
const SENTINEL = {
  favoriteNote: "SENTINEL-favorite-note",
  summary: "SENTINEL-ai-summary",
  filterReason: "SENTINEL-filter-reason",
  fitReason: "SENTINEL-fit-reason",
  gap: "SENTINEL-gap",
  notes: "SENTINEL-application-notes",
  resumePath: "/Users/sentinel/resumes/SENTINEL.pdf",
  eventNote: "SENTINEL-event-note",
  floor: 987_654,
  germanPenalty: 4321,
  signalBonus: 77.77,
  model: "SENTINEL-model",
};

const identity = (text: string) => text;
const NOW = new Date("2026-10-11T10:00:00Z");

function card(): JobCard {
  return {
    id: 7,
    title: "Data Engineer",
    companyId: 3,
    companyName: "Acme",
    locations: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: true }],
    workplace: "hybrid",
    contract: "permanent",
    isAgency: false,
    germanLevelRequired: "none",
    status: "active",
    closedReason: null,
    linkCheck: null,
    postedAt: new Date("2026-10-01T00:00:00Z"),
    firstSeenAt: new Date("2026-10-02T00:00:00Z"),
    lastSeenAt: new Date("2026-10-10T00:00:00Z"),
    salaryDisclosed: false,
    salary: null,
    skills: ["Python"],
    sources: [{ channelId: "greenhouse", family: "ats", url: "https://boards.example/acme/1", applyUrl: null, priority: 1 }],
    applicationStatus: null,
    favorite: { createdAt: NOW, note: SENTINEL.favoriteNote },
    rank: { rankValue: 81, score: 78, signalBonus: SENTINEL.signalBonus, filterResult: "passed", filterReasons: [SENTINEL.filterReason], stale: false },
    summary: { texts: { en: SENTINEL.summary }, outputLang: "en" },
    signals: [],
    traps: null,
    seen: true,
  };
}

function application(): Application {
  return {
    id: 1,
    jobId: 7,
    status: "applied",
    statusChangedAt: new Date("2026-09-21T10:00:00Z"),
    nextAction: "Follow up",
    nextActionAt: null,
    notesMd: SENTINEL.notes,
    resumeVariantPath: SENTINEL.resumePath,
    interviewRounds: 0,
    createdAt: new Date("2026-09-20T10:00:00Z"),
  };
}

function detail(): JobDetail {
  const base = card();
  return {
    id: base.id,
    title: base.title,
    company: { id: 3, name: "Acme", watched: false },
    locations: base.locations,
    workplace: base.workplace,
    seniority: "senior",
    contract: base.contract,
    isAgency: false,
    language: "en",
    germanLevelRequired: "none",
    germanLevelRule: "none",
    status: "active",
    closure: { autoStatus: "active", reason: null, override: null, linkCheck: null },
    postedAt: base.postedAt,
    firstSeenAt: base.firstSeenAt,
    lastSeenAt: base.lastSeenAt,
    description: "The full original JD.",
    salary: null,
    salaryDisclosed: false,
    skills: base.skills,
    sources: base.sources,
    signals: [
      { id: 1, tier: "T1", kind: "salary_range", value: { currency: "EUR", min: 70000, max: 85000, eurPerYear: { min: 70000, max: 85000 }, basePerYear: { min: 70000, max: 85000 }, baseCurrency: "EUR", stated: { min: 70000, max: 85000, period: "year" }, periodAssumed: false, currencyAssumed: false }, quote: "EUR 70,000 - 85,000", quoteOffset: 12, quoteSource: "description", extractor: "rule" },
      { id: 2, tier: "T2", kind: "remote_budget", value: { anything: SENTINEL.model }, quote: "home office budget", quoteOffset: 40, quoteSource: "description", extractor: "ai" },
    ],
    signalScan: { ruleScanned: true, aiReviewed: true },
    score: {
      rankValue: 81,
      score: 78,
      signalBonus: SENTINEL.signalBonus,
      filterResult: "passed",
      filterReasons: [SENTINEL.filterReason],
      filterFloorEur: SENTINEL.floor,
      fitReasons: [SENTINEL.fitReason],
      gaps: [SENTINEL.gap],
      summaries: { en: SENTINEL.summary },
      outputLang: "en",
      stale: false,
      aiScore: 82,
      germanPenalty: SENTINEL.germanPenalty,
      germanLevel: "none",
      germanLevelAi: "none",
      germanLevelSource: "agree",
      provider: "claude-cli",
      model: SENTINEL.model,
      promptVersion: "v9",
      scoredAt: NOW,
    },
    translatedLanguages: ["zh"],
    application: application(),
    favorite: { createdAt: NOW, note: SENTINEL.favoriteNote },
    applicationEvents: [{ id: 1, applicationId: 1, at: NOW, fromStatus: "interested", toStatus: "applied", note: SENTINEL.eventNote }],
  };
}

function expectNoSentinel(value: unknown): void {
  const json = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINEL)) expect(json).not.toContain(String(sentinel));
}

describe("the output field sets (a change here is a change of the data egress register)", () => {
  it("job card", () => {
    expect(Object.keys(jobCardDto.shape).sort()).toMatchInlineSnapshot(`
      [
        "application_status",
        "company",
        "contract",
        "first_seen_at",
        "german_level_required",
        "id",
        "is_agency",
        "links",
        "locations",
        "posted_at",
        "rank",
        "salary",
        "skills",
        "status",
        "title",
        "workplace",
      ]
    `);
  });
  it("job detail = job card plus these", () => {
    const extra = Object.keys(jobDetailDto.shape).filter((key) => !(key in jobCardDto.shape));
    expect(extra.sort()).toEqual(["ai_traps", "application", "closed_reason", "description", "language", "last_seen_at", "seniority", "signals"]);
  });
  it("application item", () => {
    expect(Object.keys(applicationItemDto.shape).sort()).toEqual(["company", "days_in_status", "history", "interview_rounds", "job_id", "job_status", "links", "next_action", "next_action_at", "rank_value", "status", "status_changed_at", "title"]);
  });
});

describe("mapping", () => {
  it("a card carries the facts, never the summary, the favorite note, filter reasons or the signal bonus", () => {
    const dto = toJobCardDto(card(), identity);
    expect(dto).toMatchObject({ id: 7, title: "Data Engineer", company: "Acme", rank: { rank_value: 81, score: 78, stale: false }, application_status: "new", links: [{ source: "ats", url: "https://boards.example/acme/1", apply_url: null }] });
    expectNoSentinel(dto);
  });
  it("a detail carries signals with quote and offset, never reasons, gaps, the floor, the German deduction, the model, notes or paths", () => {
    const dto = toJobDetailDto(detail(), { traps: { traps: 1, suspicious: 0 }, description: availableDescription("cleaned JD", 12_000) }, identity);
    expect(dto.signals[0]).toEqual({
      category: "T1",
      kind: "salary_range",
      amount: { currency: "EUR", per_year: { min: 70000, max: 85000 }, stated: { min: 70000, max: 85000, period: "year" }, base_per_year: { min: 70000, max: 85000 }, base_currency: "EUR", period_assumed: false, currency_assumed: false, other_region: null },
      quote: "EUR 70,000 - 85,000",
      quote_offset: 12,
      quote_source: "description",
      extractor: "rule",
    });
    // a value that is not an amount is never passed through
    expect(dto.signals[1]?.amount).toBeNull();
    expect(dto.application).toEqual({ status: "applied", status_changed_at: "2026-09-21T10:00:00.000Z", next_action: "Follow up", next_action_at: null, interview_rounds: 0 });
    expect(dto.description.text).toBe("cleaned JD");
    expectNoSentinel(dto);
  });
  it("an amount stored in an older, shorter shape still comes through, extra fields dropped", () => {
    const base = detail();
    const older = {
      ...base,
      signals: [
        { id: 3, tier: "T1", kind: "salary_fixed", value: { amount: 86400, currency: "EUR", period: "year", stated: { min: 7200, max: 7200, period: "month" }, note: SENTINEL.model }, quote: "7.200 € monthly", quoteOffset: 5, quoteSource: "description", extractor: "rule" },
        { id: 4, tier: "T1", kind: "salary_range", value: { min: 60000, max: 70000, currency: "EUR" }, quote: "60-70k", quoteOffset: 9, quoteSource: "description", extractor: "rule" },
        { id: 5, tier: "T1", kind: "salary_range", value: { min: 60000, max: 70000, currency: "euros" }, quote: "60-70k", quoteOffset: 9, quoteSource: "description", extractor: "rule" },
      ],
    } satisfies JobDetail;
    const dto = toJobDetailDto(older, { traps: null, description: availableDescription(null, 500) }, identity);
    expect(dto.signals.map((s) => s.amount)).toEqual([
      { currency: "EUR", per_year: { min: 86400, max: 86400 }, stated: { min: 7200, max: 7200, period: "month" }, base_per_year: null, base_currency: null, period_assumed: false, currency_assumed: false, other_region: null },
      { currency: "EUR", per_year: { min: 60000, max: 70000 }, stated: null, base_per_year: null, base_currency: null, period_assumed: false, currency_assumed: false, other_region: null },
      null,
    ]);
    expectNoSentinel(dto);
  });
  it("an application item counts the days in its status and keeps the history without notes", () => {
    const dto = toApplicationItemDto({ job: card(), application: application(), events: detail().applicationEvents }, NOW, identity);
    expect(dto.days_in_status).toBe(20);
    expect(dto.history).toEqual([{ from: "interested", to: "applied", at: NOW.toISOString() }]);
    expectNoSentinel(dto);
  });
  it("every third-party string goes through the cleaner", () => {
    const seen: string[] = [];
    const spy = (text: string) => {
      seen.push(text);
      return text;
    };
    toJobDetailDto(detail(), { traps: null, description: availableDescription(null, 500) }, spy);
    expect(seen).toEqual(expect.arrayContaining(["Data Engineer", "Acme", "Berlin, Germany", "Berlin", "Python", "https://boards.example/acme/1", "EUR 70,000 - 85,000", "home office budget"]));
  });
});
