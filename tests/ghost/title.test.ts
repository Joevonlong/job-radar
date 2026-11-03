// @vitest-environment node
import { describe, expect, it } from "vitest";

import { slowPatternReason } from "@/lib/config/schemas/common";
import { evaluateGhost } from "@/lib/ghost/evaluate";
import { evergreenTitle } from "@/lib/ghost/signals";
import { buildGhostCheckView, ghostReasonMessage, ghostShortMessage } from "@/lib/ghost/view";
import { ghostReasonListSchema, type GhostReason } from "@/lib/ghost/types";
import { mergeGhostPacks } from "@/lib/market/effective";
import { ghostPackSchema } from "@/lib/market/schema";

import { fixturePack } from "../pipeline/helpers";
import { FULL_JD, fixtureRules, input, NOW, daysAgo, posting, rulesWith } from "./helpers";

const rules = fixtureRules();
const hit = (title: string) => evergreenTitle(title, rules);

describe("title patterns", () => {
  it.each([
    "General Application - AI Engineer",
    "AI Engineer - Open Application",
    "Open Application (m/f/d)",
    "Talent Pool - Senior Engineer",
    "Initiativbewerbung",
    "Initiativbewerbung (m/w/d)",
    "Initiativbewerbung – Softwareentwickler",
    "Staff Engineer - Talentpool (m/f/d)",
    "Bewerberpool Entwicklung",
    "Candidature spontanée - Theodo Data & AI",
    "Evergreen - AI Engineer, AI FDE",
    "Senior Hardware Developer (m/w/d) - Talentpool",
    "AI Talent Pool",
    "Future Opportunities - Engineering",
    "Spontaneous Application for Engineers",
    "Candidatura espontánea",
    "Open sollicitatie",
    "Sales [Open Application]",
  ])("%s", (title) => {
    expect(hit(title)).not.toBeNull();
  });

  it.each([
    "AI Builder, Emerging Talent",
    "Manager, Talent & Workforce Analytics",
    "Community Engineer",
    "Event & Community Manager",
    "AI Application Engineer",
    "Field Application Engineer",
    "Open Application Security Engineer",
    "Open Application Architect",
    "General Application Support",
    "Talent Pool Manager (m/w/d)",
    "Recruiter - Talent Community",
    "Talent Acquisition Partner",
    "Evergreen Energy Analyst",
    "Senior Software Engineer AI Initiatives (m/w/d)",
    "Head of Talent Community",
    "Manager, Talent Pool",
    "AI Trainers Network - Arabic",
    "Forward Deployed Engineer | Tekkr FDE Network",
    "MINT-Talente (m/w/d) für KI",
    "Talentpoolmanager",
    "Leitung Talentpool (m/w/d)",
    "Recruiting Partner - Talentpool",
  ])("%s has no hit", (title) => {
    expect(hit(title)).toBeNull();
  });

  it("keeps the evidence of the pattern, the title and the points", () => {
    expect(hit("Staff Engineer - Talentpool (m/f/d)")).toEqual({
      code: "evergreen_wording",
      points: 3,
      patternId: "talent_pool_title",
      quote: "Staff Engineer - Talentpool (m/f/d)",
      offset: 0,
      field: "title",
    });
  });

  it("quotes the hit of a long title, verbatim and without cutting a surrogate pair", () => {
    const front = "😀".repeat(400);
    const title = `${front} Open Application ${"x ".repeat(300)}`;
    const reason = evergreenTitle(`${front} - Open Application`, rules);
    expect(reason).not.toBeNull();
    const long = reason as Extract<GhostReason, { code: "evergreen_wording" }>;
    expect(long.quote).toContain("Open Application");
    expect(long.quote.length).toBeLessThanOrEqual(rules.settings.quote_max_chars);
    expect(`${front} - Open Application`.slice(long.offset, long.offset + long.quote.length)).toBe(long.quote);
    expect(long.quote).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    expect(JSON.stringify(long)).not.toMatch(/\\ud[89a-f]/iu);
    expect(hit(title)).toBeNull(); // the phrase is followed by more words: not the whole part
  });

  it("is off with title_points 0 or when the check word is disabled", () => {
    const off = rulesWith((s) => (s.evergreen_wording.title_points = 0), fixturePackGhost());
    expect(evergreenTitle("Open Application", off)).toBeNull();
    const disabled = rulesWith((s) => (s.evergreen_wording.enabled = false), fixturePackGhost());
    expect(evergreenTitle("Open Application", disabled)).toBeNull();
  });

  it("every title pattern passes the slow pattern check", () => {
    const pack = mergeGhostPacks([fixturePack("generic"), fixturePack("de")]);
    for (const entry of pack.title_patterns) expect(slowPatternReason(entry.pattern), entry.id).toBeNull();
    for (const source of pack.title_exclude) expect(slowPatternReason(source), source).toBeNull();
  });

  it("a pack without title keys parses, and a bad pattern names its path", () => {
    expect(ghostPackSchema.parse({}).title_patterns).toEqual([]);
    expect(() => rulesWith(() => {}, { title_patterns: [{ id: "bad", pattern: "(" }] })).toThrow(/ghost\.title_patterns\[0\]/u);
    expect(() => rulesWith(() => {}, { title_exclude: ["["] })).toThrow(/ghost\.title_exclude\[0\]/u);
  });
});

function fixturePackGhost() {
  return mergeGhostPacks([fixturePack("generic"), fixturePack("de")]);
}

describe("title in the verdict", () => {
  const jd = `Join our talent pool: we collect applications for future openings.\n\n${FULL_JD}`;

  it("counts once, with the title's points, when the JD says it too", () => {
    const result = evaluateGhost(input({ title: "AI Talent Pool", description: jd }), rules, NOW);
    const evergreen = result.reasons.filter((r) => r.code === "evergreen_wording");
    expect(evergreen).toHaveLength(1);
    expect(evergreen[0]).toMatchObject({ field: "title", points: 3 });
    expect(result.score).toBe(3);
    expect(result.level).toBe("watch");
  });

  it("falls back to the JD, without a field, when the title says nothing", () => {
    const result = evaluateGhost(input({ title: "AI Engineer", description: jd }), rules, NOW);
    const evergreen = result.reasons.find((r) => r.code === "evergreen_wording");
    expect(evergreen).toBeDefined();
    expect(evergreen).not.toHaveProperty("field");
    expect(evergreen?.points).toBe(2);
  });

  it("the five production titles: scores and levels", () => {
    const watch = [
      "Staff Engineer - Talentpool (m/f/d)",
      "Senior Hardware Developer (m/w/d) - Talentpool",
      "Candidature spontanée - Theodo Data & AI",
      "Evergreen - AI Engineer, AI FDE",
    ];
    for (const title of watch) {
      const result = evaluateGhost(input({ title }), rules, NOW);
      expect([title, result.level, result.score]).toEqual([title, "watch", 3]);
    }
    // a job with 3 points of other reasons (a short JD, a repost label, 100 days open): 5 on the JD alone, 6 with the title
    const others = { description: "Join our talent pool: we collect applications for future openings.", postings: [posting({ repostLabel: "Reposted" })], trustedPostedAt: { at: daysAgo(100), channelId: "greenhouse" } };
    const jdOnly = evaluateGhost(input({ title: "AI Engineer", ...others }), rules, NOW);
    const doctolib = evaluateGhost(input({ title: "AI Talent Pool", ...others }), rules, NOW);
    expect([jdOnly.level, jdOnly.score]).toEqual(["likely", 5]);
    expect([doctolib.level, doctolib.score]).toEqual(["likely", 6]);
  });

  it("a trusted company is never flagged", () => {
    expect(evaluateGhost(input({ title: "AI Talent Pool", trustedCompany: true }), rules, NOW).reasons).toEqual([]);
  });
});

describe("title evidence on the pages", () => {
  const reason: GhostReason = { code: "evergreen_wording", points: 3, patternId: "talent_pool_title", quote: "AI Talent Pool", offset: 0, field: "title" };
  const detail = (reasons: GhostReason[]) => ({ level: "watch" as const, score: 3, reasons, checkedAt: NOW, dismissedAt: null, dismissedCodes: null, dismissed: false });

  it("has its own messages and no JD quote", () => {
    expect(ghostReasonMessage(reason)).toEqual({ key: "reason.evergreen_title", values: { quote: "AI Talent Pool" } });
    expect(ghostShortMessage(reason)).toEqual({ key: "short.evergreen_title", values: {} });
    expect(buildGhostCheckView(detail([reason])).quote).toBeNull();
  });

  it("a stored reason without a field is the JD's", () => {
    const stored = ghostReasonListSchema.parse([{ code: "evergreen_wording", points: 2, patternId: "talent_pool", quote: "our talent pool", offset: 4 }]);
    const first = stored[0] as GhostReason;
    expect(ghostReasonMessage(first).key).toBe("reason.evergreen_wording");
    expect(ghostShortMessage(first).key).toBe("short.evergreen_wording");
    expect(buildGhostCheckView(detail(stored)).quote).toBe("our talent pool");
  });

  it("the stored title reason parses", () => {
    expect(ghostReasonListSchema.parse([reason])).toEqual([reason]);
  });
});
