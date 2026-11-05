import fsp from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { commitConfigFile, sha256 } from "@/lib/config/atomic";
import { readUserFile } from "@/lib/config/read-user-file";
import { currentConfigWriteLock, lockLostError } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { parseStoredProfile, type CareerProfile } from "../schema/profile";
import { careerHistoryDir } from "./paths";

export const versionIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}\.yaml$/);
export interface CareerVersion {
  id: string;
  createdAt: string;
  hash: string;
}
const directory = () => path.join(careerHistoryDir(), "profile");

export async function listVersions(): Promise<CareerVersion[]> {
  try {
    const files = await fsp.readdir(directory());
    return files
      .filter((file) => versionIdSchema.safeParse(file).success)
      .sort()
      .reverse()
      .map((id) => ({
        id,
        createdAt: id.slice(0, 23).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3") + "Z",
        hash: id.slice(25, 33),
      }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CareerStoreError("history_invalid");
  }
}

export async function readVersion(rawId: string): Promise<CareerProfile> {
  if (!versionIdSchema.safeParse(rawId).success) throw new CareerStoreError("version_missing");
  try {
    return parseStoredProfile(parse(readUserFile(path.join(directory(), rawId)).toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CareerStoreError("version_missing");
    throw new CareerStoreError("history_invalid");
  }
}

/** Called under the profile's outer file lock and a separate config write lock. */
export async function writeVersion(text: string): Promise<void> {
  const versions = await listVersions();
  const last = versions[0]?.createdAt;
  const stamp = new Date(Math.max(Date.now(), last ? Date.parse(last) + 1 : 0)).toISOString().replaceAll(":", "-");
  await commitConfigFile(path.join(directory(), `${stamp}-${sha256(text).slice(0, 8)}.yaml`), text, { mode: "create" });
}

/** Retention is part of the history commit and holds its config write lock. */
export async function prune(keep: number): Promise<void> {
  const versions = await listVersions();
  for (const version of versions.slice(keep)) {
    const file = path.join(directory(), version.id);
    const lock = currentConfigWriteLock();
    if (!lock || !(await lock.fence())) throw lockLostError(file);
    await fsp.rm(file, { force: true });
  }
}
