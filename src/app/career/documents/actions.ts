"use server";

import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { readCareerGate } from "@/lib/config/career-gate";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { generateDocument } from "@/lib/career/document/generate";
import { sourceStates, type SourceStates } from "@/lib/career/document/resolve";
import { documentIdSchema, documentSchema, type CareerDocument } from "@/lib/career/schema/document";
import { preferencesSchema } from "@/lib/career/schema/preferences";
import { primaryText, profileEntryCount } from "@/lib/career/schema/profile";
import { createDocument, deleteDocument, listDocuments, listDocumentVersions, loadDocument, restoreDocumentVersion, saveDocument } from "@/lib/career/store/documents";
import { versionIdSchema } from "@/lib/career/store/history";
import { deleteImage, loadImages } from "@/lib/career/store/images";
import { loadPreferences, savePreferences } from "@/lib/career/store/preferences";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { logActionFailure } from "@/lib/logging/action-failure";

const emptyInput = z.strictObject({});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const idInput = z.strictObject({ id: documentIdSchema });
const createInput = z.strictObject({ title: documentSchema.shape.title.optional() });
const saveInput = z.strictObject({ id: documentIdSchema, document: documentSchema, baseHash: hash });
const restoreInput = z.strictObject({ id: documentIdSchema, version: versionIdSchema, baseHash: hash });
const deleteInput = z.strictObject({ id: documentIdSchema, confirmed: z.literal(true) });
const preferencesInput = z.strictObject({ preferences: preferencesSchema, baseHash: hash.nullable() });
const imageInput = z.strictObject({ kind: z.enum(["photo", "signature"]) });

function failure(action: string, error: unknown) {
  logActionFailure(action, error);
  return { ok: false as const, code: error instanceof CareerStoreError ? error.code : "write_failed" };
}

async function currentStates(document: CareerDocument): Promise<{ states: SourceStates; warnings: "profile_unreadable"[] }> {
  try {
    const current = await loadCareerProfile();
    return { states: sourceStates(document, current.profile, current.baseHash), warnings: [] };
  } catch (error) {
    logActionFailure("documentSourceStates", error);
    return { states: { profileChanged: false, texts: {}, entries: {} }, warnings: ["profile_unreadable"] };
  }
}

export async function listDocumentsAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  if (!emptyInput.safeParse(input).success) return { ok: false as const, code: "document_invalid" };
  try { return { ok: true as const, documents: await listDocuments() }; }
  catch (error) { return failure("listCareerDocuments", error); }
}

export async function createDocumentAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "document_invalid" };
  try {
    const { profile, baseHash } = await loadCareerProfile();
    if (baseHash === null || (!profileEntryCount(profile) && !primaryText(profile.headline).trim() && !primaryText(profile.summary).trim()))
      return { ok: false as const, code: "profile_empty" };
    const { preferences } = await loadPreferences();
    const title = parsed.data.title ?? (await getTranslations("career.documents"))("defaultTitle");
    const saved = await createDocument(generateDocument(profile, baseHash, preferences.layout, new Date().toISOString(), title));
    return { ok: true as const, id: saved.document.id, warnings: saved.warnings };
  } catch (error) { return failure("createCareerDocument", error); }
}

export async function loadDocumentAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = idInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "document_invalid" };
  try {
    const loaded = await loadDocument(parsed.data.id);
    return { ok: true as const, ...loaded, ...await currentStates(loaded.document) };
  } catch (error) { return failure("loadCareerDocument", error); }
}

export async function saveDocumentAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "document_invalid" };
  try {
    const saved = await saveDocument(parsed.data.id, parsed.data.document, { baseHash: parsed.data.baseHash });
    if (!saved.ok) return saved;
    const current = await currentStates(saved.document);
    return { ...saved, states: current.states, warnings: [...saved.warnings, ...current.warnings] };
  } catch (error) { return failure("saveCareerDocument", error); }
}

export async function deleteDocumentAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = deleteInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "confirmation_required" };
  try { await deleteDocument(parsed.data.id); return { ok: true as const }; }
  catch (error) { return failure("deleteCareerDocument", error); }
}

export async function documentHistoryAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = idInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "history_invalid" };
  try { return { ok: true as const, versions: await listDocumentVersions(parsed.data.id) }; }
  catch (error) { return failure("careerDocumentHistory", error); }
}

export async function restoreDocumentVersionAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = restoreInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "history_invalid" };
  try {
    const saved = await restoreDocumentVersion(parsed.data.id, parsed.data.version, { baseHash: parsed.data.baseHash });
    if (!saved.ok) return saved;
    const current = await currentStates(saved.document);
    return { ...saved, states: current.states, warnings: [...saved.warnings, ...current.warnings] };
  } catch (error) { return failure("restoreCareerDocument", error); }
}

export async function loadPreferencesAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  if (!emptyInput.safeParse(input).success) return { ok: false as const, code: "preferences_invalid" };
  try { return { ok: true as const, ...await loadPreferences() }; }
  catch (error) { return failure("loadCareerPreferences", error); }
}

export async function savePreferencesAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = preferencesInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "preferences_invalid" };
  try { return await savePreferences(parsed.data.preferences, { baseHash: parsed.data.baseHash }); }
  catch (error) { return failure("saveCareerPreferences", error); }
}

export async function deleteImageAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = imageInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "image_invalid" };
  try { await deleteImage(parsed.data.kind); return { ok: true as const }; }
  catch (error) { return failure("deleteCareerImage", error); }
}

export async function imageStateAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  if (!emptyInput.safeParse(input).success) return { ok: false as const, code: "image_invalid" };
  try {
    const images = await loadImages();
    return { ok: true as const, photo: images.photo !== undefined, signature: images.signature !== undefined };
  } catch (error) { return failure("careerImageState", error); }
}
