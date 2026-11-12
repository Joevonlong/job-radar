import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
afterEach(() => { vi.useRealTimers(); temp.cleanup(); });

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

it("returns export hints for both buttons while keeping checks scoped to the preview", async () => {
  const unsaved = draft("resume");
  unsaved.headline!.text = "TODO 中文";
  unsaved.letter!.body[0]!.text = "A finished letter body";
  const response = await preview(request(unsaved, "letter"));
  expect(await response.json()).toMatchObject({
    ok: true, uncovered: [],
    exportHints: {
      uncovered: ["中", "文"],
      findings: expect.arrayContaining([expect.objectContaining({ code: "career.lint.placeholder" })]),
    },
  });
});


it.each(["resume", "letter"] as const)("pins the complete %s preview response with stored contact", async (kind) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  fs.mkdirSync(path.join(temp.profileDir, "career"), { recursive: true });
  const contact = {
    ...emptyContact(), name: "Fictional Preview Person", email: "preview@example.test",
    phone: "+49 555 12345678", address: "42 Fictional Avenue",
  };
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify(contact));
  const response = await preview(request(draft(kind), kind));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(Object.keys(body).sort()).toEqual(["exportHints", "findings", "html", "ok", "uncovered"]);
  for (const value of [contact.name, contact.email, contact.phone, contact.address]) expect(body.html).toContain(value);
  expect(body).toMatchSnapshot();
  const invalid = await preview(request(draft(kind), kind === "resume" ? "letter" : "resume"));
  expect({ status: invalid.status, body: await invalid.json() }).toMatchSnapshot();
});
