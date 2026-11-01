// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ghostCheckDefaults } from "@/lib/config/schemas/pipeline";
import { countWords, hasResponsibilityHeading, longOpen, repostLabel, reposted, thinDescription } from "@/lib/ghost/signals";
import { ghostReasonMessage } from "@/lib/ghost/view";

import { DAY_MS, NOW, daysAgo, fixtureRules, input, posting, rulesWith } from "./helpers";

describe("long_open", () => {
  const rules = rulesWith((s) => {
    s.long_open.tiers = [
      { days: 90, points: 1 },
      { days: 180, points: 2 },
    ];
    s.long_open.first_seen_max_points = 1;
  });

  it("counts from the trusted posted date: a tier's points once its days are reached", () => {
    expect(longOpen(input({ trustedPostedAt: { at: daysAgo(89), channelId: "greenhouse" } }), rules, NOW).reason).toBeNull();
    const ninety = longOpen(input({ trustedPostedAt: { at: daysAgo(90), channelId: "greenhouse" } }), rules, NOW);
    expect(ninety.reason).toEqual({ code: "long_open", points: 1, days: 90, since: daysAgo(90).toISOString().slice(0, 10), from: "posted", channelId: "greenhouse" });
    const old = longOpen(input({ trustedPostedAt: { at: daysAgo(214), channelId: "lever" } }), rules, NOW);
    expect(old.reason?.points).toBe(2);
    expect(old.reason?.days).toBe(214);
  });

  it("without a trusted date counts from the first sighting, capped at first_seen_max_points", () => {
    const outcome = longOpen(input({ firstSeenAt: daysAgo(400) }), rules, NOW);
    expect(outcome.reason).toMatchObject({ points: 1, from: "first_seen", channelId: null, days: 400 });
    // the cap is reached: the points never change again
    expect(outcome.recheckAt).toBeNull();
  });

  it("only active jobs", () => {
    for (const status of ["possibly_closed", "closed"] as const) {
      expect(longOpen(input({ status, trustedPostedAt: { at: daysAgo(300), channelId: "greenhouse" } }), rules, NOW).reason).toBeNull();
    }
  });

  it("says when the next tier is reached (the stored recheck_at)", () => {
    const at = daysAgo(100);
    const outcome = longOpen(input({ trustedPostedAt: { at, channelId: "greenhouse" } }), rules, NOW);
    expect(outcome.recheckAt?.getTime()).toBe(at.getTime() + 180 * DAY_MS);
    const young = longOpen(input({ firstSeenAt: daysAgo(5) }), rules, NOW);
    expect(young.reason).toBeNull();
    expect(young.recheckAt?.getTime()).toBe(daysAgo(5).getTime() + 90 * DAY_MS);
  });

  it("reads tiers and points from the config", () => {
    const custom = rulesWith((s) => {
      s.long_open.tiers = [{ days: 30, points: 3 }];
    });
    expect(longOpen(input({ trustedPostedAt: { at: daysAgo(31), channelId: "greenhouse" } }), custom, NOW).reason?.points).toBe(3);
    const off = rulesWith((s) => {
      s.long_open.enabled = false;
    });
    expect(longOpen(input({ trustedPostedAt: { at: daysAgo(500), channelId: "greenhouse" } }), off, NOW).reason).toBeNull();
  });
});

describe("repost_label", () => {
  const rules = rulesWith(() => {}, { repost_label_patterns: [{ id: "reposted", pattern: "(?<![\\p{L}\\p{N}])re-?posted(?![\\p{L}\\p{N}])" }] });

  it("matches the source's own label", () => {
    const reason = repostLabel([posting({ channelId: "linkedin-session", stableIds: true, repostLabel: "Reposted 2 weeks ago" })], rules);
    expect(reason).toEqual({ code: "repost_label", points: 1, channelId: "linkedin-session", label: "Reposted 2 weeks ago" });
  });

  it("ignores other labels and postings without one", () => {
    expect(repostLabel([posting({ repostLabel: "Posted 2 weeks ago" }), posting({ repostLabel: null }), posting({ repostLabel: "  " })], rules)).toBeNull();
    expect(repostLabel([posting({ repostLabel: "Unreposted" })], rules)).toBeNull();
  });
});

describe("reposted", () => {
  const rules = rulesWith((s) => {
    s.reposted.min_gap_days = 30;
    s.reposted.points = 2;
  });

  it("a new id of the same channel at the same place, at least min_gap_days later", () => {
    const reason = reposted([posting({ externalId: "a", firstSeenAt: daysAgo(80) }), posting({ externalId: "b", firstSeenAt: daysAgo(40) })], rules);
    expect(reason).toEqual({
      code: "reposted",
      points: 2,
      channelId: "greenhouse",
      events: [{ oldId: "a", newId: "b", oldSeen: daysAgo(80).toISOString().slice(0, 10), newSeen: daysAgo(40).toISOString().slice(0, 10), gapDays: 40 }],
    });
  });

  it("not when the gap is shorter", () => {
    expect(reposted([posting({ externalId: "a", firstSeenAt: daysAgo(50) }), posting({ externalId: "b", firstSeenAt: daysAgo(21) })], rules)).toBeNull();
  });

  it("never across channels", () => {
    expect(reposted([posting({ channelId: "greenhouse", externalId: "1", firstSeenAt: daysAgo(100) }), posting({ channelId: "lever", externalId: "2", firstSeenAt: daysAgo(10) })], rules)).toBeNull();
  });

  it("never for channels without stable ids", () => {
    expect(reposted([posting({ channelId: "indeed", stableIds: false, externalId: "1", firstSeenAt: daysAgo(100) }), posting({ channelId: "indeed", stableIds: false, externalId: "2", firstSeenAt: daysAgo(10) })], rules)).toBeNull();
  });

  it("not at another place; the same place whatever the case and spacing", () => {
    const berlin = posting({ externalId: "a", firstSeenAt: daysAgo(100), locationLabel: "Berlin, Germany" });
    expect(reposted([berlin, posting({ externalId: "b", firstSeenAt: daysAgo(10), locationLabel: "Munich, Germany" })], rules)).toBeNull();
    expect(reposted([berlin, posting({ externalId: "b", firstSeenAt: daysAgo(10), locationLabel: " berlin,  GERMANY" })], rules)?.events).toHaveLength(1);
    // both without a place count as the same place
    expect(reposted([posting({ externalId: "a", firstSeenAt: daysAgo(100), locationLabel: null }), posting({ externalId: "b", firstSeenAt: daysAgo(10), locationLabel: null })], rules)?.events).toHaveLength(1);
  });

  it("several relistings: adjacent pairs only, the channel with most events, at most ten", () => {
    const many = Array.from({ length: 13 }, (_, i) => posting({ externalId: `g${i}`, firstSeenAt: daysAgo(600 - i * 40) }));
    const reason = reposted([...many, posting({ channelId: "lever", externalId: "l1", firstSeenAt: daysAgo(300) }), posting({ channelId: "lever", externalId: "l2", firstSeenAt: daysAgo(100) })], rules);
    expect(reason?.channelId).toBe("greenhouse");
    expect(reason?.events).toHaveLength(10);
    expect(reason?.events.every((e) => e.gapDays === 40)).toBe(true);
  });

  it("more than ten relistings keep the latest ten, oldest first", () => {
    const many = Array.from({ length: 13 }, (_, i) => posting({ externalId: `g${i}`, firstSeenAt: daysAgo(600 - i * 40) }));
    const events = reposted(many, rules)?.events ?? [];
    expect(events.map((e) => e.newId)).toEqual(["g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11", "g12"]);
    expect(events.at(-1)?.newSeen).toBe(daysAgo(600 - 12 * 40).toISOString().slice(0, 10));
  });

  it("the same id seen twice is not a relisting", () => {
    expect(reposted([posting({ externalId: "a", firstSeenAt: daysAgo(100) }), posting({ externalId: "a", firstSeenAt: daysAgo(10) })], rules)).toBeNull();
  });
});

describe("thin_description", () => {
  const rules = rulesWith(
    (s) => {
      s.thin_description.min_words = 20;
    },
    { responsibility_patterns: [{ id: "responsibilities", pattern: "(?<![\\p{L}\\p{N}])(?:your\\s+)?(?:responsibilities|tasks)(?![\\p{L}\\p{N}])" }] },
  );
  const longText = (heading: string) => [heading, ...Array.from({ length: 6 }, (_, i) => `- Build and run service number ${i} well.`)].join("\n");

  it("counts words", () => {
    expect(countWords("Don't stop: 3 words, really")).toBe(5);
    expect(countWords(null)).toBe(0);
  });

  it("a long JD with a duties heading is not thin", () => {
    expect(thinDescription(input({ description: longText("Your tasks:") }), rules)).toBeNull();
    expect(thinDescription(input({ description: longText("## Responsibilities") }), rules)).toBeNull();
    expect(thinDescription(input({ description: longText("**Responsibilities**") }), rules)).toBeNull();
  });

  it("a short JD, or one without a duties heading", () => {
    expect(thinDescription(input({ description: "Your tasks:\n- Code." }), rules)).toMatchObject({ points: 1, words: 3, hasResponsibilities: true, responsibilitiesFrom: "headings", channelId: "greenhouse" });
    expect(thinDescription(input({ description: longText("What we offer") }), rules)).toMatchObject({ hasResponsibilities: false });
  });

  it("a sentence mentioning the word is not a heading", () => {
    const text = [`We value people who enjoy many responsibilities and take ownership of their work every single day of the week.`, ...Array.from({ length: 4 }, () => "More words about the company and its long history in the market.")].join("\n");
    expect(hasResponsibilityHeading(text, rules)).toBe(false);
  });

  it("a current breakdown decides whether there are duties", () => {
    expect(thinDescription(input({ description: longText("What we offer"), breakdownResponsibilities: 3 }), rules)).toBeNull();
    expect(thinDescription(input({ description: longText("Your tasks:"), breakdownResponsibilities: 0 }), rules)).toMatchObject({ hasResponsibilities: false, responsibilitiesFrom: "breakdown" });
  });

  it("infer_from_headings is on by default (the schema's default)", () => {
    expect(ghostCheckDefaults().thin_description.infer_from_headings).toBe(true);
    expect(rules.settings.thin_description.infer_from_headings).toBe(true);
  });

  describe("infer_from_headings: false", () => {
    const off = rulesWith(
      (s) => {
        s.thin_description.min_words = 20;
        s.thin_description.infer_from_headings = false;
      },
      { responsibility_patterns: [{ id: "responsibilities", pattern: "(?<![\\p{L}\\p{N}])(?:your\\s+)?(?:responsibilities|tasks)(?![\\p{L}\\p{N}])" }] },
    );

    it("without a current breakdown a long JD is not judged by its headings", () => {
      expect(thinDescription(input({ description: longText("What we offer") }), off)).toBeNull();
      expect(thinDescription(input({ description: longText("What we offer") }), rules)).toMatchObject({ responsibilitiesFrom: "headings", hasResponsibilities: false });
    });

    it("a short JD still counts, without claiming there is no duties section", () => {
      const reason = thinDescription(input({ description: "We build things." }), off);
      expect(reason).toMatchObject({ points: 1, words: 3, hasResponsibilities: false, responsibilitiesFrom: "none" });
      expect(reason && ghostReasonMessage(reason).key).toBe("reason.thin_short");
      // with a duties heading in the short JD: still "none", the headings were not read
      expect(thinDescription(input({ description: "Your tasks:\n- Code." }), off)).toMatchObject({ responsibilitiesFrom: "none" });
    });

    it("a current breakdown still decides, an empty duties list included", () => {
      expect(thinDescription(input({ description: longText("What we offer"), breakdownResponsibilities: 3 }), off)).toBeNull();
      expect(thinDescription(input({ description: longText("Your tasks:"), breakdownResponsibilities: 0 }), off)).toMatchObject({ hasResponsibilities: false, responsibilitiesFrom: "breakdown" });
      expect(thinDescription(input({ description: "We build things.", breakdownResponsibilities: 2 }), off)).toMatchObject({ hasResponsibilities: true, responsibilitiesFrom: "breakdown" });
    });

    it("a stale breakdown is none (the input carries null): the same as no breakdown", () => {
      expect(thinDescription(input({ description: longText("What we offer"), breakdownResponsibilities: null }), off)).toBeNull();
    });
  });

  it("is not judged without a full-text source", () => {
    expect(thinDescription(input({ description: "Short.", descriptionSource: null }), rules)).toBeNull();
  });

  it("reads min_words and points from the config", () => {
    const strict = rulesWith(
      (s) => {
        s.thin_description.min_words = 500;
        s.thin_description.points = 2;
      },
      { responsibility_patterns: [{ id: "responsibilities", pattern: "tasks" }] },
    );
    expect(thinDescription(input({ description: longText("Your tasks:") }), strict)).toMatchObject({ points: 2, minWords: 500 });
  });
});

describe("duties headings of the fixture packs", () => {
  const rules = fixtureRules();
  const duties = ["Job Description", "Stellenbeschreibung", "Ihre Tätigkeitsschwerpunkte", "The opportunity", "Was du bei uns machst", "Role overview", "Your Impact", "Deine Aufgaben", "What you'll do", "Das erwartet dich", "**Your Responsibilities**", "## Aufgaben", "Ihr Aufgabengebiet:", "Was Sie bei uns bewegen", "Your tasks", "Die Rolle"];
  const others = ["Your profile", "Dein Profil", "Benefits", "Wir bieten"];
  it.each(duties)("%j opens the duties", (heading) => expect(hasResponsibilityHeading(`${heading}\n- Something here.`, rules)).toBe(true));
  it.each(others)("%j does not", (heading) => expect(hasResponsibilityHeading(`${heading}\n- Something here.`, rules)).toBe(false));
});

describe("dates are whole days", () => {
  it("NOW is the reference of every test", () => {
    expect(daysAgo(1).getTime()).toBe(NOW.getTime() - DAY_MS);
  });
});
