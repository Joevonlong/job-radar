import { describe, expect, it } from "vitest";

import { writerSchema } from "@/lib/config/schemas/writer";
import { diffSentences } from "@/lib/writer/diff";
import { countStatuses, figures, isFirstPerson, nameCandidates, normalize, verifySentence, type RawSentence, type VerifyContext } from "@/lib/writer/verify";

const config = writerSchema.parse({}).evidence;

const JD = "Acme GmbH is hiring. You will own our billing platform built on Kotlin and PostgreSQL. Experience with Kafka is a plus.";
const PROFILE = "Summary: Backend engineer. Skills: Kotlin (6 years), PostgreSQL (5 years). Languages: de C1, en C2.";
const STORY = "Moved billing to the new platform. I led the migration of the billing service; monthly close went from 5 to 3 days and errors fell by 40%.";

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    jd: JD,
    profile: PROFILE,
    stories: new Map([["billing", STORY]]),
    emphasis: "I want to stress ownership.",
    draft: "Ich habe die Abrechnung migriert.",
    company: "Acme was founded in 1999 and builds payment software.",
    entities: ["Kotlin", "PostgreSQL", "Kafka", "Acme GmbH"],
    companyName: "Acme GmbH",
    language: "en",
    config,
    ...overrides,
  };
}

const sentence = (text: string, about: RawSentence["about"], evidence: RawSentence["evidence"]): RawSentence => ({ text, about, evidence });

describe("verifySentence: one case per source", () => {
  it("a role sentence backed by a JD quote is supported", () => {
    const checked = verifySentence(sentence("The role owns the billing platform.", "role", [{ source: "jd", quote: "own our billing platform" }]), context());
    expect(checked.status).toBe("supported");
    expect(checked.evidence[0]?.problem).toBeNull();
  });

  it("a sentence about you backed by the profile is supported", () => {
    const checked = verifySentence(sentence("Kotlin has been my main language.", "user", [{ source: "profile", quote: "Kotlin (6 years)" }]), context());
    expect(checked.status).toBe("supported");
  });

  it("a sentence about you backed by a named story is supported", () => {
    const checked = verifySentence(sentence("I led the migration of the billing service.", "user", [{ source: "story", ref: "billing", quote: "led the migration of the billing service" }]), context());
    expect(checked.status).toBe("supported");
  });

  it("a sentence backed by the emphasis note is supported", () => {
    const checked = verifySentence(sentence("Ownership matters to me.", "user", [{ source: "emphasis", quote: "stress ownership" }]), context());
    expect(checked.status).toBe("supported");
  });

  it("a sentence backed by the user's draft is supported", () => {
    const checked = verifySentence(sentence("I migrated the billing.", "user", [{ source: "draft", quote: "habe die Abrechnung migriert" }]), context());
    expect(checked.status).toBe("supported");
  });

  it("a company sentence backed only by the company background is web_unverified", () => {
    const checked = verifySentence(sentence("The company builds payment software.", "company", [{ source: "company", quote: "builds payment software" }]), context());
    expect(checked.status).toBe("web_unverified");
  });
});

describe("verifySentence: what does not count", () => {
  it("a story id that was not sent", () => {
    const checked = verifySentence(sentence("I led the migration.", "user", [{ source: "story", ref: "nope", quote: "led the migration" }]), context());
    expect(checked.evidence[0]?.problem).toBe("unknown_ref");
    expect(checked.status).toBe("unsupported");
  });

  it("a story quote without a story id", () => {
    const checked = verifySentence(sentence("I led the migration.", "user", [{ source: "story", quote: "led the migration" }]), context());
    expect(checked.evidence[0]?.problem).toBe("no_ref");
  });

  it("a quote that is not in the material", () => {
    const checked = verifySentence(sentence("I scaled the team to 20 people.", "user", [{ source: "story", ref: "billing", quote: "scaled the team" }]), context());
    expect(checked.evidence[0]?.problem).toBe("not_found");
    expect(checked.status).toBe("unsupported");
  });

  it("a sentence about you resting only on the company background", () => {
    const checked = verifySentence(sentence("I build payment software.", "user", [{ source: "company", quote: "builds payment software" }]), context());
    expect(checked.evidence[0]?.problem).toBe("not_allowed");
    expect(checked.status).toBe("unsupported");
  });

  it("a sentence about you resting only on the JD", () => {
    const checked = verifySentence(sentence("I own billing platforms.", "user", [{ source: "jd", quote: "own our billing platform" }]), context());
    expect(checked.status).toBe("unsupported");
  });

  it("a first-person sentence labelled as about the company is checked as one about you", () => {
    const checked = verifySentence(sentence("My billing work fits Acme GmbH.", "company", [{ source: "jd", quote: "Acme GmbH is hiring" }]), context());
    expect(checked.about).toBe("user");
    expect(checked.status).toBe("unsupported");
  });
});

describe("verifySentence: framing, figures and names", () => {
  it("a framing sentence without facts stays framing, even in the first person", () => {
    const checked = verifySentence(sentence("That is why this role appeals to me so much.", "framing", []), context());
    expect(checked.status).toBe("framing");
    expect(checked.about).toBe("framing");
  });

  it("a first-person framing sentence with a fact is checked as one about you", () => {
    const checked = verifySentence(sentence("That is why I spent 5 years on billing.", "framing", []), context());
    expect(checked.about).toBe("user");
    expect(checked.status).toBe("unsupported");
  });

  it("a framing sentence with a figure is checked like any other", () => {
    const checked = verifySentence(sentence("Over 5 years this kept coming back.", "framing", []), context());
    expect(checked.status).toBe("unsupported");
  });

  it("a figure that differs from the evidence makes the sentence partly backed", () => {
    const checked = verifySentence(sentence("I cut errors by 60%.", "user", [{ source: "story", ref: "billing", quote: "errors fell by 40%" }]), context());
    expect(checked.status).toBe("partial");
    expect(checked.missing).toEqual(["60%"]);
  });

  it("a technology not in the evidence makes the sentence partly backed", () => {
    const checked = verifySentence(sentence("I led the migration of the billing service to Kafka.", "user", [{ source: "story", ref: "billing", quote: "led the migration of the billing service" }]), context());
    expect(checked.status).toBe("partial");
    expect(checked.missing).toContain("Kafka");
  });

  it("an invented former employer is marked to check", () => {
    const checked = verifySentence(sentence("I led the migration at Siemens.", "user", [{ source: "story", ref: "billing", quote: "led the migration" }]), context());
    expect(checked.status).toBe("partial");
    expect(checked.needsCheck).toEqual(["Siemens"]);
  });

  it("a quoted name not in the evidence is marked to check", () => {
    const checked = verifySentence(sentence('I named the project "blue harbour".', "user", [{ source: "story", ref: "billing", quote: "led the migration" }]), context());
    expect(checked.needsCheck).toContain("blue harbour");
  });

  it("a name found in the JD is not marked", () => {
    const checked = verifySentence(sentence("The platform runs on Kotlin at Acme GmbH.", "role", [{ source: "jd", quote: "built on Kotlin" }]), context());
    expect(checked.needsCheck).toEqual([]);
    expect(checked.status).toBe("supported");
  });

  it("the company name is backed by any valid JD quote", () => {
    const checked = verifySentence(sentence("Acme GmbH is hiring for billing.", "company", [{ source: "jd", quote: "Acme GmbH is hiring" }]), context());
    expect(checked.missing).toEqual([]);
  });

  it("capitalised German nouns are not names", () => {
    const checked = verifySentence(
      sentence("Ich habe die Abrechnung und das Berichtswesen migriert.", "user", [{ source: "draft", quote: "habe die Abrechnung migriert" }]),
      context({ language: "de", entities: [] }),
    );
    expect(checked.needsCheck).toEqual([]);
  });

  it("a run of capitalised German words still counts as a name", () => {
    expect(nameCandidates("Ich war bei Deutsche Bahn tätig.", "de", config)).toEqual(["Deutsche Bahn"]);
  });
});

describe("verifySentence: review cases", () => {
  it("years from the profile back a sentence that states them", () => {
    const checked = verifySentence(sentence("I have 6 years of Kotlin.", "user", [{ source: "profile", quote: "Kotlin (6 years)" }]), context());
    expect(checked).toMatchObject({ status: "supported", missing: [], needsCheck: [] });
  });

  it("a tool only the JD names does not back a claim about you", () => {
    const checked = verifySentence(sentence("I have used Kafka extensively.", "user", [{ source: "story", ref: "billing", quote: "led the migration" }]), context({ entities: [] }));
    expect(checked.status).toBe("partial");
    expect(checked.needsCheck).toEqual(["Kafka"]);
  });

  it("the same tool in a sentence about the role may rest on the JD", () => {
    const checked = verifySentence(sentence("The role also values Kafka.", "role", [{ source: "jd", quote: "own our billing platform" }]), context({ entities: [] }));
    expect(checked).toMatchObject({ status: "supported", needsCheck: [] });
  });

  it("a quote of a letter or two is no evidence, unless it is a known name", () => {
    const short = verifySentence(sentence("I know the subject well.", "user", [{ source: "profile", quote: "Ko" }]), context());
    expect(short.status).toBe("unsupported");
    expect(short.evidence[0]?.problem).toBe("too_short");
    const name = verifySentence(sentence("I write Go.", "user", [{ source: "profile", quote: "Go" }]), context({ profile: "Skills: Go (3 years)", entities: ["Go"] }));
    expect(name.evidence[0]?.problem).toBeNull();
    expect(name.status).toBe("supported");
  });
});

describe("figures", () => {
  it("40 % and 40% are the same figure", () => {
    expect([...figures("40 %").keys]).toEqual(expect.arrayContaining(["40%"]));
    expect([...figures("40%").keys]).toEqual(expect.arrayContaining(["40%"]));
    expect([...figures("40 Prozent").keys]).toEqual(expect.arrayContaining(["40%"]));
  });

  it("€85k, 85,000 € and 85.000 € are the same amount", () => {
    for (const text of ["€85k", "85,000 €", "85.000 €"]) expect(figures(text).keys.has("85000")).toBe(true);
  });

  it("a decimal mark is not a thousands separator", () => {
    expect(figures("2,5").keys.has("2.5")).toBe(true);
  });

  it("figures written as words and digits inside names are not figures", () => {
    expect(figures("forty percent").shown).toEqual([]);
    expect(figures("S3 and K8s").shown).toEqual([]);
  });

  it("a 40 % sentence matches 40% evidence", () => {
    const checked = verifySentence(sentence("Errors fell by 40 %.", "user", [{ source: "story", ref: "billing", quote: "errors fell by 40%" }]), context());
    expect(checked.missing).toEqual([]);
  });
});

describe("names and first person", () => {
  it("I is never a name", () => {
    expect(nameCandidates("Then I moved on.", "en", config)).toEqual([]);
  });

  it("the opening word is not a name, later capitals are", () => {
    expect(nameCandidates("Kotlin is what I used at Zalando.", "en", config)).toEqual(["Zalando"]);
  });

  it("mixed tokens count as names", () => {
    expect(nameCandidates("we stored it in S3 via GitLab and AWS", "en", config)).toEqual(["S3", "GitLab", "AWS"]);
  });

  it("first person in Chinese ignores 我们", () => {
    expect(isFirstPerson("我们团队完成了迁移", "zh", config)).toBe(false);
    expect(isFirstPerson("我负责了迁移", "zh", config)).toBe(true);
  });

  it("normalize folds accents, quotes and dashes", () => {
    expect(normalize("Café – “x”")).toBe('cafe - "x"');
  });
});

describe("after a manual edit", () => {
  it("unchanged sentences keep their check, changed ones become written by you", () => {
    const previous = [
      verifySentence(sentence("I scaled the team to 20 people.", "user", []), context()),
      verifySentence(sentence("I led the migration of the billing service.", "user", [{ source: "story", ref: "billing", quote: "led the migration of the billing service" }]), context()),
    ];
    expect(previous.map((entry) => entry.status)).toEqual(["unsupported", "supported"]);
    const next = diffSentences(previous, "I scaled the team to 20 people. I moved the billing service myself.");
    expect(next.map((entry) => entry.status)).toEqual(["unsupported", "user_written"]);
    expect(countStatuses(next)).toMatchObject({ unsupported: 1, user_written: 1 });
  });

  it("a sentence with an inner full stop keeps its check when another sentence changes", () => {
    const quoted = verifySentence(sentence('The role says: "You will own our billing platform. Built on Kotlin."', "role", [{ source: "jd", quote: "own our billing platform" }]), context());
    const framing = verifySentence(sentence("That is why I am applying.", "framing", []), context());
    const next = diffSentences([quoted, framing], `${quoted.text} I moved the billing myself. That is why I am applying.`);
    expect(next.map((entry) => entry.status)).toEqual([quoted.status, "user_written", "framing"]);
    expect(quoted.status).not.toBe("user_written");
    expect(next[0]?.text).toBe(quoted.text);
  });

  it("an old sentence inside a longer new one is not kept", () => {
    const kept = verifySentence(sentence("I led the migration.", "user", [{ source: "story", ref: "billing", quote: "led the migration" }]), context());
    expect(diffSentences([kept], "Honestly I led the migration.").map((entry) => entry.status)).toEqual(["user_written"]);
  });

  it("Chinese sentences without spaces keep their check", () => {
    const kept = { ...verifySentence(sentence("我负责了迁移。", "user", [{ source: "story", ref: "billing", quote: "led the migration" }]), context({ language: "zh" })), status: "supported" as const };
    expect(diffSentences([kept], "我负责了迁移。我还写了文档。").map((entry) => [entry.text, entry.status])).toEqual([
      ["我负责了迁移。", "supported"],
      ["我还写了文档。", "user_written"],
    ]);
  });

  it("a new paragraph stays marked", () => {
    const kept = verifySentence(sentence("That is why I am applying.", "framing", []), context());
    expect(diffSentences([kept], "New start.\n\nThat is why I am applying.").map((entry) => entry.newParagraph)).toEqual([false, true]);
  });
});
