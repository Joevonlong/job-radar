import { describe, expect, it } from "vitest";

import { applyMeSelection, defaultMeSelection, projectMe } from "@/lib/career/apply/project-me";
import { applyStoriesSelection, defaultStoriesSelection, projectStories } from "@/lib/career/apply/project-stories";
import { yearsOfExperience } from "@/lib/career/apply/years";
import { careerProfileSchema, type CareerProfile } from "@/lib/career/schema/profile";
import type { MeConfig } from "@/lib/config/schemas/me";
import type { Story } from "@/lib/config/schemas/stories";
import { figures } from "@/lib/writer/verify";
import { text } from "./fixtures";

const limits = { max_items: 60, title_max_chars: 40, text_max_chars: 200, preselect_count: 4 };
const same = (value: string) => value;
const shown = (value: string) => figures(value).shown;

const me: MeConfig = { languages: [{ en: "C1" }], skills: [{ name: "Go", years: 2 }], years_experience: 3, city: "Example City", needs_visa_sponsorship: true, summary: "Old summary" };

function career(value: Record<string, unknown>): CareerProfile {
  return careerProfileSchema.parse(value);
}

function experience(id: string, extra: Record<string, unknown> = {}) {
  return { id, company: "Acme", role: text("Engineer"), start: "2020-01", end: "2021-12", summary: text("Ran the platform team."), bullets: [text("Cut build time by 40%.")], stack: ["TypeScript"], ...extra };
}

describe("years of experience", () => {
  it("counts overlapping ranges once and reads present as today", () => {
    expect(yearsOfExperience([{ start: "2020-01", end: "2021-12" }, { start: "2021-01", end: "2022-12" }], "2026-11-07")).toBe(3);
    expect(yearsOfExperience([{ start: "2024", end: "present" }], "2026-06-15")).toBe(2.5);
    expect(yearsOfExperience([{ start: null, end: "2020" }], "2026-01-01")).toBeNull();
  });
});

describe("me.yaml projection", () => {
  const profile = career({
    summary: text("Platform engineer."),
    languages: [{ id: "lng_aaaaaaaaaa", name: "English", level: "fluent", code: "en", cefr: "C2" }, { id: "lng_bbbbbbbbbb", name: "Klingon", level: "some", code: null, cefr: null }],
    skills: [{ id: "skg_aaaaaaaaaa", group: "Code", items: [{ id: "skl_aaaaaaaaaa", name: "TypeScript", years: 4 }, { id: "skl_bbbbbbbbbb", name: "typescript", years: 6 }] }],
    experience: [experience("exp_aaaaaaaaaa")],
  });

  it("proposes languages, merged skills and years, keeps city and visa, and leaves the summary unchecked", () => {
    const projection = projectMe(profile, me, "2026-11-07", same);
    expect(projection.languagesNotApplied).toEqual(["Klingon"]);
    const selection = defaultMeSelection(projection);
    expect(selection).toEqual({ languages: true, skills: true, years_experience: true, summary: false });
    const next = applyMeSelection(me, projection, selection);
    expect(next).toEqual({ ...me, languages: [{ en: "C2" }], skills: [{ name: "TypeScript", years: 6 }], years_experience: 2 });
    expect(applyMeSelection(me, projection, { ...selection, summary: true }).summary).toBe("Platform engineer.");
  });

  it("selects nothing when me.yaml already says the same", () => {
    const current = { ...me, languages: [{ en: "C2" }], skills: [{ name: "TypeScript", years: 6 }], years_experience: 2 } as MeConfig;
    const projection = projectMe(profile, current, "2026-11-07", same);
    expect(applyMeSelection(current, projection, defaultMeSelection(projection))).toEqual(current);
  });

  it("projects scrubbed text only", () => {
    const projection = projectMe(profile, me, "2026-11-07", (value) => value.replace("TypeScript", "[name]"));
    expect(JSON.stringify(projection)).not.toContain("TypeScript");
  });

  it("scrubs the names of languages it cannot apply", () => {
    const projection = projectMe(profile, me, "2026-11-07", (value) => value.replace("Klingon", "[name]"));
    expect(projection.languagesNotApplied).toEqual(["[name]"]);
  });
});

describe("stories.yaml projection", () => {
  it("makes one profile story per experience with a stable id", () => {
    const projection = projectStories({ profile: career({ experience: [experience("exp_x3k7d2m4qa")] }), current: [], limits, scrub: same, figures: shown });
    expect(projection.changes).toHaveLength(1);
    const change = projection.changes[0]!;
    expect(change).toMatchObject({ id: "career-x3k7d2m4qa", kind: "new", defaultSelected: true });
    expect(change.proposed).toEqual({ id: "career-x3k7d2m4qa", title: "Acme – Engineer", what: "Ran the platform team.\nCut build time by 40%.", metrics: ["40%"], skills: ["TypeScript"], tags: [], source: "profile", period: "2020-01 – 2021-12" });
  });

  it("keeps the user's stories, offers changed profile stories unchecked and keeps removed entries by default", () => {
    const own: Story = { id: "my-story", title: "Mine", what: "Did it", metrics: [], skills: [], tags: [], source: "manual" };
    const edited: Story = { id: "career-aaaaaaaaaa", title: "Acme – Engineer", what: "Edited by me", metrics: [], skills: [], tags: [], source: "profile" };
    const gone: Story = { id: "career-zzzzzzzzzz", title: "Old – Job", what: "Gone", metrics: [], skills: [], tags: [], source: "profile" };
    const current = [own, edited, gone];
    const projection = projectStories({ profile: career({ experience: [experience("exp_aaaaaaaaaa")] }), current, limits, scrub: same, figures: shown });
    expect(projection.changes.map((change) => [change.id, change.kind, change.defaultSelected])).toEqual([["career-aaaaaaaaaa", "changed", false], ["career-zzzzzzzzzz", "removed", false]]);
    const selection = defaultStoriesSelection(projection);
    expect(applyStoriesSelection(current, projection, selection)).toEqual(current);
    const next = applyStoriesSelection(current, projection, { write: ["career-aaaaaaaaaa"], remove: ["career-zzzzzzzzzz"] });
    expect(next.map((story) => story.id)).toEqual(["my-story", "career-aaaaaaaaaa"]);
    expect(next[1]!.what).toContain("Ran the platform team.");
  });

  it("keeps the result, language and tags the user added when it updates a profile story", () => {
    const edited: Story = { id: "career-aaaaaaaaaa", title: "Acme – Engineer", what: "Edited by me", result: "Shipped on time", language: "en", metrics: [], skills: [], tags: ["platform"], source: "profile" };
    const projection = projectStories({ profile: career({ experience: [experience("exp_aaaaaaaaaa")] }), current: [edited], limits, scrub: same, figures: shown });
    const next = applyStoriesSelection([edited], projection, { write: ["career-aaaaaaaaaa"], remove: [] });
    expect(next[0]).toMatchObject({ what: expect.stringContaining("Ran the platform team."), result: "Shipped on time", language: "en", tags: ["platform"] });
  });

  it("stops metrics and skills at the story list bound and marks the story truncated", () => {
    const bullets = Array.from({ length: 30 }, (_, index) => text(`Grew revenue by ${index + 10}% and cut cost by ${index + 50}%.`));
    const stack = Array.from({ length: 60 }, (_, index) => `Tool${index}`);
    const projection = projectStories({ profile: career({ experience: [experience("exp_aaaaaaaaaa", { bullets, stack })] }), current: [], limits: { ...limits, text_max_chars: 20_000 }, scrub: same, figures: shown });
    const story = projection.changes[0]!;
    expect(story.proposed!.metrics.length).toBeLessThanOrEqual(50);
    expect(story.proposed!.skills).toHaveLength(50);
    expect(story.truncated).toBe(true);
  });

  it("lists an experience without summary or bullets as not applied", () => {
    const projection = projectStories({ profile: career({ experience: [experience("exp_aaaaaaaaaa", { summary: null, bullets: [] })] }), current: [], limits, scrub: same, figures: shown });
    expect(projection.changes).toEqual([]);
    expect(projection.notApplied).toEqual(["Acme – Engineer"]);
  });

  it("cuts a long experience at bullet boundaries and is unchanged when applied again", () => {
    const bullets = Array.from({ length: 30 }, (_, index) => text(`Bullet number ${index + 1} with some words in it.`));
    const profile = career({ experience: [experience("exp_aaaaaaaaaa", { bullets, company: "A company with a rather long name", stack: ["x".repeat(60), "Go"] })] });
    const first = projectStories({ profile, current: [], limits, scrub: same, figures: shown });
    const story = first.changes[0]!.proposed!;
    expect(story.what.length).toBeLessThanOrEqual(limits.text_max_chars);
    expect(story.what.split("\n").every((line) => line === "Ran the platform team." || /^Bullet number \d+ with some words in it\.$/.test(line))).toBe(true);
    expect(story.title.length).toBeLessThanOrEqual(limits.title_max_chars);
    expect(story.skills).toEqual(["Go"]);
    expect(first.changes[0]!.truncated).toBe(true);
    const applied = applyStoriesSelection([], first, defaultStoriesSelection(first));
    const again = projectStories({ profile, current: applied, limits, scrub: same, figures: shown });
    expect(again.changes.map((change) => change.kind)).toEqual(["unchanged"]);
    expect(applyStoriesSelection(applied, again, defaultStoriesSelection(again))).toEqual(applied);
  });

  it("projects scrubbed text only", () => {
    const profile = career({ experience: [experience("exp_aaaaaaaaaa", { bullets: [text("Mail me at someone@example.com")] })] });
    const projection = projectStories({ profile, current: [], limits, scrub: (value) => value.replace("someone@example.com", "[email]"), figures: shown });
    expect(JSON.stringify(projection)).not.toContain("someone@example.com");
  });
});
