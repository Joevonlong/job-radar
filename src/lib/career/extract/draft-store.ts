/**
 * Draft publication and request completion run under the career deletion lock. After the file commit, cancellation and
 * request state are checked again, then a guarded terminal update claims success. If either check or completion fails,
 * the published draft is removed before releasing the lock, so locked readers cannot review a failed request's draft.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";

import { commitConfigFile } from "@/lib/config/atomic";
import { loadConfig } from "@/lib/config";
import { readUserFile } from "@/lib/config/read-user-file";
import { parseConfigYaml } from "@/lib/config/yaml-options";
import { withFileLock } from "@/lib/config/write";
import { currentConfigWriteLock, lockLostError, withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { careerDir } from "../store/paths";
import { draftSectionsSchema } from "./verify";

export const draftIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const careerDraftSchema = z.strictObject({
  schema_version: z.literal(1), request_id: draftIdSchema, origin: z.enum(["resume", "self_description", "imported"]),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.iso.datetime({ offset: true }), language: z.string().max(10).nullable(),
  sections: draftSectionsSchema,
});
export type CareerDraft = z.infer<typeof careerDraftSchema>;
export const careerDraftDir = () => path.join(careerDir(), "drafts");
export const careerDraftPath = (id: number) => path.join(careerDraftDir(), `${draftIdSchema.parse(id)}.yaml`);

async function draftIds(): Promise<number[]> {
  try {
    return (await fsp.readdir(careerDraftDir()))
      .filter((file) => /^[1-9]\d*\.yaml$/.test(file))
      .map((file) => Number(file.slice(0, -5)))
      .filter((id) => draftIdSchema.safeParse(id).success)
      .sort((a, b) => b - a);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CareerStoreError("draft_invalid");
  }
}

export async function readCareerDraft(id: number): Promise<CareerDraft> {
  if (!draftIdSchema.safeParse(id).success) throw new CareerStoreError("draft_invalid");
  const file = careerDraftPath(id);
  return withConfigWriteLock(async () => {
    try {
      const draft = careerDraftSchema.parse(parseConfigYaml(readUserFile(file).toString("utf8")));
      if (draft.request_id !== id) throw new CareerStoreError("draft_invalid");
      return draft;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CareerStoreError("draft_missing");
      throw new CareerStoreError("draft_invalid");
    }
  }, file);
}

async function pruneCareerDrafts(): Promise<void> {
  const cutoff = Date.now() - loadConfig("career").import.draft_ttl_days * 86400000;
  for (const id of await draftIds()) {
    const draft = await readCareerDraft(id);
    if (Date.parse(draft.created_at) >= cutoff) continue;
    const lock = currentConfigWriteLock();
    if (!lock || !(await lock.fence())) throw lockLostError(careerDraftDir());
    await fsp.rm(careerDraftPath(id), { force: true });
  }
}

export async function cleanupExpiredDrafts(): Promise<void> {
  await withConfigWriteLock(() => pruneCareerDrafts(), careerDraftDir());
}

export async function listPendingCareerDrafts(): Promise<CareerDraft[]> {
  return withConfigWriteLock(async () => {
    await pruneCareerDrafts();
    return Promise.all((await draftIds()).map(readCareerDraft));
  }, careerDraftDir());
}

export async function writeCareerDraft(
  raw: CareerDraft,
  canWrite: () => Promise<boolean>,
  complete: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  const draft = careerDraftSchema.parse(raw);
  const file = careerDraftPath(draft.request_id);
  return withFileLock(file, () => withConfigWriteLock(async (lock) => {
    if (!(await canWrite())) return false;
    await pruneCareerDrafts();
    let published = false;
    let completed = false;
    try {
      await commitConfigFile(file, stringify(draft));
      published = true;
      completed = await canWrite() && await complete();
      return completed;
    } finally {
      if (published && !completed) {
        if (!(await lock.fence())) throw lockLostError(file);
        await fsp.rm(file, { force: true });
      }
    }
  }, file));
}

export async function discardCareerDraft(id: number): Promise<void> {
  const file = careerDraftPath(id);
  await withFileLock(file, () => withConfigWriteLock(async (lock) => {
    if (!(await lock.fence())) throw lockLostError(file);
    await fsp.rm(file, { force: true });
  }, file));
}
