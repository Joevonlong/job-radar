import { expect, it } from "vitest";
import { generateDocument } from "@/lib/career/document/generate";
import { sourceStates } from "@/lib/career/document/resolve";
import { newId } from "@/lib/career/schema/ids";
import { defaults, HASH, NOW, richProfile } from "./document-fixtures";

it("reports deleted source texts, entries and skill items without mutating the document", () => {
  const profile = richProfile();
  const doc = generateDocument(profile, HASH, defaults(), NOW, "Example");
  const before = structuredClone(doc);
  expect(sourceStates(doc, profile, HASH)).toEqual({ profileChanged: false, texts: {}, entries: {} });
  profile.headline = null;
  profile.experience = [];
  profile.skills[0]!.items = [];
  const result = sourceStates(doc, profile, "b".repeat(64));
  expect(result.profileChanged).toBe(true);
  expect(result.texts[doc.headline!.id]).toBe("source_deleted");
  expect(result.entries[doc.experience[0]!.id]).toBe("source_deleted");
  expect(result.entries[doc.skills[0]!.items[0]!.id]).toBe("source_deleted");
  expect(doc).toEqual(before);
});

it("distinguishes a deleted wording and accepts an identical replacement on the same source text", () => {
  const profile = richProfile();
  const doc = generateDocument(profile, HASH, defaults(), NOW, "Example");
  profile.headline!.wordings = [{ ...profile.headline!.wordings[0]!, id: newId("wrd"), text: "Replacement" }];
  expect(sourceStates(doc, profile, HASH).texts).toEqual({ [doc.headline!.id]: "wording_deleted" });
  profile.headline!.wordings[0]!.text = doc.headline!.text;
  expect(sourceStates(doc, profile, HASH).texts).toEqual({});
});
