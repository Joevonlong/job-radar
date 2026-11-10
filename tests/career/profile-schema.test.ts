import { describe, expect, it } from "vitest";
import { careerSchema } from "@/lib/config/schemas/career";
import { careerContactSchema } from "@/lib/career/schema/contact";
import { assignIds, ID_PREFIXES, newId } from "@/lib/career/schema/ids";
import {
  CAREER_FILE_BOUNDS,
  careerProfileSchema,
  checkProfileLimits,
  emptyProfile,
  parseStoredProfile,
} from "@/lib/career/schema/profile";
import { profile, text } from "./fixtures";

describe("career profile schemas and stable ids", () => {
  it.each(["email", "phone", "name", "address", "location", "links", "photo", "work_auth", "availability"])(
    "rejects contact field %s in the profile",
    (key) => {
      expect(careerProfileSchema.safeParse({ ...emptyProfile(), [key]: "private" }).success).toBe(false);
    },
  );
  it("is strict at every nested boundary and has hard bounds", () => {
    const input = profile();
    expect(
      careerProfileSchema.safeParse({ ...input, experience: [{ ...input.experience[0], email: "private" }] }).success,
    ).toBe(false);
    input.experience[0]!.bullets[0]!.wordings[0]!.text = "x".repeat(CAREER_FILE_BOUNDS.textChars + 1);
    expect(careerProfileSchema.safeParse(input).success).toBe(false);
    expect(careerContactSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(careerContactSchema.safeParse({ photo: "../../escape.jpg" }).success).toBe(false);
  });
  it.each(["2021", "2021-03", "present"])("accepts date %s", (start) => {
    const input = profile();
    input.experience[0]!.start = start;
    expect(careerProfileSchema.safeParse(input).success).toBe(true);
  });
  it.each(["2021-13", "03/2021", "yesterday"])("rejects date %s", (start) => {
    const input = profile();
    input.experience[0]!.start = start;
    expect(careerProfileSchema.safeParse(input).success).toBe(false);
  });
  it("generates unique lowercase base32 server ids with every prefix", () => {
    for (const prefix of ID_PREFIXES) {
      const ids = Array.from({ length: 1000 }, () => newId(prefix));
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(new RegExp(`^${prefix}_[a-z2-7]{10}$`));
    }
  });
  it("assigns new ids, preserves them on edits, and rejects unknown or duplicate ids", () => {
    const saved = assignIds(profile(), emptyProfile());
    expect(parseStoredProfile(saved)).toEqual(saved);
    const edited = structuredClone(saved);
    edited.experience[0]!.company = "Changed";
    expect(assignIds(edited, saved)).toEqual(edited);
    expect(() => assignIds(saved, emptyProfile())).toThrow("unknown_id");
    saved.experience[0]!.bullets.push(structuredClone(saved.experience[0]!.bullets[0]!));
    expect(careerProfileSchema.safeParse(saved).success).toBe(false);
  });
  it("checks file-wide uniqueness including text and wording ids", () => {
    const saved = assignIds(profile(), emptyProfile());
    saved.summary = structuredClone(saved.experience[0]!.role);
    expect(careerProfileSchema.safeParse(saved).success).toBe(false);
    expect(() => parseStoredProfile(profile())).toThrow();
  });
  it("supports another wording and primary selection with configurable limits", () => {
    const saved = assignIds(profile(), emptyProfile());
    const draft = structuredClone(saved);
    draft.experience[0]!.bullets[0]!.wordings.unshift(text("Another wording").wordings[0]!);
    draft.experience[0]!.bullets[0]!.primary = "";
    const next = assignIds(draft, saved);
    const bullet = next.experience[0]!.bullets[0]!;
    expect(bullet.primary).toBe(bullet.wordings[0]!.id);
    expect(() => checkProfileLimits(next, { ...careerSchema.parse({}).profile, max_wordings_per_text: 1 })).toThrow(
      "limits",
    );
    bullet.wordings = [bullet.wordings[0]!];
    expect(careerProfileSchema.safeParse(next).success).toBe(true);
  });
  it("checks configurable entry, bullet and character limits", () => {
    const input = profile();
    const limits = careerSchema.parse({}).profile;
    input.experience.push(profile().experience[0]!);
    expect(() => checkProfileLimits(input, { ...limits, max_entries: 1 })).toThrow("limits");
    input.experience.pop();
    input.experience[0]!.bullets.push(text());
    expect(() => checkProfileLimits(input, { ...limits, max_bullets_per_entry: 1 })).toThrow("limits");
    expect(() => checkProfileLimits(input, { ...limits, text_max_chars: 2 })).toThrow("limits");
  });
});

it("assigns every prefix at its structural location, including every text and wording", () => {
  function multipleText(value?: string) {
    const result = text(value);
    result.wordings.push(text("Alternative wording").wordings[0]!);
    return result;
  }
  const draft = careerProfileSchema.parse({
    headline: multipleText("Engineer"),
    summary: multipleText("Career summary"),
    experience: [
      { id: "", company: "Company", role: multipleText(), summary: multipleText(), bullets: [multipleText()] },
    ],
    projects: [{ id: "", name: "Project", tagline: multipleText(), bullets: [multipleText()] }],
    education: [
      { id: "", school: "School", degree: multipleText(), summary: multipleText(), bullets: [multipleText()] },
    ],
    certifications: [{ id: "", name: "Certificate" }],
    languages: [{ id: "", name: "Language", level: "Fluent", code: "en", cefr: "C1" }],
    skills: [{ id: "", group: "Skills", items: [{ id: "", name: "Skill", years: 3 }] }],
    approach: [{ id: "", title: "Approach", text: multipleText() }],
    custom_sections: [
      {
        id: "",
        title: multipleText("Awards"),
        layout: "list",
        side: "main",
        items: [
          {
            id: "",
            kind: "entry",
            heading: multipleText(),
            sub: multipleText(),
            text: multipleText(),
            bullets: [multipleText()],
          },
          { id: "", kind: "text", text: multipleText() },
          { id: "", kind: "bullet", text: multipleText() },
          { id: "", kind: "tag", text: multipleText() },
        ],
      },
    ],
  });
  const saved = assignIds(draft, emptyProfile());
  const experience = saved.experience[0]!;
  const project = saved.projects[0]!;
  const education = saved.education[0]!;
  const section = saved.custom_sections[0]!;
  const customEntry = section.items[0]!;
  if (customEntry.kind !== "entry") throw new Error("Expected a custom entry");
  const entries = [
    [experience.id, "exp"],
    [project.id, "prj"],
    [education.id, "edu"],
    [saved.certifications[0]!.id, "crt"],
    [saved.languages[0]!.id, "lng"],
    [saved.skills[0]!.id, "skg"],
    [saved.skills[0]!.items[0]!.id, "skl"],
    [saved.approach[0]!.id, "apr"],
    [section.id, "sec"],
    ...section.items.map((item) => [item.id, "itm"]),
  ];
  for (const [id, prefix] of entries) expect(id).toMatch(new RegExp(`^${prefix}_[a-z2-7]{10}$`));
  const texts = [
    saved.headline,
    saved.summary,
    experience.role,
    experience.summary,
    ...experience.bullets,
    project.tagline,
    ...project.bullets,
    education.degree,
    education.summary,
    ...education.bullets,
    saved.approach[0]!.text,
    section.title,
    customEntry.heading,
    customEntry.sub,
    customEntry.text,
    ...customEntry.bullets,
    ...section.items.slice(1).map((item) => item.text),
  ];
  const ids = entries.map(([id]) => id);
  for (const value of texts) {
    expect(value).not.toBeNull();
    expect(value!.id).toMatch(/^txt_[a-z2-7]{10}$/);
    expect(value!.primary).toBe(value!.wordings[0]!.id);
    ids.push(value!.id);
    for (const wording of value!.wordings) {
      expect(wording.id).toMatch(/^wrd_[a-z2-7]{10}$/);
      ids.push(wording.id);
    }
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(ids.map((id) => id!.split("_")[0]))).toEqual(new Set(ID_PREFIXES));
  expect(parseStoredProfile(saved)).toEqual(saved);
  expect(assignIds(saved, saved)).toEqual(saved);
});
