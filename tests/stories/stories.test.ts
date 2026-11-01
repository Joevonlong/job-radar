import { describe, expect, it } from "vitest";

import { STORY_FILE_BOUNDS, storiesSchema, type StoriesConfig } from "@/lib/config/schemas/stories";
import { writerSchema } from "@/lib/config/schemas/writer";
import { toFieldErrors } from "@/lib/profile/draft";
import { EMPTY_STORY, storiesConfigToDraft, storiesDraftSchema, storiesDraftToCandidate, storiesLimitProblems, storyIdFromTitle, storyPii, type StoryDraft } from "@/lib/stories/draft";
import { findPii } from "@/lib/stories/pii";

const story = { id: "billing-migration", title: "Moved billing", what: "Led the migration with a team of three." };
const limits = { max_items: 3, title_max_chars: 20, text_max_chars: 100, preselect_count: 2 };

function draftStory(patch: Partial<StoryDraft>): StoryDraft {
  return { ...EMPTY_STORY, ...patch };
}

describe("stories.yaml schema", () => {
  it("accepts a minimal story and fills the defaults", () => {
    const parsed = storiesSchema.parse({ stories: [story] });
    expect(parsed.stories[0]).toEqual({ ...story, metrics: [], skills: [], tags: [], source: "manual" });
  });

  it("accepts every field", () => {
    const full = { ...story, result: "No downtime", metrics: ["close from 5 to 3 days"], skills: ["PostgreSQL"], period: "2022–2023", language: "en", tags: ["lead"], source: "resume" };
    expect(storiesSchema.parse({ stories: [full] }).stories[0]).toEqual(full);
  });

  it("refuses duplicate ids, naming the second one", () => {
    const result = storiesSchema.safeParse({ stories: [story, { ...story, title: "Other" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["stories", 1, "id"]);
    expect(toFieldErrors(result.error!)).toEqual([{ path: "stories.1.id", key: "duplicates" }]);
  });

  it("refuses ids that are not slugs, empty titles, unknown keys and unknown sources", () => {
    for (const bad of [{ ...story, id: "Billing Migration" }, { ...story, id: "a--b" }, { ...story, title: "  " }, { ...story, extra: 1 }, { ...story, source: "web" }]) {
      expect(storiesSchema.safeParse({ stories: [bad] }).success).toBe(false);
    }
  });

  it("bounds the file format independently of writer.yaml", () => {
    expect(storiesSchema.safeParse({ stories: [{ ...story, what: "x".repeat(STORY_FILE_BOUNDS.textChars + 1) }] }).success).toBe(false);
    const many = Array.from({ length: STORY_FILE_BOUNDS.items + 1 }, (_, i) => ({ ...story, id: `s-${i}` }));
    expect(storiesSchema.safeParse({ stories: many }).success).toBe(false);
  });
});

describe("writer.yaml schema", () => {
  it("defaults to off with the shipped limits when the file is empty", () => {
    expect(writerSchema.parse({})).toMatchObject({ enabled: false, stories: { max_items: 60, title_max_chars: 120, text_max_chars: 1500, preselect_count: 4 } });
  });

  it("refuses limits above the file format's bounds", () => {
    expect(writerSchema.safeParse({ stories: { max_items: STORY_FILE_BOUNDS.items + 1 } }).success).toBe(false);
    expect(writerSchema.safeParse({ stories: { text_max_chars: STORY_FILE_BOUNDS.textChars + 1 } }).success).toBe(false);
  });
});

describe("story ids", () => {
  it("are made from the title, ASCII only, and unique", () => {
    expect(storyIdFromTitle("Moved Billing to Kotlin!", new Set())).toBe("moved-billing-to-kotlin");
    expect(storyIdFromTitle("Café Überführung", new Set())).toBe("cafe-uberfuhrung");
    expect(storyIdFromTitle("重构支付系统", new Set())).toBe("story");
    expect(storyIdFromTitle("Moved billing", new Set(["moved-billing", "moved-billing-2"]))).toBe("moved-billing-3");
    expect(storyIdFromTitle("x".repeat(200), new Set())).toHaveLength(48);
  });

  it("stay as they are; only new stories get one, unique within the whole library", () => {
    const candidate = storiesDraftToCandidate({
      stories: [draftStory({ id: "", title: "Moved billing", what: "a" }), draftStory({ id: "moved-billing", title: "Renamed later", what: "b" }), draftStory({ id: "", title: "Moved billing", what: "c" })],
    });
    expect(candidate.stories.map((s) => s.id)).toEqual(["moved-billing-2", "moved-billing", "moved-billing-3"]);
    expect(storiesSchema.safeParse(candidate).success).toBe(true);
  });

  it("round-trip: config -> draft -> candidate is the same value, empty fields left out", () => {
    const config: StoriesConfig = storiesSchema.parse({ stories: [story, { ...story, id: "b", metrics: ["40%"], period: "2024" }] });
    expect(storiesSchema.parse(storiesDraftToCandidate(storiesConfigToDraft(config)))).toEqual(config);
    const candidate = storiesDraftToCandidate({ stories: [draftStory({ title: " T ", what: " w ", result: "  ", skills: [" Go ", ""], language: "" })] });
    expect(candidate.stories[0]).toEqual({ id: "t", title: "T", what: "w", metrics: [], skills: ["Go"], tags: [], source: "manual" });
  });
});

describe("the draft the browser sends", () => {
  it("is bounded before anything else is checked", () => {
    expect(storiesDraftSchema.safeParse({ stories: [draftStory({ title: "t", what: "w" })] }).success).toBe(true);
    expect(storiesDraftSchema.safeParse({ stories: [{ ...draftStory({}), extra: true }] }).success).toBe(false);
    expect(storiesDraftSchema.safeParse({ stories: [draftStory({ what: "x".repeat(STORY_FILE_BOUNDS.textChars + 1) })] }).success).toBe(false);
  });
});

describe("writer.yaml limits", () => {
  const value = (stories: object[]) => storiesSchema.parse({ stories });

  it("report too many stories and too long fields, field by field", () => {
    expect(storiesLimitProblems(value([story]), limits)).toEqual([]);
    const many = value(Array.from({ length: 4 }, (_, i) => ({ ...story, id: `s-${i}` })));
    expect(storiesLimitProblems(many, limits)).toEqual([{ path: "stories", key: "tooMany", params: { max: 3 } }]);
    const long = value([{ ...story, title: "t".repeat(21), what: "w".repeat(101), result: "r".repeat(101), skills: ["s".repeat(21)] }]);
    expect(storiesLimitProblems(long, limits).map((p) => [p.path, p.key, p.params?.max])).toEqual([
      ["stories.0.title", "tooLong", 20],
      ["stories.0.what", "tooLong", 100],
      ["stories.0.result", "tooLong", 100],
      ["stories.0.skills", "tooLong", 20],
    ]);
  });
});

describe("contact details", () => {
  it("finds email addresses and phone numbers", () => {
    expect(findPii("write to jane.doe+jobs@example.co.uk")).toEqual(["email"]);
    for (const phone of ["+49 30 1234567", "call (555) 123-4567", "555-123-4567", "0151 23456789", "+1-202-555-0143"]) expect(findPii(phone), phone).toEqual(["phone"]);
    expect(findPii("mail a@b.io or +44 20 7946 0958")).toEqual(["email", "phone"]);
  });

  it("leaves years, ranges, amounts and percentages alone", () => {
    for (const text of ["2019-2023", "2019 – 2023", "revenue 1,200,000", "40% faster", "from 40 to 12 minutes", "v2.10.3", "ISO 27001", "12000000 rows", "1.234.567 EUR", "Q3 2024"]) {
      expect(findPii(text), text).toEqual([]);
    }
  });

  it("are looked for in every text field of a story", () => {
    expect(storyPii(draftStory({ title: "t", what: "w", metrics: ["reach me at me@x.dev"] }))).toEqual(["email"]);
    expect(storyPii(draftStory({ title: "t", what: "w" }))).toEqual([]);
  });
});
