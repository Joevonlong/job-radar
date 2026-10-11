// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evergreenWording } from "@/lib/ghost/signals";

import { fixtureRules, rulesWith } from "./helpers";

/**
 * Adversarial sentences against the fixture packs (generic + de): which evergreen pattern counts, or null. The fixture packs are a
 * copy of the shipped ones' ghost section; nothing here reads config/.
 */
const CASES: ReadonlyArray<readonly [string, string | null]> = [
  // EN
  ["This posting is for our talent pool.", "talent_pool"],
  ["This is not a talent pool posting; we are hiring for one specific team.", null],
  ["We are hiring for a specific role in our Berlin office. Not a talent pool posting.", null],
  ["We are building talent pool software for HR teams.", null],
  ["Our platform helps companies grow their talent pipelines.", null],
  ["You will build and nurture our talent pipeline.", null],
  ["Your tasks:\n- Build our talent pool\n- Run interviews", null],
  ["Don't see a role that fits? Join our talent community.", null],
  ["Don't see a role that fits?\nJoin our talent community.", null],
  ["Your application may also be considered for future roles.", null],
  ["If there is no open role right now, we keep your CV.", null],
  ["We are always hiring great people.", "always_hiring"],
  ["We are always looking for engineers who love Rust.", null],
  ["There is no current opening, but we collect applications for future openings.", "no_specific_opening"],
  ["This is an evergreen role.", "evergreen_posting"],
  ["Talent pool\nThis posting is not for a specific opening.", "no_specific_opening"],
  // DE
  ["Diese Ausschreibung dient dem Aufbau unseres Talentpools.", "open_application"],
  ["Dies ist keine Ausschreibung für unseren Talentpool, sondern eine konkrete Stelle im Team Data.", null],
  ["Wir helfen Unternehmen beim Aufbau ihres Talentpools.", null],
  ["Du bist verantwortlich für den Aufbau unseres Talentpools.", null],
  ["Keine passende Stelle dabei? Dann bewirb dich initiativ für unseren Talentpool.", null],
  ["Gerne berücksichtigen wir deine Bewerbung auch für zukünftige Stellen.", null],
  ["Wir suchen laufend nach Möglichkeiten, unsere Prozesse zu verbessern.", null],
  ["Wir stellen laufend ein.", "always_hiring"],
  ["Wir sind immer auf der Suche nach motivierten Menschen.", "always_hiring"],
  ["Es gibt keine konkrete Stelle, wir sammeln Bewerbungen für zukünftige Stellen.", "no_specific_opening"],
  ["Initiativbewerbung (m/w/d)", "open_application_title"],
];

describe("evergreen_wording against the fixture packs", () => {
  const rules = fixtureRules();
  const unfiltered = { ...rules, prefilter: null };

  it.each(CASES)("%j → %s", (sentence, expected) => {
    const found = evergreenWording(sentence, rules);
    expect(found?.patternId ?? null).toBe(expected);
    // the prefilter only makes it faster: the same verdict without it
    expect(evergreenWording(sentence, unfiltered)?.patternId ?? null).toBe(expected);
    // C7: the quote is the description at its offset
    if (found) expect(sentence.slice(found.offset, found.offset + found.quote.length)).toBe(found.quote);
  });

  it("every evergreen pattern passes the packs' prefilter", () => {
    expect(rules.prefilterViolations).toEqual([]);
  });

  it("quotes the sentence inside a longer JD at its offset", () => {
    const jd = "About us\nWe ship logistics software.\n\nWhat we offer\nGood pay. This posting is for our talent pool. Apply now.";
    const found = evergreenWording(jd, rules);
    expect(found).toMatchObject({ patternId: "talent_pool", quote: "This posting is for our talent pool." });
    expect(jd.slice(found?.offset, (found?.offset ?? 0) + (found?.quote.length ?? 0))).toBe(found?.quote);
  });

  it("skips hits the caller hides (AI trap ranges)", () => {
    const jd = "This posting is for our talent pool.";
    expect(evergreenWording(jd, rules, { skip: () => true })).toBeNull();
  });
});

describe("evergreen_wording reads its words and limits from the config", () => {
  const pack = { evergreen_patterns: [{ id: "pool", pattern: "talent pool", check_negation: true }], negation_cues: ["not"], prefilter: ["talent"] };

  it("a negation cue after the phrase within negation_words_after", () => {
    const near = rulesWith((s) => (s.negation_words_after = 5), pack);
    expect(evergreenWording("A talent pool it is not.", near)).toBeNull();
    const off = rulesWith((s) => (s.negation_words_after = 0), pack);
    expect(evergreenWording("A talent pool it is not.", off)?.patternId).toBe("pool");
  });

  it("a negative list heading cancels its items", () => {
    const rules = rulesWith(() => {}, pack);
    expect(evergreenWording("This is not:\n- a talent pool\n- a fake role", rules)).toBeNull();
  });

  it("off, or zero points: no reason", () => {
    expect(evergreenWording("Our talent pool.", rulesWith((s) => (s.evergreen_wording.enabled = false), pack))).toBeNull();
    expect(evergreenWording("Our talent pool.", rulesWith((s) => (s.evergreen_wording.points = 0), pack))).toBeNull();
    expect(evergreenWording("Our talent pool.", rulesWith((s) => (s.evergreen_wording.points = 4), pack))?.points).toBe(4);
  });

  it("clips the quote to quote_max_chars, still verbatim", () => {
    const long = `${"Word ".repeat(120)}and this is our talent pool ${"word ".repeat(120)}end.`;
    const found = evergreenWording(long, rulesWith((s) => (s.quote_max_chars = 80), pack));
    expect(found?.quote.length).toBeLessThanOrEqual(80);
    expect(found?.quote).toContain("talent pool");
    expect(long.slice(found?.offset, (found?.offset ?? 0) + (found?.quote.length ?? 0))).toBe(found?.quote);
  });
});
