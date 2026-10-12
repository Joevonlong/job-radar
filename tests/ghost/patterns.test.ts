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
  ["We are not always hiring, but right now we need a senior engineer.", null],
  ["Talent pool\nWe are hiring one backend engineer for the payments team.", null],
  ["What this role is not\n- a talent pool posting\n- a contract role", null],
  ["What this role is not:\n- a talent pool posting\n- a contract role", null],
  ["Joining our talent community is not required to apply.", null],
  ["Acme is the leading talent community platform for engineers.", null],
  ["We help recruiters turn applicants into the talent pool they need.", null],
  ["Our ATS lets hiring managers add candidates to the talent pipeline.", null],
  ["Our app alerts users about future openings at their favourite companies.", null],
  ["Join our Talent Network team as a Recruiter in Berlin.", null],
  ["We are always recruiting for our internal talent pool, but this role is a concrete opening in Munich.", null],
  ["There are no current openings in our Paris office; this role is based in Berlin.", null],
  ["Not ready to apply? Join our talent community to stay in touch.", null],
  ["Want to hear about new roles?\nJoin our talent community.", null],
  ["We're always looking for people who are passionate about climate.", null],
  ["This role is not for our talent pool.", null],
  ["We are always recruiting for our talent pool.", "always_hiring"],
  ["¿No ves un puesto? Join our talent community.", "talent_pool"],
  // DE
  ["Diese Ausschreibung dient dem Aufbau unseres Talentpools.", "talent_pool"],
  ["Diese Stelle dient nicht dem Aufbau eines Talentpools.", null],
  ["Für unseren Talentpool suchen wir derzeit nicht.", null],
  ["Für unseren Talentpool ist diese Stellenanzeige ganz ausdrücklich nicht gedacht.", null],
  ["Wir suchen ständig nach neuen Wegen, unsere Kunden zu begeistern.", null],
  ["Wir stellen ständig neue Anforderungen an unsere Produkte.", null],
  ["Was wir nicht sind\n- ein Talentpool für zukünftige Stellen\n- eine Zeitarbeitsfirma", null],
  ["Wir bauen eine Plattform für den Talentpool-Aufbau von Mittelständlern.", null],
  ["Die Stelle ist unbefristet und zukünftige Kollegen freuen sich auf dich.", null],
  ["Die Stelle gilt als Sprungbrett für zukünftige Führungsaufgaben.", null],
  ["Diese Stelle ist keine Initiativbewerbung, sondern eine konkrete Vakanz.", null],
  ["Wir sind ein Personaldienstleister und suchen laufend für unsere Kunden.", "always_hiring"],
  ["Wir suchen ständig neue Kolleginnen und Kollegen.", "always_hiring"],
  ["Wir stellen das ganze Jahr über neue Mitarbeitende ein.", "always_hiring"],
  ["Die Ausschreibung richtet sich an zukünftige Vakanzen.", "open_application"],
  ["Noch nicht bereit? Bleib in Kontakt über unseren Talentpool.", null],
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
  // third review round: EN
  ["We are building a talent pool for future roles.", "talent_pool"],
  ["We are building a talent pool.", "talent_pool"],
  ["We're growing our talent community for future openings.", "talent_pool"],
  ["This is an evergreen posting.", "evergreen_posting"],
  ["We accept applications on a rolling basis for upcoming positions.", "future_openings"],
  ["We collect applications for upcoming positions.", "future_openings"],
  ["We are continuously hiring engineers, so feel free to apply at any time.", "always_hiring"],
  ["This posting is for our talent pool, not for a specific team.", "talent_pool"],
  ["This role is for our talent pool for future roles.", "talent_pool"],
  ["We're always hiring, not only engineers but also designers.", "always_hiring"],
  ["This is not only a talent pool posting.", "talent_pool"],
  ["Why join us? We are always hiring.", "always_hiring"],
  ["We are hiring for future roles in Berlin.", "future_openings"],
  ["Evergreen job listings are a core feature of our ATS.", null],
  ["Our platform's talent pool module is used by 500 companies.", null],
  ["Our recruiting software helps employers manage evergreen requisitions.", null],
  ["Always hiring? Acme automates your sourcing.", null],
  ["Is this a talent pool posting?", null],
  ["Benefits\n- Mentoring for future roles in leadership", null],
  ["Benefits\n- Career development for future roles", null],
  ["Experience building a talent pipeline for engineering roles.", null],
  ["You will build and nurture our talent pipeline.", null],
  ["Build our talent pool for future growth.", null],
  ["Help us grow our talent community across Europe.", null],
  ["You will source candidates for upcoming roles.", null],
  ["We are not, as you may assume, building a talent pool.", null],
  // third review round: DE
  ["Wir suchen laufend Verstärkung.", "always_hiring"],
  ["Wir suchen laufend Verstärkung.\nKeine Agentur-Anfragen bitte.", "always_hiring"],
  ["Initiativbewerbung", "open_application_title"],
  ["Initiativbewerbung – Softwareentwickler", "open_application_title"],
  ["Initiativbewerbung für Entwickler (m/w/d)", "open_application_title"],
  ["Dies ist eine Initiativbewerbung.", "open_application"],
  ["Wir sammeln Bewerbungen für zukünftige Vakanzen.", "future_openings"],
  ["Wir stellen kontinuierlich Mitarbeiter ein.", "always_hiring"],
  ["Für unseren Talentpool suchen wir Entwickler, die keine Angst vor neuen Technologien haben.", "talent_pool"],
  ["Wir suchen laufend Verstärkung, nicht nur in Berlin, sondern auch in München.", "always_hiring"],
  ["Wir suchen laufend Verstärkung, die nicht nur programmiert, sondern mitdenkt.", "always_hiring"],
  ["Wir stellen laufend neue Kolleg:innen ein, die nicht lange fackeln.", "always_hiring"],
  ["Wir sind nicht nur immer auf der Suche nach Talenten.", "always_hiring"],
  ["Wir suchen für unseren Talentpool Softwareentwickler für unsere Standorte.", "talent_pool"],
  ["Für unseren Talentpool suchen wir Lösungsarchitekten für SAP.", "talent_pool"],
  ["Für unseren Talentpool suchen wir Entwickler für unsere Software für Logistik.", "talent_pool"],
  ["Wir suchen für unseren Talentpool Entwickler.", "talent_pool"],
  ["Diese Stelle ist für unseren Talentpool, nicht für eine konkrete Vakanz.", "no_specific_opening"],
  ["Was wir bieten\n- Gezielte Weiterbildung für zukünftige Positionen im Konzern", null],
  ["Unsere Software hilft Personalabteilungen beim Aufbau eines Talentpools.", null],
  ["Auf unserem Marktplatz stellen Händler laufend neue Angebote ein.", null],
  ["Unser Vertriebsteam sucht ständig nach neuen Kunden, und du hilfst dabei.", null],
  ["Wir suchen ständig nach neuen Kunden für unsere Software.", null],
  ["Für unseren Talentpool ist diese Anzeige, wie du dir denken kannst, nicht gedacht.", null],
  ["Diese Ausschreibung dient, wie du siehst, nicht dem Aufbau eines Talentpools.", null],
  ["Wir bauen eine Plattform für Talentpools.", null],
  ["Initiativbewerbung: Keine passende Stelle gefunden? Bewirb dich initiativ.", null],
  // talent pool with words in between, only with recruiting context in the sentence; "for our future …"
  ["By joining our AI talent pool, you will be contacted as a priority for our future opportunities in the following areas:", "talent_pool_join"],
  ["Join our engineering talent community to apply for future roles.", "talent_pool_join"],
  ["Apply now and join our growing tech talent network.", "talent_pool_join"],
  ["Send us your CV for our data talent pool.", "talent_pool_join"],
  ["Submit your CV to join our global talent pool.", "talent_pool"],
  ["We collect applications for our future openings.", "future_openings"],
  ["We hire on a rolling basis for our upcoming positions.", "future_openings"],
  ["Joining our AI talent pool is not a commitment; you can still apply to open roles.", null],
  ["Berlin offers access to the largest tech talent pool in Europe.", null],
  ["Tap into a diverse global talent pool.", null],
  ["Berlin is home to a deep engineering talent pool.", null],
  ["You will mentor juniors in our internal talent community.", null],
  ["Organize events for our engineering talent community.", null],
  ["We run workshops for our internal talent community.", null],
  ["Contribute to our engineering talent pipeline.", null],
  ["Contribute to our engineering talent pool.", null],
  ["Organize events for our engineering talent community and source candidates for open roles.", null],
  ["We host meetups for our local talent community; candidates of all levels are welcome.", null],
  ["Join our team and grow with our engineering talent community.", null],
  ["Join our engineering talent community.", null],
  ["You will source candidates for our upcoming roles.", null],
  ["You'll recruit engineers for our future openings.", null],
  ["You will source candidates for our engineering talent pool.", null],
  ["Source candidates for our engineering talent pool and run interviews.", null],
  ["Mentoring for our future roles in leadership.", null],
  ["Training for our upcoming positions.", null],
  ["Career development for our future roles", null],
  // a list under a duties heading that the segmenter does not see as one ("?" heading, emoji, "&amp;", blank line)
  ["What awaits you?\n- Coordinate interviews for upcoming positions.", null],
  ["What will I be doing?\n\n- Run interviews.\n- Coordinate interviews for upcoming positions.", null],
  ["🛠️ About the role:\n- Coordinate interviews for upcoming positions.", null],
  ["THE ROLE &amp; THE TEAM\n- Coordinate interviews for upcoming positions.", null],
  ["Welche Aufgaben erwarten dich?\n- Aufbau unseres Talentpools für zukünftige Stellen", null],
  // … but not under a question or heading that is not about the duties
  ["Ready to join us?\n- We are always hiring.", "always_hiring"],
  ["Why join us?\n- We are always hiring great people.", "always_hiring"],
  ["Ready to take on new responsibilities?\n- We collect applications for upcoming positions.", "future_openings"],
  ["Bereit für mehr?\n- Wir stellen laufend ein.", "always_hiring"],
  ["Warum wir?\n- Wir suchen ständig neue Kolleginnen und Kollegen.", "always_hiring"],
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

  it("the talent pool posting with words in between: exact quote, offset and pattern", () => {
    const sentence = "By joining our AI talent pool, you will be contacted as a priority for our future opportunities in the following areas:";
    const jd = `Are you passionate about AI? We build software for clinics.\n\nWe use AI across our products.\n\n${sentence}\n\nThe areas we are looking for:\n- ML engineering\n- NLP`;
    const found = evergreenWording(jd, rules);
    expect(found).toEqual({ code: "evergreen_wording", points: rules.settings.evergreen_wording.points, patternId: "talent_pool_join", quote: sentence, offset: jd.indexOf(sentence) });
    // each of the two widened patterns finds it on its own
    const only = (id: string) => ({ ...rules, evergreen: rules.evergreen.filter((pattern) => pattern.id === id) });
    expect(evergreenWording(jd, only("talent_pool_join"))).toMatchObject({ patternId: "talent_pool_join", quote: sentence, offset: jd.indexOf(sentence) });
    expect(evergreenWording(jd, only("future_openings"))).toMatchObject({ patternId: "future_openings", quote: sentence, offset: jd.indexOf(sentence) });
    // and neither did before: the original talent_pool phrase does not take "AI" in between
    expect(evergreenWording(jd, only("talent_pool"))).toBeNull();
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

  it("negation_after: clause searches to the end of the clause, words only negation_words_after words", () => {
    const sentence = "Our talent pool is one we will here very clearly not use; it is a real role.";
    expect(evergreenWording(sentence, rulesWith((s) => (s.negation_words_after = 3), pack))?.patternId).toBe("pool");
    expect(evergreenWording(sentence, rulesWith((s) => (s.negation_words_after = 3), { ...pack, negation_after: "clause" }))).toBeNull();
    // an entry's own setting wins over its pack's; the clause ends at a clause break
    const entry = { ...pack, evergreen_patterns: [{ ...pack.evergreen_patterns[0]!, negation_after: "clause" as const }], clause_breaks: [";"] };
    expect(evergreenWording(sentence, rulesWith((s) => (s.negation_words_after = 3), entry))).toBeNull();
    expect(evergreenWording("Our talent pool; it is not a fake.", rulesWith(() => {}, entry))?.patternId).toBe("pool");
  });

  it("lead_in_question: the question marks, where the question starts and the line above come from the pack", () => {
    const footer = { ...pack, exclude_context: ["missing a role"] };
    const lead = (over: Partial<{ ends: string[]; starts: string[]; line_above: boolean }>) => ({ ...footer, lead_in_question: { ends: ["?"], starts: ["."], line_above: true, ...over } });
    expect(evergreenWording("Missing a role? Our talent pool.", rulesWith(() => {}, lead({})))).toBeNull();
    expect(evergreenWording("Missing a role? Our talent pool.", rulesWith(() => {}, lead({ ends: [] })))?.patternId).toBe("pool");
    // (a short line without end punctuation is a heading read with the next line: heading_max_chars 5 keeps them apart)
    const noHeadings = (s: { heading_max_chars: number }) => (s.heading_max_chars = 5);
    expect(evergreenWording("Missing a role？\nOur talent pool.", rulesWith(noHeadings, lead({})))?.patternId).toBe("pool");
    expect(evergreenWording("Missing a role？\nOur talent pool.", rulesWith(noHeadings, lead({ ends: ["?", "？"] })))).toBeNull();
    expect(evergreenWording("Missing a role?\nOur talent pool.", rulesWith(() => {}, lead({ line_above: false })))?.patternId).toBe("pool");
    expect(evergreenWording("Missing a role?\nOur talent pool.", rulesWith(() => {}, lead({})))).toBeNull();
    // the question starts after the last start mark: "Missing a role" is not in "Hi. Got one?"
    expect(evergreenWording("Missing a role. Got one? Our talent pool.", rulesWith(() => {}, lead({})))?.patternId).toBe("pool");
    // a sentence that is itself a question does not count; which marks end a question comes from the pack
    expect(evergreenWording("Our talent pool?", rulesWith(() => {}, lead({})))).toBeNull();
    expect(evergreenWording("Our talent pool?", rulesWith(() => {}, lead({ ends: [] })))?.patternId).toBe("pool");
  });

  it("requires_context: a hit counts only when its piece also matches one of the entry's patterns", () => {
    const entry = { id: "pool", pattern: "talent pool", check_negation: true };
    const plain = rulesWith(() => {}, { ...pack, evergreen_patterns: [entry] });
    const strict = rulesWith(() => {}, { ...pack, evergreen_patterns: [{ ...entry, requires_context: ["apply"] }] });
    expect(evergreenWording("Our talent pool.", plain)?.patternId).toBe("pool");
    expect(evergreenWording("Our talent pool.", strict)).toBeNull();
    expect(evergreenWording("Our talent pool. Apply now.", strict)).toBeNull();
    expect(evergreenWording("Apply to our talent pool.", strict)?.patternId).toBe("pool");
    expect(() => rulesWith(() => {}, { ...pack, evergreen_patterns: [{ ...entry, requires_context: ["(unclosed"] }] })).toThrow("ghost.evergreen_patterns[0].requires_context[0]");
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
