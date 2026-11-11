import fsp from "node:fs/promises";
import { stringify } from "yaml";
import { commitConfigFile } from "@/lib/config/atomic";
import { readUserFile } from "@/lib/config/read-user-file";
import { parseConfigYaml } from "@/lib/config/yaml-options";
import { withFileLock } from "@/lib/config/write";
import { lockLostError, withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { careerDocumentPath } from "../store/paths";
import { proposalsSchema, type Proposals } from "./proposal-schema";

export const proposalsPath = (id: string) => careerDocumentPath(id).replace(/\.yaml$/, ".proposals.yaml");
export async function readProposals(id: string): Promise<Proposals | null> {
  const file = proposalsPath(id);
  return withConfigWriteLock(async () => {
    try {
      const result = proposalsSchema.parse(parseConfigYaml(readUserFile(file).toString("utf8")));
      if (result.doc_id !== id) throw new CareerStoreError("proposal_invalid");
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CareerStoreError("proposal_invalid");
    }
  }, file);
}

/** Publication and guarded completion share the deletion lock; incomplete output is removed before unlocking. */
export async function writeProposals(raw: Proposals, canWrite: () => Promise<boolean>, complete: () => Promise<boolean>): Promise<boolean> {
  const data = proposalsSchema.parse(raw);
  const file = proposalsPath(data.doc_id);
  return withFileLock(file, () => withConfigWriteLock(async (lock) => {
    if (!(await canWrite())) return false;
    let published = false;
    let completed = false;
    try {
      await commitConfigFile(file, stringify(data));
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

/** A review step that started from the generation snapshot moves the snapshot along, so only edits made elsewhere show as a change; a null id removes nothing. */
export async function removeProposal(docId: string, proposalId: string | null, rebase?: { from: string; to: string }): Promise<void> {
  const file = proposalsPath(docId);
  await withFileLock(file, () => withConfigWriteLock(async () => {
    const current = await readProposals(docId);
    if (!current || proposalId === null && current.doc_hash !== rebase?.from) return;
    current.items = current.items.filter((item) => item.id !== proposalId);
    if (rebase && current.doc_hash === rebase.from) current.doc_hash = rebase.to;
    await commitConfigFile(file, stringify(current));
  }, file));
}
