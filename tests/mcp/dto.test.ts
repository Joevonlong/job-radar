// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { JobCard } from "@/lib/db/queries/types";
import type { Application } from "@/lib/db/repos/applications";
import { applicationItemDto, jobCardDto, jobDetailDto, toApplicationItemDto, toJobCardDto, toJobDetailDto } from "@/lib/mcp/dto";
import { availableDescription } from "@/lib/mcp/guard";
import { breakdownBlockDto, companyBlockDto, ghostBlockDto, lifecycleBlockDto, matchBlockDto, notesBlockDto, salaryBlockDto, trackingBlockDto, translationBlockDto } from "@/lib/mcp/dto";
import { toBreakdownContent, toGhostReason } from "@/lib/mcp/job-blocks/analysis";
import type { JobBlockSource } from "@/lib/mcp/job-blocks/source";

import { blockBreakdown } from "./job-block-fixtures";

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
    lastListedAt: null,
    relistedAt: null,
    relistCount: 0,
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
    company: { id: 3, name: "Acme", nameNorm: "acme", watched: false },
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
    lastListedAt: null,
    relistedAt: null,
    relistCount: 0,
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
      reasonEvidence: null,
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
    visa: null,
    ghost: null,
  };
}

function expectNoSentinel(value: unknown): void {
  const json = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINEL)) expect(json).not.toContain(String(sentinel));
}

describe("the output field sets (a change here is a change of what docs/privacy.md lists)", () => {
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

function fieldSet(schema: z.core.$ZodType, prefix = ""): string[] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return fieldSet(schema.unwrap(), prefix);
  if (schema instanceof z.ZodArray) return fieldSet(schema.element, prefix);
  if (schema instanceof z.ZodDiscriminatedUnion) return [...new Set(schema.options.flatMap((option) => fieldSet(option, prefix)))].sort();
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value instanceof z.ZodType ? [path, ...fieldSet(value, path)] : [path];
  }).sort();
}

describe("get_job block field sets", () => {
  it("translation", () => { expect(fieldSet(translationBlockDto)).toMatchInlineSnapshot(`
    [
      "available",
      "items",
      "items.created_at",
      "items.language",
      "items.stale",
      "items.text",
      "items.total_chars",
      "items.truncated",
      "reason",
    ]
  `); });
  it("breakdown", () => { expect(fieldSet(breakdownBlockDto)).toMatchInlineSnapshot(`
    [
      "analyzed_at",
      "available",
      "content",
      "content.experience",
      "content.experience.items",
      "content.experience.items.offset",
      "content.experience.items.quote",
      "content.experience.items.requirement",
      "content.experience.items.text",
      "content.experience.years_min",
      "content.experience.years_quote",
      "content.experience.years_quote.offset",
      "content.experience.years_quote.quote",
      "content.languages",
      "content.languages.language",
      "content.languages.level",
      "content.languages.offset",
      "content.languages.quote",
      "content.languages.requirement",
      "content.other",
      "content.other.offset",
      "content.other.quote",
      "content.other.requirement",
      "content.other.text",
      "content.projects",
      "content.projects.offset",
      "content.projects.quote",
      "content.projects.requirement",
      "content.projects.text",
      "content.responsibilities",
      "content.responsibilities.offset",
      "content.responsibilities.quote",
      "content.responsibilities.text",
      "content.soft_skills",
      "content.soft_skills.offset",
      "content.soft_skills.quote",
      "content.soft_skills.requirement",
      "content.soft_skills.text",
      "content.tech_stack",
      "content.tech_stack.category",
      "content.tech_stack.name",
      "content.tech_stack.offset",
      "content.tech_stack.quote",
      "content.tech_stack.requirement",
      "reason",
    ]
  `); });
  it("salary", () => { expect(fieldSet(salaryBlockDto)).toMatchInlineSnapshot(`
    [
      "benchmark",
      "benchmark.level",
      "benchmark.median",
      "benchmark.n",
      "benchmark.place",
      "benchmark.quantiles",
      "benchmark.seniority",
      "company_figures",
      "company_figures.count",
      "company_figures.median",
      "currency",
      "family",
      "figure",
      "lookup",
      "lookup.available",
      "lookup.company_level",
      "lookup.company_level.level",
      "lookup.company_level.median",
      "lookup.company_level.summary",
      "lookup.confidence",
      "lookup.expired",
      "lookup.fetched_at",
      "lookup.notes",
      "lookup.reason",
      "lookup.related_roles",
      "lookup.related_roles.basis",
      "lookup.related_roles.location",
      "lookup.related_roles.max",
      "lookup.related_roles.median",
      "lookup.related_roles.min",
      "lookup.related_roles.seniority",
      "lookup.related_roles.title",
      "lookup.role_band",
      "lookup.role_band.basis",
      "lookup.role_band.location",
      "lookup.role_band.max",
      "lookup.role_band.median",
      "lookup.role_band.min",
      "lookup.role_band.seniority",
      "lookup.role_band.title",
      "lookup.sources",
      "lookup.sources.excerpt",
      "lookup.sources.host",
      "lookup.sources.site",
      "lookup.sources.title",
      "lookup.sources.trusted",
      "lookup.sources.url",
      "position",
      "position.clamp",
      "position.value",
    ]
  `); });
  it("company", () => { expect(fieldSet(companyBlockDto)).toMatchInlineSnapshot(`
    [
      "available",
      "expired",
      "fetched_at",
      "fields",
      "fields.field",
      "fields.source_url",
      "fields.text",
      "reason",
    ]
  `); });
  it("ghost", () => { expect(fieldSet(ghostBlockDto)).toMatchInlineSnapshot(`
    [
      "checked_at",
      "dismissed",
      "level",
      "reasons",
      "reasons.channel_id",
      "reasons.code",
      "reasons.days",
      "reasons.events",
      "reasons.events.gap_days",
      "reasons.events.new_seen",
      "reasons.events.old_seen",
      "reasons.field",
      "reasons.from",
      "reasons.has_responsibilities",
      "reasons.label",
      "reasons.min_words",
      "reasons.offset",
      "reasons.pattern_id",
      "reasons.points",
      "reasons.quote",
      "reasons.responsibilities_from",
      "reasons.since",
      "reasons.words",
      "score",
      "state",
    ]
  `); });
  it("lifecycle", () => { expect(fieldSet(lifecycleBlockDto)).toMatchInlineSnapshot(`
    [
      "auto_status",
      "closed_reason",
      "dormant",
      "last_listed_at",
      "last_seen_at",
      "relist_count",
      "relisted_at",
    ]
  `); });
  it("match", () => { expect(fieldSet(matchBlockDto)).toMatchInlineSnapshot(`
    [
      "ai_score",
      "available",
      "checks",
      "checks.german",
      "checks.german.required",
      "checks.german.state",
      "checks.salary_floor",
      "checks.salary_floor.approx",
      "checks.salary_floor.currency",
      "checks.salary_floor.figure",
      "checks.salary_floor.state",
      "checks.skills",
      "checks.skills.have",
      "checks.skills.name",
      "deal_breakers",
      "deal_breakers.field",
      "deal_breakers.id",
      "deal_breakers.offset",
      "deal_breakers.quote",
      "deal_breakers.required",
      "deal_breakers.type",
      "deal_breakers.visa_kind",
      "filter",
      "filter.reasons",
      "filter.result",
      "fit_reasons",
      "fit_reasons.basis",
      "fit_reasons.offset",
      "fit_reasons.quote",
      "fit_reasons.text",
      "gaps",
      "gaps.basis",
      "gaps.offset",
      "gaps.quote",
      "gaps.text",
      "german_penalty",
      "output_lang",
      "reason",
      "scored_at",
      "stale",
      "summaries",
      "visa",
      "visa.checked_at",
      "visa.evidence",
      "visa.evidence.kind",
      "visa.evidence.offset",
      "visa.evidence.quote",
      "visa.evidence.status",
      "visa.kind",
      "visa.match",
      "visa.state",
    ]
  `); });
  it("tracking", () => { expect(fieldSet(trackingBlockDto)).toMatchInlineSnapshot(`
    [
      "application",
      "application.created_at",
      "application.history",
      "application.history.at",
      "application.history.from",
      "application.history.to",
      "application.interview_rounds",
      "application.next_action",
      "application.next_action_at",
      "application.status",
      "application.status_changed_at",
      "closure",
      "closure.auto_status",
      "closure.link_check",
      "closure.link_check.checked_at",
      "closure.link_check.outcome",
      "closure.override",
      "closure.override.action",
      "closure.override.at",
      "closure.reason",
      "favorite",
      "favorite.since",
      "filter_override",
      "seen",
    ]
  `); });
  it("notes", () => { expect(fieldSet(notesBlockDto)).toMatchInlineSnapshot(`
    [
      "application_notes",
      "event_notes",
      "event_notes.at",
      "event_notes.from",
      "event_notes.note",
      "event_notes.to",
      "favorite_note",
    ]
  `); });

  it("the breakdown mapper drops unrelated row fields, cleans text and guards every quote", () => {
    const source: JobBlockSource = { detail: detail(), strict: { ok: false, reason: "not_scanned" }, clean: (text) => `clean:${text}`, quote: () => "[marker]" };
    const content = { ...blockBreakdown(), provider: SENTINEL.model, profile: SENTINEL.notes };
    const mapped = toBreakdownContent(content, source);
    expect(breakdownBlockDto.parse({ available: true, reason: null, content: mapped, analyzed_at: NOW.toISOString() }).content).toEqual(mapped);
    expect(mapped.responsibilities[0]).toEqual({ text: "clean:[marker]", quote: "[marker]", offset: 15 });
    expect(mapped.tech_stack[0]?.name).toBe("clean:[marker]");
    expect(mapped.languages[0]?.language).toBe("clean:[marker]");
    expectNoSentinel(mapped);
  });

  it("every ghost reason is an explicit whitelist, without source ids in repost events", () => {
    const source: JobBlockSource = { detail: detail(), strict: { ok: false, reason: "not_scanned" }, clean: (text) => `clean:${text}`, quote: () => null };
    const reasons = [
      toGhostReason({ code: "long_open", points: 2, days: 30, since: "2026-09-01", from: "posted", channelId: "fixture" }, source),
      toGhostReason({ code: "repost_label", points: 1, channelId: "fixture", label: "Reposted" }, source),
      toGhostReason({ code: "reposted", points: 3, channelId: "fixture", events: [{ oldId: SENTINEL.model, newId: SENTINEL.resumePath, oldSeen: "2026-09-01", newSeen: "2026-10-01", gapDays: 30 }] }, source),
      toGhostReason({ code: "evergreen_wording", points: 2, patternId: "pool", quote: "talent pool", offset: 0 }, source),
      toGhostReason({ code: "evergreen_wording", points: 2, patternId: "pool", quote: "talent pool", offset: 0, field: "title" }, source),
      toGhostReason({ code: "thin_description", points: 1, words: 20, minWords: 80, hasResponsibilities: false, responsibilitiesFrom: "headings", channelId: "fixture" }, source),
    ];
    expect(ghostBlockDto.safeParse({ state: "likely", level: "likely", score: 9, checked_at: NOW.toISOString(), dismissed: false, reasons }).success).toBe(true);
    expect(reasons).toContainEqual({ code: "evergreen_wording", points: 2, pattern_id: "clean:pool", quote: null, offset: 0 });
    expect(reasons).toContainEqual({ code: "evergreen_wording", points: 2, pattern_id: "clean:pool", quote: "clean:talent pool", offset: 0, field: "title" });
    expectNoSentinel(reasons);
  });
});

describe("mapping", () => {
  it("keeps both delivery ledger tables outside every MCP output allowlist", () => {
    const ledger = {
      delivery_items: [{ payload_json: { text: "private receipt" }, external_id: "private provider id" }],
      run_deliveries: [{ delivered: 1, counts_json: { dispositions: { no_identity: 1 } } }],
    };
    const job = { ...card(), ...ledger };
    const detailed = { ...detail(), ...ledger };
    const app = { ...application(), ...ledger };
    const outputs = [
      { schema: jobCardDto, value: toJobCardDto(job, identity) },
      { schema: jobDetailDto, value: toJobDetailDto(detailed, { traps: null, description: availableDescription(null, 500) }, identity) },
      { schema: applicationItemDto, value: toApplicationItemDto({ job, application: app, events: [] }, NOW, identity) },
    ];
    for (const { schema, value } of outputs) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, ...ledger }).success).toBe(false);
      expect(JSON.stringify(value)).not.toMatch(/delivery_items|run_deliveries|private receipt|private provider id/);
    }
  });
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
