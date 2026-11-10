import { expect, test } from "vitest";
import { factPool } from "@/lib/career/ai/view";
import { addStoryToProfile, storyOptions } from "@/lib/career/apply/from-story";
import { assignIds } from "@/lib/career/schema/ids";
import { emptyProfile } from "@/lib/career/schema/profile";
import { storySchema, type Story } from "@/lib/config/schemas/stories";
import { profile } from "./fixtures";

const NOW = "2026-02-01T00:00:00Z";
const story = (id: string, what: string, extra: Partial<Story> = {}) => storySchema.parse({ id, title: `Title ${id}`, what, ...extra });
const stories = [
  story("billing-migration", "Moved billing to the new platform", { result: "Saved 30% of hosting cost", language: "en" }),
  story("career-exp-example", "Projected from the profile"),
  story("contact-me", "Reach me at someone@example.test"),
];
const stored = () => assignIds(profile("Existing bullet"), emptyProfile());

test("profile-written stories are never offered and suspected contact details are flagged", () => {
  const options = storyOptions(stories);
  expect(options.map((option) => option.id)).toEqual(["billing-migration", "contact-me"]);
  expect(options.find((option) => option.id === "contact-me")?.pii).toBe(true);
  expect(options.find((option) => option.id === "billing-migration")).toMatchObject({ pii: false, text: "Moved billing to the new platform Saved 30% of hosting cost" });
});

test("a story becomes a new bullet or summary wording that records the story id", () => {
  const base = stored();
  const experienceId = base.experience[0]!.id;
  const bullet = addStoryToProfile(base, stories, { storyId: "billing-migration", experienceId, target: "bullet" }, NOW);
  expect(bullet.changed).toBe(true);
  expect(bullet.profile.experience[0]!.bullets.at(-1)!.wordings[0]).toMatchObject({ origin: "from_story", from_story: "billing-migration", lang: "en", created_at: NOW });
  expect(base.experience[0]!.bullets).toHaveLength(1);
  expect(addStoryToProfile(bullet.profile, stories, { storyId: "billing-migration", experienceId, target: "bullet" }, NOW).changed).toBe(false);
  const summary = addStoryToProfile(base, stories, { storyId: "billing-migration", experienceId, target: "summary" }, NOW);
  expect(summary.profile.experience[0]!.summary?.wordings[0]).toMatchObject({ origin: "from_story", from_story: "billing-migration" });
});

test("unknown stories, profile-written stories and unknown entries are refused", () => {
  const base = stored();
  const experienceId = base.experience[0]!.id;
  for (const storyId of ["missing", "career-exp-example"]) {
    expect(() => addStoryToProfile(base, stories, { storyId, experienceId, target: "bullet" }, NOW)).toThrow("unknown_id");
  }
  expect(() => addStoryToProfile(base, stories, { storyId: "billing-migration", experienceId: "exp_aaaaaaaaaa", target: "bullet" }, NOW)).toThrow("unknown_id");
});

test("the story text enters the tailoring fact pool only after it is added", () => {
  const base = stored();
  const text = "Moved billing to the new platform";
  expect(factPool(base, (value) => value).all).not.toContain(text);
  const added = assignIds(addStoryToProfile(base, stories, { storyId: "billing-migration", experienceId: base.experience[0]!.id, target: "bullet" }, NOW).profile, base);
  const pool = factPool(added, (value) => value);
  expect(pool.all).toContain(text);
  expect(pool.entries[added.experience[0]!.id]).toContain(text);
});
