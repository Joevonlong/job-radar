// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ghostCheckDefaults } from "@/lib/config/schemas/pipeline";
import { evaluateGhost, levelOf } from "@/lib/ghost/evaluate";
import { ghostRulesFingerprint } from "@/lib/ghost/fingerprint";
import { emptyGhostPack } from "@/lib/market/schema";

import { NOW, daysAgo, input, posting, rulesWith } from "./helpers";

const pack = {
  evergreen_patterns: [{ id: "pool", pattern: "talent pool", check_negation: true }],
  responsibility_patterns: [{ id: "tasks", pattern: "responsibilities" }],
  repost_label_patterns: [{ id: "reposted", pattern: "reposted" }],
};
const rules = rulesWith(() => {}, pack);

describe("levelOf", () => {
  const levels = { watch: 3, likely: 5 };

  it("sums points into levels", () => {
    expect(levelOf(2, [{ code: "reposted" }], levels)).toBe("none");
    expect(levelOf(3, [{ code: "reposted" }], levels)).toBe("watch");
    expect(levelOf(5, [{ code: "reposted" }], levels)).toBe("likely");
  });

  it("likely needs a reason that is not about time or length", () => {
    expect(levelOf(9, [{ code: "long_open" }, { code: "thin_description" }], levels)).toBe("watch");
    expect(levelOf(5, [{ code: "long_open" }, { code: "evergreen_wording" }], levels)).toBe("likely");
    expect(levelOf(5, [{ code: "repost_label" }], levels)).toBe("likely");
  });
});

describe("evaluateGhost", () => {
  it("a clean, fresh, full JD: none", () => {
    expect(evaluateGhost(input(), rules, NOW)).toEqual({ level: "none", score: 0, reasons: [], recheckAt: daysAgo(10 - 90) });
  });

  it("open long + relisted + talent pool + thin: likely, reasons in signal order", () => {
    const result = evaluateGhost(
      input({
        trustedPostedAt: { at: daysAgo(200), channelId: "greenhouse" },
        description: "We collect CVs for our talent pool.",
        postings: [posting({ externalId: "a", firstSeenAt: daysAgo(100) }), posting({ externalId: "b", firstSeenAt: daysAgo(5) })],
      }),
      rules,
      NOW,
    );
    expect(result.level).toBe("likely");
    expect(result.score).toBe(2 + 2 + 2 + 1);
    expect(result.reasons.map((r) => r.code)).toEqual(["long_open", "reposted", "evergreen_wording", "thin_description"]);
    expect(result.recheckAt).toBeNull();
  });

  it("open long + thin only: at most watch", () => {
    const result = evaluateGhost(input({ trustedPostedAt: { at: daysAgo(400), channelId: "greenhouse" }, description: "Short text, no duties." }), rulesWith((s) => (s.thin_description.points = 4), pack), NOW);
    expect(result.score).toBe(6);
    expect(result.level).toBe("watch");
  });

  it("a trusted company is never flagged", () => {
    const result = evaluateGhost(input({ trustedCompany: true, trustedPostedAt: { at: daysAgo(400), channelId: "greenhouse" }, description: "Our talent pool." }), rules, NOW);
    expect(result).toEqual({ level: "none", score: 0, reasons: [], recheckAt: null });
  });

  it("levels and points come from the config", () => {
    const strict = rulesWith((s) => {
      s.levels = { watch: 1, likely: 2 };
      s.repost_label.points = 2;
    }, pack);
    const result = evaluateGhost(input({ postings: [posting({ repostLabel: "Reposted 1 week ago" })] }), strict, NOW);
    expect(result).toMatchObject({ level: "likely", score: 2 });
  });

  it("a signal with zero points is not a reason", () => {
    const zero = rulesWith((s) => (s.repost_label.points = 0), pack);
    expect(evaluateGhost(input({ postings: [posting({ repostLabel: "Reposted" })] }), zero, NOW).reasons).toEqual([]);
  });
});

describe("ghostRulesFingerprint", () => {
  const config = (edit: (s: ReturnType<typeof ghostCheckDefaults>) => void = () => {}) => {
    const settings = ghostCheckDefaults();
    edit(settings);
    return { ghost: emptyGhostPack(), job_checks: { ghost: settings } };
  };

  it("ignores per_cycle_limit", () => {
    expect(ghostRulesFingerprint(config((s) => (s.per_cycle_limit = 5)))).toBe(ghostRulesFingerprint(config()));
  });

  it("changes with points, levels and the pack", () => {
    const base = ghostRulesFingerprint(config());
    expect(ghostRulesFingerprint(config((s) => (s.reposted.points = 3)))).not.toBe(base);
    expect(ghostRulesFingerprint(config((s) => (s.levels.likely = 6)))).not.toBe(base);
    expect(ghostRulesFingerprint({ ...config(), ghost: { ...emptyGhostPack(), negation_cues: ["not"] } })).not.toBe(base);
  });

  it("changes with infer_from_headings and the packs' question words", () => {
    const base = ghostRulesFingerprint(config());
    expect(ghostRulesFingerprint(config((s) => (s.thin_description.infer_from_headings = false)))).not.toBe(base);
    expect(ghostRulesFingerprint(config((s) => (s.thin_description.infer_from_headings = true)))).toBe(base);
    expect(ghostRulesFingerprint({ ...config(), ghost: { ...emptyGhostPack(), question_words: ["what"] } })).not.toBe(base);
  });
});
