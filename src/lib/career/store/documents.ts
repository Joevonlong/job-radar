import fsp from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

import { commitConfigFile, sha256 } from "@/lib/config/atomic";
import { ConfigError } from "@/lib/config/errors";
import { reloadConfig } from "@/lib/config/load";
import { readUserFile } from "@/lib/config/read-user-file";
import { withFileLock } from "@/lib/config/write";
import { lockLostError, withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { applyDocumentEdit, applyDocumentRestore, prepareDocumentCreation } from "../document/edit";
import { rerunClaims, survivingClaims } from "../document/claims";
import { loadCareerProfile } from "./profile";
import { documentIdSchema, parseStoredDocument, type CareerDocument } from "../schema/document";
import { listVersions, prune, versionIdSchema, writeVersion, type CareerVersion } from "./history";
import { careerDocumentHistoryDir, careerDocumentPath, careerDocumentsDir } from "./paths";

export type DocumentSummary = {
  id: string; title: string; kind: CareerDocument["kind"]; updatedAt: string; lang: CareerDocument["layout"]["lang"];
  jobId: number | null;
} | { id: string; invalid: true };
export interface LoadedDocument { document: CareerDocument; baseHash: string }
export type DocumentSaveResult = ({ ok: true; warnings: "history_failed"[] } & LoadedDocument) | { ok: false; code: "stale" };

export async function listDocuments(): Promise<DocumentSummary[]> {
  let files: string[];
  try {
    files = await fsp.readdir(careerDocumentsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CareerStoreError("document_invalid");
  }
  const summaries: DocumentSummary[] = [];
  for (const file of files.sort()) {
    const id = path.basename(file, ".yaml");
    if (!file.endsWith(".yaml") || !documentIdSchema.safeParse(id).success) continue;
    try {
      const { document } = await loadDocument(id);
      summaries.push({
        id, title: document.title, kind: document.kind, updatedAt: document.updated_at, lang: document.layout.lang,
        jobId: document.job?.id ?? null,
      });
    } catch {
      summaries.push({ id, invalid: true });
    }
  }
  return summaries.sort((a, b) => "invalid" in a ? ("invalid" in b ? a.id.localeCompare(b.id) : 1)
    : "invalid" in b ? -1 : Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

export interface JobDocument { id: string; title: string; updatedAt: string; jdChanged: boolean }

/** Documents tailored for one job, newest first; any unreadable directory or document fails the whole list. */
export async function listJobDocuments(jobId: number, jdHash: string | null): Promise<JobDocument[]> {
  let files: string[];
  try {
    files = await fsp.readdir(careerDocumentsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CareerStoreError("document_invalid");
  }
  const ids = files.filter((file) => file.endsWith(".yaml")).map((file) => path.basename(file, ".yaml"))
    .filter((id) => documentIdSchema.safeParse(id).success).sort();
  const found: JobDocument[] = [];
  for (const id of ids) {
    const { document } = await loadDocument(id);
    if (document.job?.id !== jobId) continue;
    found.push({ id, title: document.title, updatedAt: document.updated_at, jdChanged: jdHash !== null && document.job.jd_hash !== jdHash });
  }
  return found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function loadDocument(id: string): Promise<LoadedDocument> {
  const file = careerDocumentPath(id);
  try {
    const text = readUserFile(file).toString("utf8");
    const document = parseStoredDocument(parse(text));
    if (document.id !== id) throw new CareerStoreError("document_invalid");
    return { document, baseHash: sha256(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CareerStoreError("document_missing");
    throw new CareerStoreError("document_invalid");
  }
}

/** The global config lock serializes the count and publication across different document ids. */
export async function createDocument(raw: unknown): Promise<Extract<DocumentSaveResult, { ok: true }>> {
  const document = prepareDocumentCreation(raw);
  const file = careerDocumentPath(document.id);
  return withFileLock(file, async () => {
    const config = reloadConfig("career");
    if (document.requirements.length > config.tailor.max_requirements || document.requirements.some((text) => text.length > config.tailor.requirement_max_chars)) throw new CareerStoreError("limits");
    const text = stringify(document);
    try {
      await withConfigWriteLock(async () => {
        if ((await listDocuments()).length >= config.document.max_documents) throw new CareerStoreError("document_limit");
        const result = await commitConfigFile(file, text, { mode: "create", baseSha256: null });
        if (result !== "written") throw new CareerStoreError("unknown_id");
      }, file);
    } catch (error) {
      if (error instanceof CareerStoreError) throw error;
      throw new CareerStoreError("write_failed");
    }
    const warnings = await recordHistory(document.id, text, config.history.keep_versions);
    return { ok: true, document, baseHash: sha256(text), warnings };
  });
}

export async function saveDocument(id: string, incoming: unknown, { baseHash }: { baseHash: string }): Promise<DocumentSaveResult> {
  return persistDocument(id, baseHash, async (current) => checkClaims(current, applyDocumentEdit(current, incoming, new Date().toISOString())));
}

export async function restoreDocumentVersion(id: string, version: string, { baseHash }: { baseHash: string }): Promise<DocumentSaveResult> {
  return persistDocument(id, baseHash, async (current) => {
    const restored = await readDocumentVersion(id, version);
    return checkClaims(restored, applyDocumentRestore(current, restored, new Date().toISOString()));
  });
}

/** Claims are checked against the profile when it can be read; an unreadable profile keeps saves working with the claims whose texts survive. */
async function checkClaims(before: CareerDocument, after: CareerDocument): Promise<CareerDocument> {
  const config = reloadConfig("career");
  const profile = await loadCareerProfile().then((loaded) => loaded.profile, () => null);
  return profile ? rerunClaims(before, after, profile, config) : { ...after, claims: survivingClaims(after, config) };
}

export async function persistDocument(
  id: string, baseHash: string, edit: (current: CareerDocument) => CareerDocument | Promise<CareerDocument>,
  afterSave: (baseHash: string) => Promise<void> = async () => {},
): Promise<DocumentSaveResult> {
  const file = careerDocumentPath(id);
  return withFileLock(file, async () => {
    const current = await loadDocument(id);
    if (baseHash !== current.baseHash) return { ok: false, code: "stale" };
    const config = reloadConfig("career");
    const edited = await edit(current.document);
    if (edited.requirements.length > config.tailor.max_requirements || edited.requirements.some((text) => text.length > config.tailor.requirement_max_chars)) throw new CareerStoreError("limits");
    const unchanged = stringify({ ...edited, updated_at: current.document.updated_at }) === stringify(current.document);
    const document = unchanged ? current.document : edited;
    const text = stringify(document);
    try {
      await withConfigWriteLock(async () => {
        if (unchanged) {
          if (sha256(readUserFile(file)) !== baseHash) throw new ConfigError({ configName: "career", filePath: file, kind: "stale" });
        } else await commitConfigFile(file, text, { baseSha256: baseHash });
      }, file);
    } catch (error) {
      if (error instanceof ConfigError && error.kind === "stale") return { ok: false, code: "stale" };
      throw new CareerStoreError("write_failed");
    }
    if (unchanged) { await afterSave(current.baseHash); return { ok: true, ...current, warnings: [] }; }
    const warnings = await recordHistory(id, text, config.history.keep_versions);
    await afterSave(sha256(text));
    return { ok: true, document, baseHash: sha256(text), warnings };
  });
}

async function recordHistory(id: string, text: string, keep: number): Promise<"history_failed"[]> {
  try {
    const directory = careerDocumentHistoryDir(id);
    await withConfigWriteLock(async () => {
      try {
        if (sha256(readUserFile(careerDocumentPath(id))) !== sha256(text)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await writeVersion(text, directory);
      await prune(keep, directory);
    }, directory);
    return [];
  } catch {
    return ["history_failed"];
  }
}

export async function listDocumentVersions(id: string): Promise<CareerVersion[]> {
  return listVersions(careerDocumentHistoryDir(id));
}

export async function readDocumentVersion(id: string, versionId: string): Promise<CareerDocument> {
  const directory = careerDocumentHistoryDir(id);
  if (!versionIdSchema.safeParse(versionId).success) throw new CareerStoreError("version_missing");
  try {
    const document = parseStoredDocument(parse(readUserFile(path.join(directory, versionId)).toString("utf8")));
    if (document.id !== id) throw new CareerStoreError("history_invalid");
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CareerStoreError("version_missing");
    throw new CareerStoreError("history_invalid");
  }
}

export async function deleteDocument(id: string): Promise<void> {
  const file = careerDocumentPath(id);
  await withFileLock(file, () => withConfigWriteLock(async (lock) => {
    for (const target of [file, file.replace(/\.yaml$/, ".proposals.yaml"), careerDocumentHistoryDir(id)]) {
      if (!(await lock.fence())) throw lockLostError(target);
      await fsp.rm(target, { recursive: true, force: true });
    }
  }, file));
}
