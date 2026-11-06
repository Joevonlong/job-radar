import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/career/contact/store", () => ({ loadContact: async () => ({ contact: emptyContact() }) }));
vi.mock("@/lib/career/store/images", () => ({ loadImages: async () => ({}) }));
vi.mock("@/lib/dashboard/context", () => ({ getDisplayTimeZone: () => "UTC" }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import { POST as preview } from "@/app/api/career/documents/preview/route";
import { saveDocumentAction } from "@/app/career/documents/actions";
import { emptyContact } from "@/lib/career/schema/contact";
import { documentSchema, type CareerDocument } from "@/lib/career/schema/document";
import { document } from "./document-fixtures";
import { tempCareer } from "./fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => { temp = tempCareer(); });
afterEach(() => { temp.cleanup(); });

function draft(kind: "resume" | "letter"): CareerDocument {
  const unsaved = document();
  unsaved.letter = {
    recipient: [], place: null, date: null, subject: null, salutation: null, closing: null,
    body: [{ id: "", source: null, origin: "user", text: kind === "resume" ? "" : "Independent letter paragraph" }],
  };
  if (kind === "letter") unsaved.experience[0]!.start = null;
  return unsaved;
}

function request(document: unknown, doc: "resume" | "letter") {
  return new Request("http://localhost/api/career/documents/preview", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document, doc }),
  });
}

it.each(["resume", "letter"] as const)("previews %s without validating the other document's renderability", async (kind) => {
  const unsaved = draft(kind);
  expect(documentSchema.safeParse(unsaved).success).toBe(true);
  const response = await preview(request(unsaved, kind));
  const body: unknown = await response.json();
  expect({ status: response.status, body }).toMatchObject({
    status: 200, body: { ok: true, html: expect.stringContaining("<!doctype html>") },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");

  const other = await preview(request(unsaved, kind === "resume" ? "letter" : "resume"));
  expect(other.status).toBe(422);
  expect(await other.json()).toMatchObject({ ok: false, error: "render_invalid", issues: expect.any(Array) });
});

it.each(["resume", "letter"] as const)("rejects duplicate paragraph ids before the %s projection", async (kind) => {
  const unsaved = draft(kind);
  unsaved.letter!.body[0]!.id = unsaved.summary!.id;
  const parsed = documentSchema.safeParse(unsaved);
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues).toEqual([
    { code: "custom", message: "duplicate id", path: [] },
  ]);
  const response = await preview(request(unsaved, kind));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    ok: false, error: "render_invalid", issues: [{ path: "document", code: "custom" }],
  });
});

it.each(["resume", "letter"] as const)("validates the whole document structure for %s previews and saves", async (kind) => {
  const unsaved = draft(kind);
  const invalid = kind === "resume"
    ? { ...unsaved, letter: { ...unsaved.letter!, body: [{ ...unsaved.letter!.body[0]!, text: 42 }] } }
    : { ...unsaved, experience: [{ ...unsaved.experience[0]!, start: 42 }] };
  const response = await preview(request(invalid, kind));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ ok: false, error: "render_invalid", issues: [{
    path: kind === "resume" ? "document.letter.body.0.text" : "document.experience.0.start", code: "invalid_type",
  }] });
  expect(await saveDocumentAction({ id: unsaved.id, document: invalid, baseHash: "a".repeat(64) }))
    .toEqual({ ok: false, code: "document_invalid" });
});
