import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import * as actions from "@/app/career/documents/actions";
import { POST as preview } from "@/app/api/career/documents/preview/route";
import { DELETE as removeImage, POST as uploadImage } from "@/app/api/career/images/route";
import { closeDb } from "@/lib/db";
import { reloadConfig, resetConfigCache } from "@/lib/config";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { visitProfile } from "@/lib/career/schema/profile";
import { careerContactPath, careerDir, careerDocumentHistoryDir, careerDocumentPath, careerDocumentsDir, careerHistoryDir, careerImagePath, careerPreferencesPath, careerProfilePath } from "@/lib/career/store/paths";
import { saveCareerProfile } from "@/lib/career/store/profile";
import { document } from "../career/document-fixtures";
import { profile, tempCareer, text } from "../career/fixtures";
import { imageJpeg, imagePng } from "../career/engine/helpers/images";

const url = inject("testDatabaseUrl");
const IMAGE_LIMIT = 512;
let temp: ReturnType<typeof tempCareer>;
let logs: unknown[][];
beforeAll(() => { process.env.DATABASE_URL = url; });
beforeEach(() => {
  temp = tempCareer({ document: { max_documents: 3, image_max_bytes: IMAGE_LIMIT, max_request_bytes: 100000 }, history: { keep_versions: 10 } });
  logs = [];
  for (const method of ["warn", "error", "log"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); temp.cleanup(); });
afterAll(closeDb);

function tree(directory = temp.profileDir): Record<string, { mode: number; content: string | null }> {
  if (!fs.existsSync(directory)) return {};
  return Object.fromEntries(["", ...fs.readdirSync(directory, { recursive: true }).map(String)].sort().map((name) => {
    const file = path.join(directory, name);
    const stat = fs.statSync(file);
    return [name, { mode: stat.mode, content: stat.isFile() ? fs.readFileSync(file).toString("base64") : null }];
  }));
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/career/documents/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function imageRequest(body: Uint8Array = imagePng(), kind = "photo", method = "POST") {
  return new Request(`http://localhost/api/career/images?kind=${kind}`, {
    method, headers: { "Content-Type": "application/octet-stream" },
    ...(method === "POST" ? { body: Buffer.from(body) } : {}),
  });
}

async function seedProfile() {
  const fixture = profile();
  fixture.experience[0]!.start = "2020";
  const saved = await saveCareerProfile({ ...fixture, headline: text("Projected headline") }, { baseHash: null });
  if (!saved.ok) throw new Error(saved.code);
  return saved;
}

async function createLoaded() {
  const created = await actions.createDocumentAction({ title: "Example document" });
  if (!created.ok) throw new Error(created.code);
  const loaded = await actions.loadDocumentAction({ id: created.id });
  if (!loaded.ok) throw new Error(loaded.code);
  return loaded;
}

it.each([false, true])("gates every entry without reading input or changing the file tree (existing=%s)", async (existing) => {
  if (existing) {
    await seedProfile();
    await createLoaded();
    await uploadImage(imageRequest());
  }
  expect(reloadConfig("career").enabled).toBe(true);
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: false\n");
  const before = tree();
  for (const action of Object.values(actions)) expect(await action(null)).toEqual({ ok: false, code: "disabled" });
  for (const response of [await preview(jsonRequest(null)), await uploadImage(imageRequest()), await removeImage(imageRequest(undefined, "photo", "DELETE"))]) {
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "disabled" });
  }
  expect(tree()).toEqual(before);
  expect(fs.existsSync(careerDir())).toBe(existing);
});

it("closes the gate on broken configuration even after an enabled cache", async () => {
  expect(reloadConfig("career").enabled).toBe(true);
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: [broken");
  for (const action of Object.values(actions)) expect(await action(null)).toEqual({ ok: false, code: "disabled" });
  expect((await preview(jsonRequest(null))).status).toBe(409);
  expect((await uploadImage(imageRequest())).status).toBe(409);
  expect((await removeImage(imageRequest(undefined, "photo", "DELETE"))).status).toBe(409);
  expect(tree()).toEqual({});
});

it("requires a nonempty profile and enforces strict objects, ids and document limits", async () => {
  expect(await actions.createDocumentAction({})).toEqual({ ok: false, code: "profile_empty" });
  await saveCareerProfile({}, { baseHash: null });
  expect(await actions.createDocumentAction({})).toEqual({ ok: false, code: "profile_empty" });
  expect(await actions.createDocumentAction({ title: "Title", extra: true })).toEqual({ ok: false, code: "document_invalid" });
  expect(await actions.loadDocumentAction({ id: "../../profile" })).toEqual({ ok: false, code: "document_invalid" });
  expect(await actions.listDocumentsAction({ extra: true })).toEqual({ ok: false, code: "document_invalid" });
  fs.unlinkSync(careerProfilePath());
  await seedProfile();
  for (let i = 0; i < 3; i++) expect(await actions.createDocumentAction({})).toMatchObject({ ok: true });
  expect(await actions.createDocumentAction({})).toEqual({ ok: false, code: "document_limit" });
  const listed = await actions.listDocumentsAction({});
  expect(listed.ok && listed.documents).toHaveLength(3);
});

it("creates, edits and rejects stale writes, then confirms deletion including history", async () => {
  const source = await seedProfile();
  const loaded = await createLoaded();
  const id = loaded.document.id;
  expect(loaded.document.profile_hash).toBe(source.baseHash);
  expect(loaded.states).toEqual({ profileChanged: false, texts: {}, entries: {} });
  const edited = structuredClone(loaded.document);
  edited.experience[0]!.bullets[0]!.text = "Edited projected text";
  const saved = await actions.saveDocumentAction({ id, document: edited, baseHash: loaded.baseHash });
  expect(saved).toMatchObject({ ok: true, document: { experience: [{ bullets: [{ text: "Edited projected text", origin: "user" }] }] }, states: loaded.states });
  expect(saved.ok && saved.baseHash).not.toBe(loaded.baseHash);
  expect(await actions.saveDocumentAction({ id, document: edited, baseHash: loaded.baseHash })).toEqual({ ok: false, code: "stale" });
  const history = await actions.documentHistoryAction({ id });
  expect(history.ok && history.versions).toHaveLength(2);
  for (const confirmed of [undefined, false, "true", 1])
    expect(await actions.deleteDocumentAction({ id, ...(confirmed === undefined ? {} : { confirmed }) })).toEqual({ ok: false, code: "confirmation_required" });
  expect(fs.existsSync(careerDocumentPath(id))).toBe(true);
  expect(await actions.deleteDocumentAction({ id, confirmed: true })).toEqual({ ok: true });
  expect(fs.existsSync(careerDocumentPath(id))).toBe(false);
  expect(fs.existsSync(careerDocumentHistoryDir(id))).toBe(false);
});

it("restores removed content as a newer version through the same stale-save checks", async () => {
  await seedProfile();
  const loaded = await createLoaded();
  const id = loaded.document.id;
  const firstHistory = await actions.documentHistoryAction({ id });
  if (!firstHistory.ok) throw new Error(firstHistory.code);
  const first = firstHistory.versions[0]!;
  const saved = await actions.saveDocumentAction({ id, document: { ...loaded.document, experience: [] }, baseHash: loaded.baseHash });
  if (!saved.ok) throw new Error(saved.code);
  expect(await actions.restoreDocumentVersionAction({ id, version: first.id, baseHash: loaded.baseHash })).toEqual({ ok: false, code: "stale" });
  const restored = await actions.restoreDocumentVersionAction({ id, version: first.id, baseHash: saved.baseHash });
  expect(restored).toMatchObject({ ok: true, document: { experience: loaded.document.experience } });
  const history = await actions.documentHistoryAction({ id });
  if (!history.ok) throw new Error(history.code);
  expect(history.versions).toHaveLength(3);
  expect(history.versions.at(-1)).toEqual(first);
  expect(history.versions[0]!.createdAt > history.versions[1]!.createdAt).toBe(true);
});

it("refreshes source states but keeps document loads and saves usable with an unreadable profile", async () => {
  const source = await seedProfile();
  const loaded = await createLoaded();
  const id = loaded.document.id;
  await saveCareerProfile({ ...source.profile, experience: [] }, { baseHash: source.baseHash });
  expect(await actions.loadDocumentAction({ id })).toMatchObject({ ok: true, states: {
    profileChanged: true, texts: { [loaded.document.experience[0]!.role.id]: "source_deleted" },
    entries: { [loaded.document.experience[0]!.id]: "source_deleted" },
  } });
  const sentinel = "private-profile-parser-sentinel";
  fs.writeFileSync(careerProfilePath(), `headline: [${sentinel}`);
  const result = await actions.loadDocumentAction({ id });
  expect(result).toMatchObject({ ok: true, states: { profileChanged: false, texts: {}, entries: {} }, warnings: ["profile_unreadable"] });
  expect(await actions.saveDocumentAction({ id, document: { ...loaded.document, title: "Changed" }, baseHash: loaded.baseHash }))
    .toMatchObject({ ok: true, warnings: ["profile_unreadable"] });
  expect(JSON.stringify([result, logs])).not.toContain(sentinel);
});

it("renders unsaved documents without excluded content or filesystem writes", async () => {
  const unsaved = document();
  visitProfile(unsaved, (object) => { if (typeof object.id === "string") object.id = ""; });
  unsaved.headline!.text = "Unsaved projected headline";
  unsaved.experience[0]!.included = false;
  unsaved.experience[0]!.role.text = "excluded-content-sentinel";
  const before = tree();
  const response = await preview(jsonRequest({ document: unsaved, doc: "resume" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = await response.json() as { ok: boolean; html: string };
  expect(result.html).toContain("Unsaved projected headline");
  expect(result.html).not.toContain("excluded-content-sentinel");
  expect(tree()).toEqual(before);
});

it("keeps contact sentinels transient across create, save, history, preferences and preview", async () => {
  const sentinel = "private-contact-sentinel";
  const contact = { ...emptyContact(), name: `${sentinel}-name`, address: `${sentinel}-address`, location: `${sentinel}-location`,
    email: `${sentinel}@example.invalid`, phone: `${sentinel}-phone`, work_auth: `${sentinel}-work`, availability: `${sentinel}-availability`,
    links: [{ label: `${sentinel}-link`, url: `https://example.invalid/${sentinel}` }], photo: `${sentinel}.png` };
  await saveContact(contact, { baseHash: null });
  await seedProfile();
  const loaded = await createLoaded();
  const prefs = await actions.loadPreferencesAction({});
  if (!prefs.ok) throw new Error(prefs.code);
  expect(await actions.savePreferencesAction({ preferences: prefs.preferences, baseHash: prefs.baseHash })).toMatchObject({ ok: true });
  const saved = await actions.saveDocumentAction({ id: loaded.document.id, document: { ...loaded.document, title: "Changed" }, baseHash: loaded.baseHash });
  if (!saved.ok) throw new Error(saved.code);
  const before = tree();
  const response = await preview(jsonRequest({ document: saved.document, doc: "resume" }));
  expect(response.status).toBe(200);
  const { html } = await response.json() as { html: string };
  for (const value of [contact.name, contact.address, contact.email, contact.phone, contact.work_auth, contact.availability, contact.links[0]!.url])
    expect(html.includes(value), value).toBe(true);
  const locationOnly = await preview(jsonRequest({ document: { ...saved.document, hide_contact: ["address"] }, doc: "resume" }));
  expect(((await locationOnly.json()) as { html: string }).html.includes(contact.location)).toBe(true);
  expect(tree()).toEqual(before);
  for (const directory of [careerDocumentsDir(), careerHistoryDir()]) {
    for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()))
      expect(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")).not.toContain(sentinel);
  }
  expect(fs.readFileSync(careerPreferencesPath(), "utf8")).not.toContain(sentinel);
  expect(JSON.stringify(logs)).not.toContain(sentinel);
});

it("returns machine codes and sanitized issues for corrupt documents, contact and hostile preview input", async () => {
  await seedProfile();
  const loaded = await createLoaded();
  const sentinel = "private-parser-sentinel";
  fs.writeFileSync(careerDocumentPath(loaded.document.id), `title: [${sentinel}`);
  const result = await actions.loadDocumentAction({ id: loaded.document.id });
  expect(result).toEqual({ ok: false, code: "document_invalid" });
  expect(await actions.saveDocumentAction({ id: loaded.document.id, document: loaded.document, baseHash: loaded.baseHash }))
    .toEqual({ ok: false, code: "document_invalid" });
  fs.writeFileSync(careerContactPath(), `name: [${sentinel}`);
  const response = await preview(jsonRequest({ document: loaded.document, doc: "resume" }));
  expect(response.status).toBe(422);
  const body = await response.json();
  expect(body).toEqual({ ok: false, error: "contact_invalid" });
  fs.unlinkSync(careerContactPath());
  fs.mkdirSync(careerContactPath());
  const unreadable = await preview(jsonRequest({ document: loaded.document, doc: "resume" }));
  expect(unreadable.status).toBe(503);
  expect(await unreadable.json()).toEqual({ ok: false, error: "contact_unreadable" });
  const invalid = await preview(jsonRequest({ document: { ...loaded.document, headline: sentinel, [sentinel]: sentinel }, doc: "resume" }));
  const issues = await invalid.json() as { error: string; issues: Record<string, unknown>[] };
  expect(invalid.status).toBe(422);
  expect(issues.error).toBe("render_invalid");
  expect(issues.issues.length).toBeGreaterThan(0);
  for (const issue of issues.issues) expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
  expect(JSON.stringify([result, body, issues, logs])).not.toContain(sentinel);
  expect(logs.length).toBeGreaterThan(0);
});

it("bounds preview JSON and returns sanitized projection failures without writes", async () => {
  const unsaved = document();
  const before = tree();
  const invalid = await preview(jsonRequest({ document: { ...unsaved, layout: { ...unsaved.layout, accent: "invalid-color" } }, doc: "resume" }));
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ ok: false, error: "render_invalid", issues: [{ code: expect.any(String), path: expect.any(String) }] });
  const malformed = await preview(new Request("http://localhost/api/career/documents/preview", { method: "POST", body: "{" }));
  expect(malformed.status).toBe(400);
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: true\ndocument:\n  max_request_bytes: 16\n");
  expect((await preview(jsonRequest({ document: unsaved, doc: "resume" }))).status).toBe(413);
  expect(tree()).toEqual(before);
});

it("renders letters with the current day in the display time zone", async () => {
  const unsaved = document();
  unsaved.layout.signature = { place: "Example", date: "auto" };
  unsaved.letter = { recipient: ["Recipient"], place: null, date: null, subject: null, salutation: null,
    body: [{ id: "", source: null, text: "Projected letter text", origin: "user" }], closing: null };
  const schedule = path.join(temp.configDir, "schedule.yaml");
  fs.writeFileSync(schedule, fs.readFileSync(schedule, "utf8").replace(/^timezone:.*$/m, "timezone: Pacific/Kiritimati"));
  resetConfigCache();
  expect(reloadConfig("schedule").timezone).toBe("Pacific/Kiritimati");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:30:00Z"));
  try {
    const resume = await preview(jsonRequest({ document: unsaved, doc: "resume" }));
    expect(resume.status).toBe(200);
    expect(((await resume.json()) as { html: string }).html.includes("2 January 2026")).toBe(true);
    const letter = await preview(jsonRequest({ document: unsaved, doc: "letter" }));
    expect(letter.status).toBe(200);
    expect(((await letter.json()) as { html: string }).html.includes("Projected letter text")).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("accepts PNG and JPEG magic bytes, refuses other and oversized bytes, and hides shared photos", async () => {
  const png = imagePng();
  const jpeg = imageJpeg();
  expect(await actions.imageStateAction({})).toEqual({ ok: true, photo: false, signature: false });
  for (const [bytes, extension] of [[png, "png"], [jpeg, "jpg"]] as const) {
    const response = await uploadImage(imageRequest(bytes));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fs.statSync(careerImagePath("photo", extension)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(careerImagePath("photo", extension))).toEqual(Buffer.from(bytes));
  }
  for (const bytes of [Buffer.from("GIF89a"), Buffer.from("plain text")]) {
    const response = await uploadImage(imageRequest(bytes));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: "bad_type" });
  }
  const oversized = await uploadImage(imageRequest(Buffer.concat([png, Buffer.alloc(IMAGE_LIMIT)])));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ ok: false, error: "too_large" });
  expect(fs.readFileSync(careerImagePath("photo", "jpg"))).toEqual(Buffer.from(jpeg));
  expect((await uploadImage(imageRequest(png, "signature"))).status).toBe(200);
  expect(await actions.imageStateAction({})).toEqual({ ok: true, photo: true, signature: true });
  const unsaved = document();
  const shown = await preview(jsonRequest({ document: unsaved, doc: "resume" }));
  expect(((await shown.json()) as { html: string }).html.includes('src="data:image/jpeg;base64,')).toBe(true);
  unsaved.hide_contact = ["photo"];
  const hidden = await preview(jsonRequest({ document: unsaved, doc: "resume" }));
  expect(((await hidden.json()) as { html: string }).html.includes('src="data:image')).toBe(false);
  expect(await actions.deleteImageAction({ kind: "signature" })).toEqual({ ok: true });
  const removed = await removeImage(imageRequest(undefined, "photo", "DELETE"));
  expect(removed.status).toBe(200);
  expect(removed.headers.get("Cache-Control")).toBe("no-store");
  expect(await actions.imageStateAction({})).toEqual({ ok: true, photo: false, signature: false });
});

it("rejects invalid image query and content type without changing the tree", async () => {
  const before = tree();
  for (const query of ["", "?kind=../photo", "?kind=photo&kind=signature", "?kind=photo&extra=true"]) {
    for (const method of ["POST", "DELETE"]) {
      const request = new Request(`http://localhost/api/career/images${query}`, { method });
      const response = await (method === "POST" ? uploadImage(request) : removeImage(request));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  expect((await uploadImage(new Request("http://localhost/api/career/images?kind=photo", { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from(imagePng()) }))).status).toBe(415);
  expect(tree()).toEqual(before);
});

it("applies saved preferences only to new documents and rejects stale preference writes", async () => {
  await seedProfile();
  const first = await createLoaded();
  const loaded = await actions.loadPreferencesAction({});
  if (!loaded.ok) throw new Error(loaded.code);
  const preferences = { ...loaded.preferences, layout: { ...loaded.preferences.layout, lang: "de" as const, theme: "minimal" as const }, tone: "Concise" };
  const saved = await actions.savePreferencesAction({ preferences, baseHash: loaded.baseHash });
  expect(saved).toMatchObject({ ok: true, preferences });
  expect(await actions.savePreferencesAction({ preferences, baseHash: loaded.baseHash })).toEqual({ ok: false, code: "stale" });
  expect((await createLoaded()).document.layout).toMatchObject(preferences.layout);
  expect(await actions.loadDocumentAction({ id: first.document.id })).toMatchObject({ ok: true, document: first.document });
});
