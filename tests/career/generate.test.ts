import { expect, it } from "vitest";
import { generateDocument } from "@/lib/career/document/generate";
import { newId } from "@/lib/career/schema/ids";
import { defaults, HASH, NOW, richProfile } from "./document-fixtures";

it("chooses a matching language before primary wording and falls back to primary", () => {
  const profile = richProfile();
  profile.headline!.wordings[0]!.lang = "en";
  profile.headline!.wordings.push({ ...profile.headline!.wordings[0]!, id: newId("wrd"), lang: "de", text: "Deutsche Fassung" });
  const layout = { ...defaults(), lang: "de" as const };
  const doc = generateDocument(profile, HASH, layout, NOW, "Example");
  expect(doc.headline).toMatchObject({ text: "Deutsche Fassung", source: { text_id: profile.headline!.id, wording_id: profile.headline!.wordings[1]!.id }, origin: "source" });
  expect(doc.summary!.text).toBe(profile.summary!.wordings[0]!.text);
  expect(doc.summary!.source!.wording_id).toBe(profile.summary!.primary);
});

it("copies facts and every section with provenance without adopting contact or job context", () => {
  const profile = richProfile();
  const before = structuredClone(profile);
  const doc = generateDocument(profile, HASH, defaults(), NOW, "Example");
  expect(profile).toEqual(before);
  expect(doc).toMatchObject({ kind: "general", job: null, profile_hash: HASH, letter: null, claims: [], hide_contact: [], requirements: [], layout: { ...defaults(), colors: "quiet", filename: null, sections: null, signature: null } });
  expect(doc.experience[0]).toMatchObject({ source: { entry_id: profile.experience[0]!.id }, included: true, company: profile.experience[0]!.company, stack: profile.experience[0]!.stack });
  expect(doc.languages).toHaveLength(profile.languages.length);
  expect(doc.skills[0]!.items[0]).toMatchObject({ source: { item_id: profile.skills[0]!.items[0]!.id }, included: true });
  expect(doc.approach).toHaveLength(profile.approach.length);
  expect(doc.certifications).toHaveLength(profile.certifications.length);
  expect(doc.custom_sections).toHaveLength(4);
  expect(doc.custom_sections.every((section) => section.columns === null && section.items.every((item) => item.included))).toBe(true);
  expect(doc.custom_sections[0]!.items[0]!.source).toEqual({ entry_id: profile.custom_sections[0]!.items[0]!.id });
});
