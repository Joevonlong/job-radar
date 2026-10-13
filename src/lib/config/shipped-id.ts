/**
 * The identity of a shipped defaults directory (`config/`): which exact files a process reads its defaults from.
 *
 * The manifest has one line per regular file, `<sha256>  ./<relative path>`, sorted by path in byte order (`LC_ALL=C`), so it
 * is what `find . -type f | LC_ALL=C sort | xargs sha256sum` prints in that directory. `.DS_Store` and `._*` files (macOS
 * noise) are left out at any depth. A symbolic link, or a name with a newline or a backslash (which `sha256sum` would escape),
 * is an error instead of a guess. The identity is the sha256 of the manifest; people see its first 12 characters.
 *
 * The web, the runner and the ai-worker report the identity of the directory they run with (`shipped_config:<process>` in
 * `runtime_state`); `pnpm run doctor` checks that each report comes from the process running now, and `pnpm config:check`
 * prints it.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/** Characters of the identity shown to people (`config:check`, the doctor, the logs). */
export const SHIPPED_CONFIG_ID_SHORT_LENGTH = 12;

/** A shipped defaults directory that cannot be identified (missing, a symlink inside, an unsupported file name). */
export class ShippedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippedConfigError";
  }
}

const isNoise = (name: string): boolean => name === ".DS_Store" || name.startsWith("._");

function checkName(relative: string): void {
  if (/[\n\\]/.test(relative)) throw new ShippedConfigError(`unsupported file name (newline or backslash): ${JSON.stringify(relative)}`);
}

async function collect(root: string, relative: string, files: string[]): Promise<void> {
  const names = await readdir(relative === "" ? root : path.join(root, relative));
  for (const name of names) {
    const child = relative === "" ? name : `${relative}/${name}`;
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new ShippedConfigError(`symbolic link in the shipped config: ./${child}`);
    if (info.isDirectory()) {
      checkName(child);
      await collect(root, child, files);
    } else if (info.isFile() && !isNoise(name)) {
      checkName(child);
      files.push(child);
    }
  }
}

/** Byte order of the UTF-8 paths, the order of `LC_ALL=C sort`. */
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The manifest of `dir` (see the module comment); every line ends with `\n`. Throws `ShippedConfigError`. */
export async function shippedConfigManifest(dir: string): Promise<string> {
  let info;
  try {
    info = await stat(dir);
  } catch {
    throw new ShippedConfigError(`the shipped config directory does not exist: ${dir}`);
  }
  if (!info.isDirectory()) throw new ShippedConfigError(`the shipped config path is not a directory: ${dir}`);
  const files: string[] = [];
  await collect(dir, "", files);
  files.sort(byteOrder);
  let manifest = "";
  for (const file of files) manifest += `${sha256(await readFile(path.join(dir, file)))}  ./${file}\n`;
  return manifest;
}

/** The identity of `dir`: the sha256 (64 hex characters) of its manifest. Throws `ShippedConfigError`. */
export async function shippedConfigId(dir: string): Promise<string> {
  return sha256(await shippedConfigManifest(dir));
}

/** The part of an identity people see. */
export function shortShippedConfigId(id: string): string {
  return id.slice(0, SHIPPED_CONFIG_ID_SHORT_LENGTH);
}

// ---------------------------------------------------------------- reports

/** The processes that report the shipped config they run with. */
export const SHIPPED_CONFIG_PROCESSES = ["web", "runner", "ai-worker"] as const;
export type ShippedConfigProcess = (typeof SHIPPED_CONFIG_PROCESSES)[number];

/**
 * What a process reports (`runtime_state` key `shipped_config:<process>`; the row's `updated_at` is the database clock).
 * `instance` is the host name: in a container, the start of the container id. `release` is the commit of the directory
 * the process runs from, when it runs from a release directory.
 */
export const shippedConfigReportSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  dir: z.string().min(1),
  instance: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  release: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
export type ShippedConfigReport = z.infer<typeof shippedConfigReportSchema>;
