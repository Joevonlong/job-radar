import { stringify } from "yaml";
import { expect, it } from "vitest";
import { toResume } from "@/lib/career/render/to-resume";
import { renderDocumentHtml } from "@/lib/career/render/html";
import { emptyContact } from "@/lib/career/schema/contact";
import { document } from "./document-fixtures";

const contact = () => ({ ...emptyContact(), name: "Projection sentinel", email: "projection@example.invalid", address: "One road\nSecond line", work_auth: "Authorized", availability: "Available", location: "Example location", phone: "0000", links: [{ label: "Site", url: "https://example.invalid" }], photo: "ignored.png" });
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it("projects generated fixture data to the engine without storing contact", () => {
  const doc = document();
  doc.custom_sections = [];
  const before = stringify(doc);
  const projected = toResume(doc, contact(), { photo: bytes }, "resume");
  expect(projected.resume.basics).toMatchObject({ name: "Projection sentinel", email: "projection@example.invalid", address: ["One road", "Second line"], workAuth: "Authorized", title: doc.headline!.text, photo: "photo" });
  expect(projected.images.photo).toBe(bytes);
  expect(stringify(doc)).toBe(before);
  expect(before).not.toContain("projection@example.invalid");
  expect(before).not.toContain("Projection sentinel");
  expect(projected.resume.sections).toBeUndefined();
});

it("omits excluded entries and skill items and hides every selected contact field", () => {
  const doc = document();
  doc.experience[0]!.included = false;
  doc.projects[0]!.included = false;
  doc.education[0]!.included = false;
  doc.certifications[0]!.included = false;
  doc.languages[0]!.included = false;
  doc.skills[0]!.items[0]!.included = false;
  doc.skills[1]!.included = false;
  doc.approach[0]!.included = false;
  doc.hide_contact = ["address", "location", "email", "phone", "work_auth", "availability", "links", "photo"];
  const result = toResume(doc, contact(), { photo: bytes }, "resume");
  expect(result.resume.experience).toHaveLength(doc.experience.length - 1);
  expect(result.resume.projects).toHaveLength(doc.projects.length - 1);
  expect(result.resume.education).toEqual([]);
  expect(result.resume.certifications).toEqual([]);
  expect(result.resume.languages).toHaveLength(doc.languages.length - 1);
  expect(result.resume.approach).toHaveLength(doc.approach.length - 1);
  expect(result.resume.skills[0]!.items).not.toContain(doc.skills[0]!.items[0]!.name);
  expect(result.resume.skills).toHaveLength(doc.skills.length - 1);
  expect(result.resume.basics).toEqual({ name: "Projection sentinel", title: doc.headline!.text, summary: doc.summary!.text, links: [] });
  expect(result.images).toEqual({});
});

it("inlines selected custom sections with item kinds, columns and order", () => {
  const doc = document();
  doc.custom_sections[2]!.columns = 3;
  doc.layout.sections = ["summary", ...doc.custom_sections.map((section) => ({ custom: section.id })), { custom: "ent_aaaaaaaaaa" }];
  const result = toResume(doc, contact(), {}, "resume").resume;
  expect(result.sections).toHaveLength(5);
  expect(result.sections![1]).toMatchObject({ items: [{ kind: "entry", heading: "Example", start: "2020", end: "2021", tags: [{ text: "TypeScript", color: "blue" }] }] });
  expect(result.sections![2]).toMatchObject({ side: "aside", items: [{ kind: "text", text: "A note" }] });
  expect(result.sections![3]).toMatchObject({ layout: "grid", columns: 3, items: [{ kind: "bullet" }] });
  expect(result.sections![4]).toMatchObject({ layout: "tags", items: [{ kind: "tag", tag: { text: "Example", color: "green" } }] });
  doc.custom_sections[0]!.included = false;
  doc.custom_sections[1]!.items[0]!.included = false;
  const html = renderDocumentHtml(doc, { contact: contact(), images: {}, doc: "resume", today: "2026-01-02" });
  expect(html.ok).toBe(true);
  doc.custom_sections[1]!.included = false;
  expect(toResume(doc, contact(), {}, "resume").resume.sections).toHaveLength(3);
});

it("appends included non-empty custom sections to the engine default order", () => {
  const doc = document();
  doc.layout.sections = null;
  doc.custom_sections[1]!.included = false;
  doc.custom_sections[2]!.items[0]!.included = false;
  const result = toResume(doc, contact(), {}, "resume").resume;
  expect(result.sections?.slice(0, 8)).toEqual(["summary", "approach", "experience", "projects", "skills", "education", "certifications", "languages"]);
  expect(result.sections?.slice(8)).toMatchObject([
    { title: "Selected work", items: [{ kind: "entry", heading: "Example" }] },
    { title: "Tags", items: [{ kind: "tag", tag: { text: "Example", color: "green" } }] },
  ]);
  const rendered = renderDocumentHtml(doc, { contact: contact(), images: {}, doc: "resume", today: "2026-01-02" });
  expect(rendered).toMatchObject({ ok: true, html: expect.stringContaining("Selected work") });
  for (const section of doc.custom_sections) section.included = false;
  expect(toResume(doc, contact(), {}, "resume").resume.sections).toBeUndefined();
});

it("omits the resume signature and unused image bytes when its layout signature is null", () => {
  const doc = document();
  doc.layout.signature = null;
  const result = toResume(doc, contact(), { signature: bytes }, "resume");
  expect(result.resume.meta.signature).toBeUndefined();
  expect(result.images).toEqual({});
});

it("signs the letter with an image when the resume signature is disabled", () => {
  const doc = document();
  doc.layout.signature = null;
  doc.letter = { recipient: [], place: null, date: null, subject: null, salutation: null, body: [{ ...doc.summary!, id: "dtx_aaaaaaaaaa" }], closing: null };
  const result = toResume(doc, contact(), { photo: bytes, signature: bytes }, "letter");
  expect(result.resume.meta.signature).toBeUndefined();
  expect(result.resume.letter?.signature).toBe("signature");
  expect(result.images).toEqual({ signature: bytes });
  expect(renderDocumentHtml(doc, { contact: contact(), images: { signature: bytes }, doc: "letter", today: "2026-01-02" }))
    .toMatchObject({ ok: true, html: expect.stringContaining('class="l-sig" src="data:image/png;base64,') });
  doc.letter.body = [];
  expect(toResume(doc, contact(), { signature: bytes }, "letter").images).toEqual({});
});

it("keeps the resume signature date and place without requiring image bytes", () => {
  const doc = document();
  doc.layout.signature = { place: "Example place", date: "2026-01-02" };
  const result = toResume(doc, contact(), {}, "resume");
  expect(result.resume.meta.signature).toEqual({ place: "Example place", date: "2026-01-02" });
  expect(result.images).toEqual({});
});

it("projects letter and signature bytes and renders both document types", () => {
  const doc = document();
  doc.layout.signature = { place: "Example place", date: "auto" };
  doc.letter = { recipient: ["Example team"], place: null, date: "2026-01-02", subject: "Application", salutation: null, body: [{ ...doc.summary!, id: "dtx_aaaaaaaaaa" }], closing: null };
  const result = toResume(doc, contact(), { photo: bytes, signature: bytes }, "letter");
  expect(result.resume.letter).toMatchObject({ body: [doc.summary!.text], recipient: ["Example team"] });
  expect(result.resume.meta.signature).toEqual({ place: "Example place", date: "auto", image: "signature" });
  expect(result.images).toEqual({ signature: bytes });
  for (const kind of ["resume", "letter"] as const) {
    const rendered = renderDocumentHtml(doc, { contact: contact(), images: { photo: bytes, signature: bytes }, doc: kind, today: "2026-01-02" });
    expect(rendered).toMatchObject({ ok: true, html: expect.stringContaining("<!doctype html>") });
  }
  doc.letter.body = [];
  expect(toResume(doc, contact(), {}, "letter").resume.letter).toBeUndefined();
  expect(renderDocumentHtml(doc, { contact: contact(), images: {}, doc: "letter", today: "2026-01-02" })).toEqual({ ok: false, issues: [{ path: "", code: "career.letter.missing" }] });
});

it("returns engine diagnostics without private wording or unknown filename variables", () => {
  const doc = document();
  doc.layout.filename = "{private-sentinel}";
  const result = renderDocumentHtml(doc, { contact: contact(), images: {}, doc: "resume", today: "2026-01-02" });
  expect(result).toEqual({ ok: false, issues: [{ path: "meta.filename", code: "career.schema.filename_variable_unknown" }] });
  expect(JSON.stringify(result)).not.toContain("private-sentinel");
  doc.layout.filename = null;
  doc.experience[0]!.start = null;
  expect(renderDocumentHtml(doc, { contact: contact(), images: {}, doc: "resume", today: "2026-01-02" }).ok).toBe(false);
});
