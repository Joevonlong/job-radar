import type { BreakdownContent } from "@/lib/breakdown/content";
import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { SalaryContext } from "@/lib/salary/view";

export const BLOCK_NOW = new Date("2026-10-11T10:00:00Z");
export const BLOCK_SENTINEL = {
  fit: "SENTINEL-fit-reason", gap: "SENTINEL-gap", filter: "SENTINEL-filter-reason",
  applicationNote: "SENTINEL-application-note", eventNote: "SENTINEL-event-note", favoriteNote: "SENTINEL-favorite-note",
  closureNote: "SENTINEL-closure-note", profile: "SENTINEL-profile-summary", email: "sentinel@example.invalid",
  path: "/Users/sentinel/resume.pdf", secret: "SECRET_TOKEN=sentinel-unused", floor: 987654, provider: "SENTINEL-provider", model: "SENTINEL-model",
};

export function blockDetail(): JobDetail {
  return {
    id: 7, title: "Data Engineer", company: { id: 3, name: "Acme", nameNorm: "acme", watched: false },
    locations: [], workplace: "hybrid", seniority: "senior", contract: "permanent", isAgency: false, language: "en", germanLevelRequired: "B2", germanLevelRule: "B2", status: "active",
    closure: { autoStatus: "possibly_closed", reason: "dormant", override: { action: "open", note: BLOCK_SENTINEL.closureNote, createdAt: BLOCK_NOW }, linkCheck: { outcome: "robots", at: BLOCK_NOW.toISOString(), httpStatus: 403, phrase: BLOCK_SENTINEL.secret, quote: BLOCK_SENTINEL.email, url: BLOCK_SENTINEL.path } },
    postedAt: BLOCK_NOW, firstSeenAt: BLOCK_NOW, lastSeenAt: BLOCK_NOW, lastListedAt: BLOCK_NOW, relistedAt: BLOCK_NOW, relistCount: 2,
    description: "Build reliable data pipelines.", salary: null, salaryDisclosed: false, skills: ["Python", "SQL"], sources: [], signals: [], signalScan: null,
    score: { rankValue: 80, score: 80, signalBonus: 12, filterResult: "filtered_out", filterReasons: [BLOCK_SENTINEL.filter], filterFloorEur: BLOCK_SENTINEL.floor, fitReasons: [BLOCK_SENTINEL.fit], gaps: [BLOCK_SENTINEL.gap], reasonEvidence: { v: 1, fit: [{ basis: "jd", quote: "data pipelines", offset: 15 }], gaps: [{ basis: "inferred", quote: null, offset: null }] }, summaries: { en: "A data role", zh: "数据职位" }, outputLang: "en", stale: false, aiScore: 85, germanPenalty: 5, germanLevel: "B2", germanLevelAi: "B2", germanLevelSource: "agree", provider: BLOCK_SENTINEL.provider, model: BLOCK_SENTINEL.model, promptVersion: BLOCK_SENTINEL.secret, scoredAt: BLOCK_NOW },
    translatedLanguages: ["zh", "de"],
    application: { id: 1, jobId: 7, status: "applied", statusChangedAt: BLOCK_NOW, createdAt: BLOCK_NOW, nextAction: "Follow up", nextActionAt: BLOCK_NOW, interviewRounds: 2, notesMd: BLOCK_SENTINEL.applicationNote, resumeVariantPath: BLOCK_SENTINEL.path },
    favorite: { createdAt: BLOCK_NOW, note: BLOCK_SENTINEL.favoriteNote },
    applicationEvents: [
      { id: 2, applicationId: 1, at: BLOCK_NOW, fromStatus: "interested", toStatus: "applied", note: BLOCK_SENTINEL.eventNote },
      { id: 1, applicationId: 1, at: BLOCK_NOW, fromStatus: null, toStatus: "interested", note: null },
    ],
    visa: { status: "offered", kind: null, checkedAt: BLOCK_NOW, evidence: [{ status: "offered", kind: null, quote: "data pipelines", offset: 15 }] },
    ghost: { level: "likely", score: 8, checkedAt: BLOCK_NOW, dismissed: true, dismissedAt: BLOCK_NOW, dismissedCodes: ["reposted"], reasons: [{ code: "reposted", points: 4, channelId: "fixture", events: [{ oldId: BLOCK_SENTINEL.secret, newId: BLOCK_SENTINEL.path, oldSeen: "2026-08-01", newSeen: "2026-09-01", gapDays: 31 }] }] },
  };
}

export function blockBreakdown(quote = "data pipelines", offset = 15): BreakdownContent {
  const item = { text: "Stored derived text", requirement: "must" as const, quote, offset };
  return {
    responsibilities: [{ text: item.text, quote, offset }],
    tech_stack: [{ name: "Python", category: "languages", requirement: "must", quote, offset }],
    experience: { years_min: 3, years_quote: { quote, offset }, items: [item] },
    projects: [item], soft_skills: [item], other: [item],
    languages: [{ language: "English", level: "C1", requirement: "nice", quote, offset }],
  };
}

export function blockSalary(): SalaryContext {
  const band = { title: "Data Engineer", seniority: "senior", min: 70000, max: 90000, median: 80000, original: { min: null, max: null, median: null, currency: null }, convertible: true, basis: "base" as const, location: "Remote", sources: [0] };
  return {
    state: "ok", currency: "EUR", familyId: "data", familyLabel: BLOCK_SENTINEL.profile, figure: 80000,
    group: { level: "family", seniority: null, place: null, n: 10, median: 80000, quantiles: [70000, 75000, 80000] }, position: { value: 50, clamp: null },
    company: { count: 3, median: 80000, minSample: 3, figures: [70000, 80000, 90000] }, links: [], staleAi: false, benchmarkEnabled: true, benchmarkComputed: true,
    lookup: { availability: "enabled", unrestricted: false, providers: [], initialRequest: null, usedToday: 3, maxPerDay: 4, ttlDays: 10,
      latest: { id: 99, origin: { jobId: 7, title: BLOCK_SENTINEL.profile }, provider: BLOCK_SENTINEL.provider, model: BLOCK_SENTINEL.model, fetchedAt: BLOCK_NOW.toISOString(), expired: true, result: {
        query: { company: BLOCK_SENTINEL.email, title: BLOCK_SENTINEL.path, seniority: BLOCK_SENTINEL.secret, city: null, country: null, currency: "EUR" },
        companyLevel: { level: "market", median: 80000, summary: "Stored salary lookup", sources: [0] }, roleBand: band, relatedRoles: [band],
        sources: [{ url: "https://example.invalid/pay", host: "example.invalid", site: "Salary site", title: "Data salaries", excerpt: "Salary excerpt", trusted: true }], confidence: "medium", notes: "Salary notes", dropped: 1, observations: [],
      } },
    },
  };
}
