import { expect, it } from "vitest";
import { applyDocumentEdit, applyDocumentRestore } from "@/lib/career/document/edit";
import { newId } from "@/lib/career/schema/ids";
import { parseStoredDocument } from "@/lib/career/schema/document";
import { document, NOW } from "./document-fixtures";

it("marks changed text as user content while retaining stored provenance and untouched origins", () => {
  const stored = document();
  const incoming = structuredClone(stored);
  incoming.headline!.text = "Edited headline";
  incoming.headline!.source = null;
  incoming.summary!.origin = "ai";
  const edited = applyDocumentEdit(stored, incoming, NOW);
  expect(edited.headline).toEqual({ ...stored.headline, text: "Edited headline", origin: "user" });
  expect(edited.summary).toEqual(stored.summary);
  expect(stored.headline!.text).not.toBe("Edited headline");
});

it("ignores incoming readonly fields even when malformed and rejects unknown nonempty ids", () => {
  const stored = document();
  const edited = applyDocumentEdit(stored, { ...stored, id: "bad", kind: "tailored", job: "bad", profile_hash: "bad", created_at: "bad", claims: [{}], updated_at: "bad" }, NOW);
  expect(edited).toEqual({ ...stored, updated_at: NOW });
  const incoming = structuredClone(stored);
  incoming.experience[0]!.id = newId("ent");
  expect(() => applyDocumentEdit(stored, incoming, NOW)).toThrow("unknown_id");
});

it("assigns new entry, skill and text ids and removes client provenance from new objects", () => {
  const stored = document();
  const incoming = structuredClone(stored);
  incoming.projects.push({ ...incoming.projects[0]!, id: "", tagline: { ...incoming.headline!, id: "" }, bullets: [] });
  incoming.skills[0]!.items.push({ ...incoming.skills[0]!.items[0]!, id: "" });
  incoming.custom_sections[1]!.items.push({ id: "", source: null, included: true, kind: "text", text: { ...incoming.summary!, id: "" } });
  const edited = applyDocumentEdit(stored, incoming, NOW);
  expect(parseStoredDocument(edited)).toEqual(edited);
  expect(edited.projects.at(-1)).toMatchObject({ id: expect.stringMatching(/^ent_/), source: null, tagline: { id: expect.stringMatching(/^dtx_/), source: null, origin: "user" } });
  expect(edited.skills[0]!.items.at(-1)).toMatchObject({ id: expect.stringMatching(/^itm_/), source: null });
  expect(edited.custom_sections[1]!.items.at(-1)).toMatchObject({ source: null, text: { origin: "user", source: null } });
});

it("restores removed entries and section references from trusted history while preserving current identity", () => {
  const version = document();
  version.layout.sections = [{ custom: version.custom_sections[0]!.id }, "experience"];
  const current = structuredClone(version);
  current.experience = [];
  current.custom_sections = [];
  current.layout.sections = ["experience"];
  current.summary!.text = "Newer wording";
  current.updated_at = "2026-02-01T00:00:00Z";
  expect(() => applyDocumentEdit(current, version, NOW)).toThrow("unknown_id");
  const restored = applyDocumentRestore(current, version, "2026-03-01T00:00:00Z");
  expect(restored.experience).toEqual(version.experience);
  expect(restored.custom_sections).toEqual(version.custom_sections);
  expect(restored.layout.sections).toEqual(version.layout.sections);
  expect(restored.summary).toEqual({ ...version.summary, origin: "user" });
  expect(restored.created_at).toBe(current.created_at);
  expect(restored.updated_at).toBe("2026-03-01T00:00:00Z");
});
