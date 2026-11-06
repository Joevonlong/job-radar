import { expect, it } from "vitest";
import { adoptDraft, adoptDecisionsSchema } from "@/lib/career/extract/adopt";
import { assignIds } from "@/lib/career/schema/ids";
import { emptyProfile, primaryText } from "@/lib/career/schema/profile";
import { profile } from "./fixtures";
import { draft, field, output, settings, SOURCE } from "./extract-fixtures";
import { verifyCareerExtract } from "@/lib/career/extract/verify";

it("preserves facts, adds a different role wording, and deduplicates bullets", () => {
  const existing = assignIds(profile(), emptyProfile());
  const source = draft();
  source.sections.experience[0]!.fields.role!.value = "Senior Engineer";
  source.sections.experience[0]!.fields.company!.value = "Different company";
  source.sections.experience[0]!.bullets.push({ value: "  BUILT   a service ", quote: "", flags: [] }, { value: "New bullet", quote: "", flags: [] });
  const decision = [{ key: source.sections.experience[0]!.key, action: "merge" as const, target: existing.experience[0]!.id }];
  const result = adoptDraft(existing, source, decision);
  expect(result.experience[0]!.company).toBe("Example");
  expect(result.experience[0]!.start).toBeNull();
  expect(result.experience[0]!.role.wordings.map((wording) => wording.text)).toEqual(["Engineer", "Senior Engineer"]);
  expect(result.experience[0]!.bullets.map(primaryText)).toEqual(["Built a service", "New bullet"]);
  expect(adoptDraft(result, source, decision)).toEqual(result);
  expect(existing.experience[0]!.role.wordings).toHaveLength(1);
});
it("makes re-adoption after saving new entries idempotent across all sections", () => {
  const source = draft();
  source.sections = verifyCareerExtract(SOURCE, output({
    headline: field("Engineer"), summary: field("Built a service"), projects: [{ name: field("Service"), tagline: null, bullets: [], stack: [] }],
    education: [{ school: field("School"), degree: field("Degree"), location: null, start: null, end: null, summary: null, bullets: [] }],
    certifications: [{ name: field("Certificate"), issuer: null, date: null }], languages: [{ name: field("English"), level: field("C1") }],
    skills: [{ group: "Languages", items: [field("Go")] }], custom_sections: [{ title: field("Awards"), items: [{ kind: "entry", heading: field("Award"), sub: null, date: null, text: null, bullets: [] }] }],
  }), settings().evidence);
  const keys = ["headline", "summary", ...Object.values(source.sections).flatMap((value) => Array.isArray(value) ? value.map((entry) => entry.key) : [])];
  const decisions = keys.map((key) => ({ key, action: "new" as const }));
  const first = assignIds(adoptDraft(emptyProfile(), source, decisions), emptyProfile());
  expect(adoptDraft(first, source, decisions)).toEqual(first);
});
it("validates decisions, supports skipping and rejects unknown merge targets", () => {
  const source = draft();
  expect(adoptDraft(emptyProfile(), source, [{ key: "headline", action: "skip" }])).toEqual(emptyProfile());
  expect(() => adoptDraft(emptyProfile(), source, [{ key: "d1", action: "merge", target: "missing" }])).toThrow(expect.objectContaining({ code: "unknown_id" }));
  expect(adoptDecisionsSchema.safeParse([{ key: "d1", action: "skip" }, { key: "d1", action: "new" }]).success).toBe(false);
});

it("preserves meaningful punctuation in skills and deduplicates bullets on first adoption", () => {
  const source = draft();
  source.sections = verifyCareerExtract(SOURCE, output({ skills: [{ group: "Programming", items: [field("C++"), field("C#"), field(" c++ ")] }] }), settings().evidence);
  source.sections.experience[0]!.bullets.push({ ...source.sections.experience[0]!.bullets[0]! });
  const decisions = [...source.sections.experience, ...source.sections.skills].map((entry) => ({ key: entry.key, action: "new" as const }));
  const result = adoptDraft(emptyProfile(), source, decisions);
  expect(result.skills[0]!.items.map((item) => item.name)).toEqual(["C++", "C#"]);
  expect(result.experience[0]!.bullets).toHaveLength(1);
});

it("merges duplicate new entries into the matching object before IDs are assigned", () => {
  const source = draft();
  source.sections = verifyCareerExtract(SOURCE, output({ projects: [
    { name: field("A"), tagline: null, bullets: [field("Bullet A")], stack: [] },
    { name: field("B"), tagline: null, bullets: [field("Bullet B")], stack: [] },
    { name: field("B"), tagline: null, bullets: [field("Another B")], stack: [] },
  ] }), settings().evidence);
  const result = adoptDraft(emptyProfile(), source, source.sections.projects.map((entry) => ({ key: entry.key, action: "new" })));
  expect(result.projects.map((project) => [project.name, project.bullets.map(primaryText)])).toEqual([["A", ["Bullet A"]], ["B", ["Bullet B", "Another B"]]]);
});

it("retains bullets attached to custom text items across re-adoption", () => {
  const source = draft();
  source.sections = verifyCareerExtract(SOURCE, output({ custom_sections: [{ title: field("Volunteering"), items: [{ kind: "text", text: field("Community work"), heading: null, sub: null, date: null, bullets: [field("Organized meetings")] }] }] }), settings().evidence);
  const decisions = source.sections.custom_sections.map((entry) => ({ key: entry.key, action: "new" as const }));
  const result = adoptDraft(emptyProfile(), source, decisions);
  expect(result.custom_sections[0]!.items.map((item) => item.kind === "entry" ? "" : primaryText(item.text))).toEqual(["Community work", "Organized meetings"]);
  expect(adoptDraft(result, source, decisions)).toEqual(result);
});

it("applies nested skill and custom item edits, skips and bullet selections", () => {
  const source = draft();
  source.sections = verifyCareerExtract(SOURCE, output({
    skills: [{ group: "Code", items: [field("Go"), field("Rust")] }],
    custom_sections: [{ title: field("Awards"), items: [
      { kind: "entry", heading: field("First"), sub: null, date: null, text: null, bullets: [field("Keep"), field("Drop")] },
      { kind: "entry", heading: field("Second"), sub: null, date: null, text: null, bullets: [] },
    ] }],
  }), settings().evidence);
  const skills = source.sections.skills[0]!; const custom = source.sections.custom_sections[0]!;
  const decisions = [
    { key: skills.key, action: "new" as const }, { key: skills.items[0]!.key, action: "skip" as const },
    { key: skills.items[1]!.key, action: "new" as const, fields: { name: "TypeScript" } },
    { key: custom.key, action: "new" as const }, { key: custom.items[0]!.key, action: "new" as const, fields: { heading: "Reviewed award" }, bullets: ["Keep"] },
    { key: custom.items[1]!.key, action: "skip" as const },
  ];
  const result = adoptDraft(emptyProfile(), source, decisions);
  expect(result.skills[0]!.items.map((item) => item.name)).toEqual(["TypeScript"]);
  const item = result.custom_sections[0]!.items[0]!;
  expect(result.custom_sections[0]!.items).toHaveLength(1);
  expect(item.kind === "entry" && primaryText(item.heading)).toBe("Reviewed award");
  expect(item.kind === "entry" && item.bullets.map(primaryText)).toEqual(["Keep"]);
  expect(adoptDraft(emptyProfile(), source, decisions.map((decision) => ({ ...decision, action: "skip" })))).toEqual(emptyProfile());
});
