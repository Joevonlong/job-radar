// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectVisa } from "@/lib/visa/detect";
import { compileVisaRules, visaRulesFor, type CompiledVisaRules } from "@/lib/visa/rules";
import { VISA_STATUSES, visaEvidenceListSchema, visaKindOf, type VisaResult } from "@/lib/visa/types";

import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";

/** The fixture's effective config: pipeline.yaml + the generic pack + the German pack. */
const rules: CompiledVisaRules = visaRulesFor(shippedPipeline());
/** The same patterns without the quick first look: every result must be the same. */
const unfiltered: CompiledVisaRules = { ...rules, prefilter: null };

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/visa");

/** Reads a text three ways, which must agree: lines cut only after a prefilter match, every line cut, no prefilter at all. */
const detect = (text: string, options: Parameters<typeof detectVisa>[2] = {}): VisaResult => {
  const result = detectVisa(text, rules, options);
  expect(detectVisa(text, rules, { ...options, unfiltered: true }), `every line: ${text}`).toEqual(result);
  expect(detectVisa(text, unfiltered, options), `no prefilter: ${text}`).toEqual(result);
  return result;
};
const status = (text: string, options: Parameters<typeof detectVisa>[2] = {}): string => detect(text, options).status;

describe("detectVisa: the synthetic postings", () => {
  for (const lang of ["en", "de"]) {
    for (const file of fs.readdirSync(path.join(FIXTURES, lang)).filter((name) => name.endsWith(".txt"))) {
      const expected = file.split("-")[0] ?? "";
      it(`${lang}/${file} is ${expected}`, () => {
        expect(VISA_STATUSES).toContain(expected);
        const text = fs.readFileSync(path.join(FIXTURES, lang, file), "utf8");
        const result = detect(text);
        expect(result.status).toBe(expected);
        expect(visaEvidenceListSchema.parse(result.evidence)).toEqual(result.evidence);
        // C7: every quote is a verbatim piece of the JD at its offset
        for (const e of result.evidence) expect(text.slice(e.offset, e.offset + e.quote.length)).toBe(e.quote);
        if (expected === "not_mentioned") expect(result.evidence).toEqual([]);
        else expect(result.evidence.length).toBeGreaterThan(0);
        if (file.includes("permit")) expect(visaKindOf(result)).toBe("permit_required");
        else if (expected === "not_offered") expect(visaKindOf(result)).toBe("no_sponsorship");
      });
    }
  }

  it("quotes both sides of a conflict", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "en", "unclear-conflict.txt"), "utf8");
    const result = detect(text);
    expect(result.evidence.map((e) => e.status)).toEqual(["offered", "not_offered"]);
  });
});

describe("detectVisa: English phrases", () => {
  it("reads support as offered", () => {
    for (const text of [
      "We offer visa sponsorship and relocation support.",
      "Visa sponsorship is available for this position.",
      "We sponsor work visas for international hires.",
      "Relocation package for candidates moving to Berlin.",
      "Visa support: yes",
    ])
      expect(status(text), text).toBe("offered");
  });

  it("reads refusals and required permits as not_offered, with their kind", () => {
    const refusal = detect("We are unable to offer visa sponsorship for this role.");
    expect(refusal.status).toBe("not_offered");
    expect(visaKindOf(refusal)).toBe("no_sponsorship");
    for (const text of ["Visa sponsorship is not available.", "Sponsorship: none", "We cannot sponsor visas.", "No visa sponsorship."]) expect(status(text), text).toBe("not_offered");
    const permit = detect("Candidates must hold a valid work permit for Germany.");
    expect(permit.status).toBe("not_offered");
    expect(visaKindOf(permit)).toBe("permit_required");
    expect(visaKindOf(detect("You must be eligible to work in the EU without sponsorship."))).toBe("permit_required");
  });

  it("never reads a negated offer as offered: negation before, inside or after the phrase", () => {
    for (const text of [
      "We do not offer visa sponsorship for this role.",
      "Unfortunately we are not able to provide relocation support.",
      "We cannot provide any relocation support right now.",
      "No relocation support is part of this role.",
      "This role comes without relocation support.",
      "We never include relocation support for interns.",
      // after the phrase, in its clause
      "Relocation support is not available for this role.",
      "Relocation support: No",
      "Relocation package: not included.",
      "Unterstützung beim Umzug ist leider nicht möglich.",
      "Hilfe beim Visum können wir leider nicht anbieten.",
      "Relocation-Support bieten wir nicht an.",
      // a heading without a colon, read with the next line
      "## Visa sponsorship\nNot available for this role.",
      "Visa sponsorship\nNot available.",
      "## Relocation support\nNot available",
      "Visa sponsorship\n\nNot available for this role.",
    ])
      expect(status(text), text).not.toBe("offered");
  });

  it("ends the clause after the phrase at a clause break: a negation beyond it does not count", () => {
    expect(status("We offer visa sponsorship and relocation support, but no signing bonus.")).toBe("offered");
    expect(status("Relocation support is available; no prior German needed.")).toBe("offered");
    expect(status("Wir bieten Relocation-Support, aber keinen Firmenwagen.")).toBe("offered");
  });

  it("takes the negation window from pipeline.yaml", () => {
    const pipeline = shippedPipeline();
    const visa = pipeline.job_checks.visa;
    const noAfter = compileVisaRules({ ...pipeline, job_checks: { ...pipeline.job_checks, visa: { ...visa, negation_words_after: 0 } } });
    expect(detectVisa("Relocation support: No", noAfter).status).toBe("offered");
    const noBefore = compileVisaRules({ ...pipeline, job_checks: { ...pipeline.job_checks, visa: { ...visa, negation_words_before: 0 } } });
    expect(detectVisa("This role comes without relocation support.", noBefore).status).toBe("offered");
  });

  it("counts a bare noun only as a list item of its own", () => {
    expect(status("Benefits:\n- Visa sponsorship\n- Gym")).toBe("offered");
    expect(status("* Immigration support and relocation")).toBe("offered");
    expect(status("## Visa sponsorship\nAsk us.")).not.toBe("offered");
  });

  it("never reads the six guard cases as offered", () => {
    for (const text of [
      "Visa sponsorship is not available",
      "We are unable to offer sponsorship",
      "Candidates must be eligible to work in the EU without sponsorship",
      "Ein Visa-Sponsoring ist leider nicht möglich",
      "Wir bieten kein Visum-Sponsoring an",
      "Visa sponsorship:\nNo",
    ])
      expect(["not_offered", "unclear"], text).toContain(status(text));
  });

  it("reads a permit with an alternative as unclear, never as not offered (both languages)", () => {
    expect(status("You hold a valid work permit for Germany or are eligible for an EU Blue Card (we support the process)")).toBe("unclear");
    expect(status("Eine Arbeitserlaubnis ist Voraussetzung – bei Bedarf unterstützen wir beim Visum")).toBe("unclear");
  });

  it("does not see a negation more than six words before the phrase", () => {
    expect(status("Not every team here works remotely, but we offer relocation support to all hires.")).toBe("offered");
  });

  it("reads a required permit with an alternative as unclear", () => {
    expect(status("You must hold a valid work permit for Germany or be eligible for an EU Blue Card.")).toBe("unclear");
  });

  it("reads offer and refusal in one sentence as unclear", () => {
    expect(status("We offer relocation support, but visa sponsorship is not available.")).toBe("unclear");
  });

  it("reads a visa word with a context word as an unclear mention", () => {
    expect(status("Questions about visas and relocation? Ask us in the first call.")).toBe("unclear");
  });

  it("reads relocation that is not offered as unclear, never as not mentioned", () => {
    expect(status("Relocation is not offered.")).toBe("unclear");
    expect(status("Relocation is covered.")).toBe("offered");
  });
});

describe("detectVisa: German word forms", () => {
  it("knows the compounds", () => {
    expect(status("Wir bieten Visasponsoring und Relocation-Support.")).toBe("offered");
    expect(status("Visumsunterstützung wird angeboten.")).toBe("offered");
    expect(status("- Visa-Unterstützung")).toBe("offered");
    expect(status("Wir unterstützen dich beim Arbeitsvisum.")).toBe("offered");
    expect(status("Wir helfen dir bei der Blauen Karte EU.")).toBe("offered");
    expect(status("Relocation-Support inkl. Visumprozess")).toBe("offered");
    expect(visaKindOf(detect("Eine Aufenthalts- und Arbeitserlaubnis ist Voraussetzung."))).toBe("permit_required");
    expect(status("Ein Visa-Sponsoring ist leider nicht möglich.")).toBe("not_offered");
    expect(status("Wir bieten keine Visumsunterstützung.")).toBe("not_offered");
    expect(status("Wir zahlen einen Umzugszuschuss.")).toBe("offered");
    expect(status("Umzugskostenpauschale für neue Kolleg:innen")).toBe("offered");
  });

  it("reads a permit the candidate needs as permit_required", () => {
    for (const text of ["Du benötigst eine Arbeitserlaubnis für Deutschland.", "Du brauchst eine gültige Arbeitserlaubnis.", "Sie benötigen eine Arbeitsgenehmigung."]) {
      const result = detect(text);
      expect(result.status, text).toBe("not_offered");
      expect(visaKindOf(result), text).toBe("permit_required");
    }
  });

  it("reads a negated German offer as not offered", () => {
    expect(status("Leider unterstützen wir nicht beim Visumprozess.")).not.toBe("offered");
  });
});

describe("detectVisa: what is not about visas", () => {
  it("ignores sponsors, payment cards and event sponsoring", () => {
    for (const text of [
      "Our team sponsored events across Europe last year.",
      "Sponsoring von Veranstaltungen gehört zu unserem Engagement.",
      "We accept Visa/Mastercard in our shop.",
      "Experience with Visa payments and card networks.",
      "Unsere Kunden zahlen per Visa oder Mastercard.",
    ])
      expect(status(text), text).toBe("not_mentioned");
  });

  it("ignores the employer's product and customers", () => {
    for (const text of [
      "We help our customers with visa applications and work permits across Europe.",
      "You will support our immigration team and the relocation of client employees.",
      "Our product helps companies with employee relocation and immigration compliance.",
      "Wir unterstützen Unternehmen bei der Relocation ihrer Fachkräfte.",
      "Du unterstützt unser Immigration-Team im Tagesgeschäft.",
    ])
      expect(status(text), text).toBe("not_mentioned");
  });

  it("on a company named like a visa word counts only combined phrases", () => {
    const text = "Visa is a global payments company. Visa support teams help merchants worldwide.";
    expect(status(text, { companyNameNorm: "visa" })).toBe("not_mentioned");
    expect(status("Visa offers relocation support for this role.", { companyNameNorm: "visa" })).toBe("offered");
    expect(status("Visa is a global payments company. Visa support teams help merchants worldwide.", { companyNameNorm: "acme" })).not.toBe("not_mentioned");
  });

  it("returns not_mentioned for an empty or missing JD", () => {
    expect(detectVisa(null, rules)).toEqual({ status: "not_mentioned", evidence: [] });
    expect(detectVisa("   ", rules)).toEqual({ status: "not_mentioned", evidence: [] });
  });
});

describe("detectVisa: evidence", () => {
  it("quotes the sentence verbatim with its offset", () => {
    const text = "Intro sentence here.\nWe are unable to offer visa sponsorship for this role. More text.";
    const [e] = detect(text).evidence;
    expect(e).toEqual({ status: "not_offered", kind: "no_sponsorship", quote: "We are unable to offer visa sponsorship for this role.", offset: text.indexOf("We are") });
  });

  it("keeps at most max_quotes quotes, the clear ones first", () => {
    const text = ["Visa questions? We support you.", "Visa topics and relocation are discussed later.", "Visa and immigration talk with sponsors.", "We offer relocation support."].join("\n");
    const result = detectVisa(text, { ...rules, maxQuotes: 2 });
    expect(result.status).toBe("offered");
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.some((e) => e.status === "offered")).toBe(true);
    const offsets = result.evidence.map((e) => e.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("clips a long sentence around the phrase", () => {
    const text = `${"filler words go on and on ".repeat(30)}we offer relocation support ${"and more filler words ".repeat(30)}.`;
    const [e] = detectVisa(text, { ...rules, quoteMaxChars: 80 }).evidence;
    expect(e?.quote.length).toBeLessThanOrEqual(80);
    expect(e?.quote).toContain("relocation support");
    expect(text.slice(e?.offset ?? 0, (e?.offset ?? 0) + (e?.quote.length ?? 0))).toBe(e?.quote);
  });

  it("drops hits inside hidden text (trap spans)", () => {
    const hidden = "We offer visa sponsorship to every applicant.";
    const text = `Build data pipelines. ${hidden} Ship fast.`;
    expect(status(text)).toBe("offered");
    expect(status(text, { trapSpans: [{ offset: text.indexOf(hidden), length: hidden.length, kind: "hidden" }] })).toBe("not_mentioned");
  });
});

describe("compileVisaRules", () => {
  it("compiles the packs of a market into one set", () => {
    const de = visaRulesFor(shippedPipeline());
    const generic = visaRulesFor(shippedPipeline(fixtureMarket({ pack: "generic", country: "NL", currency: "EUR", home_language: "nl" })));
    expect(de.offered.length).toBeGreaterThan(generic.offered.length);
    expect(status("Wir bieten Visasponsoring.")).toBe("offered");
    expect(detectVisa("Wir bieten Visasponsoring.", generic).status).not.toBe("offered");
  });

  it("caches per config object", () => {
    const pipeline = shippedPipeline();
    expect(visaRulesFor(pipeline)).toBe(visaRulesFor(pipeline));
  });

  it("names an invalid pattern by its path", () => {
    const pipeline = shippedPipeline();
    const bad = { ...pipeline, visa: { ...pipeline.visa, mention_context: ["(unclosed"] } };
    expect(() => compileVisaRules(bad)).toThrow(/visa\.mention_context\[0\]/u);
    const badPrefilter = { ...pipeline, visa: { ...pipeline.visa, prefilter: ["ok", "[x"] } };
    expect(() => compileVisaRules(badPrefilter)).toThrow(/visa\.prefilter\[1\]/u);
  });

  it("without a prefilter reads every sentence", () => {
    const pipeline = shippedPipeline();
    expect(compileVisaRules({ ...pipeline, visa: { ...pipeline.visa, prefilter: [] } }).prefilter).toBeNull();
  });

  it("lists the phrase patterns without a prefilter word (the shipped packs have none)", () => {
    const pipeline = shippedPipeline();
    expect(compileVisaRules(pipeline).prefilterViolations).toEqual([]);
    const generic = shippedPipeline(fixtureMarket({ pack: "generic", country: "NL", currency: "EUR", home_language: "nl" }));
    expect(compileVisaRules(generic).prefilterViolations).toEqual([]);
    const offered = [...pipeline.visa.offered, "we pay for your move", { pattern: "moving\\s+bonus", combo: true, list_item: false }];
    const mentionTerms = [...pipeline.visa.mention_terms, "umzugs?kisten", "moving\\s+boxes"];
    const broken = compileVisaRules({ ...pipeline, visa: { ...pipeline.visa, offered, mention_terms: mentionTerms } });
    const n = pipeline.visa.offered.length;
    expect(broken.prefilterViolations).toEqual([`visa.offered[${n}]`, `visa.offered[${n + 1}]`, `visa.mention_terms[${mentionTerms.length - 1}]`]);
    expect(compileVisaRules({ ...pipeline, visa: { ...pipeline.visa, prefilter: [] } }).prefilterViolations).toEqual([]);
  });

  it("a prefilter that misses a phrase hides it (the packs must keep the contract)", () => {
    const pipeline = shippedPipeline();
    const narrow = compileVisaRules({ ...pipeline, visa: { ...pipeline.visa, prefilter: ["nothing-like-this"] } });
    expect(detectVisa("We offer visa sponsorship.", narrow).status).toBe("not_mentioned");
  });
});
