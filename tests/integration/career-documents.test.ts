import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { closeDb } from "@/lib/db";
import { createDocument, deleteDocument, listDocuments, listDocumentVersions, loadDocument, readDocumentVersion, saveDocument } from "@/lib/career/store/documents";
import { careerDir, careerDocumentHistoryDir, careerDocumentPath, careerDocumentsDir, careerImagePath, careerPreferencesPath } from "@/lib/career/store/paths";
import { deleteCareerData } from "@/lib/career/store/delete";
import { deleteImage, loadImages, saveImage } from "@/lib/career/store/images";
import { loadPreferences, savePreferences } from "@/lib/career/store/preferences";
import { parseStoredDocument } from "@/lib/career/schema/document";
import { listVersions } from "@/lib/career/store/history";
import { loadCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { tempCareer, profile } from "../career/fixtures";
import { document } from "../career/document-fixtures";

const url = inject("testDatabaseUrl");
let temp: ReturnType<typeof tempCareer>;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
beforeAll(() => { process.env.DATABASE_URL = url; });
beforeEach(() => { temp = tempCareer({ history: { keep_versions: 2 }, document: { max_documents: 3, image_max_bytes: 32 } }); });
afterEach(() => temp.cleanup());
afterAll(closeDb);

it("creates and saves through real locks with private modes, stable ids and readable versions", async () => {
  const created = await createDocument(document());
  const id = created.document.id;
  expect(created.warnings).toEqual([]);
  expect(await loadDocument(id)).toEqual({ document: created.document, baseHash: created.baseHash });
  const versions = await listDocumentVersions(id);
  expect(versions).toHaveLength(1);
  expect(await readDocumentVersion(id, versions[0]!.id)).toEqual(created.document);
  for (const file of [careerDocumentPath(id), path.join(careerDocumentHistoryDir(id), versions[0]!.id)]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const changed = await saveDocument(id, { ...created.document, title: "Changed" }, { baseHash: created.baseHash });
  expect(changed).toMatchObject({ ok: true, document: { id, title: "Changed" }, warnings: [] });
  expect((await loadDocument(id)).baseHash).not.toBe(created.baseHash);
});

it("assigns empty input ids before publication", async () => {
  const doc = document();
  doc.id = "";
  doc.experience[0]!.id = "";
  doc.headline!.id = "";
  const created = await createDocument(doc);
  expect(parseStoredDocument(created.document)).toEqual(created.document);
  expect(created.document.headline).toMatchObject({ source: null, origin: "user" });
  expect(created.document.experience[0]!.source).toBeNull();
});

it("serializes concurrent edits and rejects a stale second save", async () => {
  const created = await createDocument(document());
  const results = await Promise.all(["First", "Second"].map((title) => saveDocument(created.document.id, { ...created.document, title }, { baseHash: created.baseHash })));
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "stale" }]);
  expect(await listDocumentVersions(created.document.id)).toHaveLength(2);
});

it("does not rewrite or version unchanged content including ignored metadata", async () => {
  const created = await createDocument(document());
  const before = fs.statSync(careerDocumentPath(created.document.id)).mtimeMs;
  const saved = await saveDocument(created.document.id, { ...created.document, updated_at: "2020-01-01T00:00:00Z", job: { private: "ignored" }, claims: [{}] }, { baseHash: created.baseHash });
  expect(saved).toEqual(created);
  expect(fs.statSync(careerDocumentPath(created.document.id)).mtimeMs).toBe(before);
  expect(await listDocumentVersions(created.document.id)).toHaveLength(1);
});

it("prunes independently per document and preserves profile history behaviour", async () => {
  const first = await createDocument(document());
  const second = await createDocument(document());
  const oldest = (await listDocumentVersions(first.document.id))[0]!;
  let current = first;
  for (const title of ["One", "Two", "Three"]) {
    const saved = await saveDocument(current.document.id, { ...current.document, title }, { baseHash: current.baseHash });
    if (!saved.ok) throw new Error(saved.code);
    current = saved;
  }
  expect(await listDocumentVersions(first.document.id)).toHaveLength(2);
  expect(await listDocumentVersions(second.document.id)).toHaveLength(1);
  await expect(readDocumentVersion(first.document.id, oldest.id)).rejects.toThrow("version_missing");
  const savedProfile = await saveCareerProfile(profile(), { baseHash: null });
  expect(savedProfile.ok).toBe(true);
  expect(await listVersions()).toHaveLength(1);
  expect((await loadCareerProfile()).baseHash).not.toBeNull();
});

it("lists summaries in descending time order and isolates corrupt documents", async () => {
  const earlier = document();
  earlier.updated_at = "2025-01-01T00:00:00Z";
  const a = await createDocument(earlier);
  const b = await createDocument(document());
  const brokenId = "doc_aaaaaaaaaa";
  fs.writeFileSync(careerDocumentPath(brokenId), "private-sentinel: [broken");
  fs.writeFileSync(path.join(careerDocumentsDir(), `${b.document.id}.proposals.yaml`), "not a document");
  expect(await listDocuments()).toEqual([
    { id: b.document.id, title: b.document.title, kind: "general", updatedAt: b.document.updated_at, lang: b.document.layout.lang },
    { id: a.document.id, title: a.document.title, kind: "general", updatedAt: earlier.updated_at, lang: earlier.layout.lang },
    { id: brokenId, invalid: true },
  ]);
  await expect(loadDocument(brokenId)).rejects.toThrow("document_invalid");
  await expect(createDocument(document())).rejects.toThrow("document_limit");
  await expect(loadDocument("../profile")).rejects.toThrow("document_missing");
  await expect(deleteDocument("../profile")).rejects.toThrow("document_missing");
  await expect(readDocumentVersion(b.document.id, "../../profile.yaml")).rejects.toThrow("version_missing");
});

it("enforces the maximum across concurrent creation of different ids", async () => {
  await createDocument(document());
  await createDocument(document());
  const results = await Promise.allSettled([createDocument(document()), createDocument(document())]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "document_limit" } }]);
  expect(await listDocuments()).toHaveLength(3);
});

it("deletes a document, proposals and its history without deleting other documents", async () => {
  const a = await createDocument(document());
  const b = await createDocument(document());
  const proposals = careerDocumentPath(a.document.id).replace(/\.yaml$/, ".proposals.yaml");
  fs.writeFileSync(proposals, "proposals: []");
  await deleteDocument(a.document.id);
  for (const file of [careerDocumentPath(a.document.id), proposals, careerDocumentHistoryDir(a.document.id)]) expect(fs.existsSync(file)).toBe(false);
  expect((await loadDocument(b.document.id)).document).toEqual(b.document);
  await expect(loadDocument(a.document.id)).rejects.toThrow("document_missing");
  await deleteDocument(a.document.id);
});

it("detects image type from magic bytes, replaces extensions and uses private permissions", async () => {
  await saveImage("photo", png);
  expect(fs.statSync(careerImagePath("photo", "png")).mode & 0o777).toBe(0o600);
  expect(await loadImages()).toEqual({ photo: png });
  await saveImage("photo", jpg);
  expect(fs.existsSync(careerImagePath("photo", "png"))).toBe(false);
  expect(fs.statSync(careerImagePath("photo", "jpg")).mode & 0o777).toBe(0o600);
  await saveImage("signature", png);
  expect(await loadImages()).toEqual({ photo: jpg, signature: png });
  await saveImage("photo", png);
  expect(fs.existsSync(careerImagePath("photo", "jpg"))).toBe(false);
  await deleteImage("photo");
  expect(await loadImages()).toEqual({ signature: png });
  await deleteImage("signature");
  expect(await loadImages()).toEqual({});
});

it("rejects unsupported and oversized images without replacing stored bytes", async () => {
  await saveImage("photo", png);
  for (const bytes of [Buffer.from("GIF89a"), Buffer.from("RIFFxxxxWEBP"), Buffer.from("file.jpg"), png.subarray(0, 7)]) await expect(saveImage("photo", bytes)).rejects.toThrow("image_invalid");
  const oversized = Buffer.concat([png, Buffer.alloc(25)]);
  await expect(saveImage("photo", oversized)).rejects.toThrow("image_too_large");
  expect(await loadImages()).toEqual({ photo: png });
});

it("loads preferences from config, saves privately, and detects stale writes", async () => {
  const loaded = await loadPreferences();
  expect(loaded.baseHash).toBeNull();
  expect(fs.existsSync(careerPreferencesPath())).toBe(false);
  const first = await savePreferences(loaded.preferences, { baseHash: null });
  if (!first.ok) throw new Error(first.code);
  expect(await loadPreferences()).toEqual({ preferences: first.preferences, baseHash: first.baseHash });
  expect(fs.statSync(careerPreferencesPath()).mode & 0o777).toBe(0o600);
  expect(await savePreferences({ ...loaded.preferences, tone: "Concise" }, { baseHash: null })).toEqual({ ok: false, code: "stale" });
  expect(await savePreferences({ ...first.preferences, tone: "Concise" }, { baseHash: first.baseHash })).toMatchObject({ ok: true, preferences: { tone: "Concise" } });
  expect(await listVersions()).toEqual([]);
  await expect(savePreferences({ ...loaded.preferences, email: "private" }, { baseHash: first.baseHash })).rejects.toThrow("preferences_invalid");
});

it("removes documents, preferences, images and document history with all career data", async () => {
  const created = await createDocument(document());
  await savePreferences((await loadPreferences()).preferences, { baseHash: null });
  await saveImage("photo", png);
  await saveImage("signature", jpg);
  expect(fs.existsSync(careerDocumentHistoryDir(created.document.id))).toBe(true);
  await deleteCareerData();
  expect(fs.existsSync(careerDir())).toBe(false);
  expect(await listDocuments()).toEqual([]);
  expect(await loadImages()).toEqual({});
  expect((await loadPreferences()).baseHash).toBeNull();
  expect(fs.existsSync(careerDir())).toBe(false);
});
