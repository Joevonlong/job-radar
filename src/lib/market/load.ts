/**
 * Reading market packs. A pack lives in `<defaults dir>/packs/<id>/` (shipped with the product) and may be
 * replaced as a whole by a copy in `<user config dir>/packs/<id>/` (a copy wins only when it has a pack.yaml).
 * Packs are re-read when one of their files changes (size or mtime), so an edited pack applies without a restart.
 */
import fs from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";
import type { z } from "zod";

import { ConfigError, zodIssues } from "@/lib/config/errors";
import { getConfigDir, getDefaultsDir } from "@/lib/config/paths";

import { PACK_FILES, PACK_ID_PATTERN, type PackGeography, type PackLanguage, type PackMeta, type PackPart, type PackRules } from "./schema";

export const PACKS_DIR = "packs";

export interface Pack {
  meta: PackMeta;
  geography: PackGeography;
  language: PackLanguage;
  rules: PackRules;
  /** The directory it was read from. */
  dir: string;
  /** `user`: the copy in the user config directory; `shipped`: the defaults directory. */
  layer: "user" | "shipped";
}

/** `<user config dir>/packs/<id>` and `<defaults dir>/packs/<id>`. */
export function packDirs(id: string): { user: string; shipped: string } {
  return { user: path.join(getConfigDir(), PACKS_DIR, id), shipped: path.join(getDefaultsDir(), PACKS_DIR, id) };
}

/** The directory a pack is read from: the user copy when it has a pack.yaml, else the shipped one (null: neither exists). */
export function resolvePackDir(id: string): { dir: string; layer: Pack["layer"] } | null {
  if (!PACK_ID_PATTERN.test(id)) return null;
  const dirs = packDirs(id);
  if (fs.existsSync(/*turbopackIgnore: true*/ path.join(dirs.user, PACK_FILES.meta.file))) return { dir: dirs.user, layer: "user" };
  if (fs.existsSync(/*turbopackIgnore: true*/ path.join(dirs.shipped, PACK_FILES.meta.file))) return { dir: dirs.shipped, layer: "shipped" };
  return null;
}

/** Ids of the packs that exist (shipped and user copies), sorted. */
export function listPackIds(): string[] {
  const ids = new Set<string>();
  for (const base of [path.join(getDefaultsDir(), PACKS_DIR), path.join(getConfigDir(), PACKS_DIR)]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(/*turbopackIgnore: true*/ base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && PACK_ID_PATTERN.test(entry.name) && fs.existsSync(/*turbopackIgnore: true*/ path.join(base, entry.name, PACK_FILES.meta.file))) ids.add(entry.name);
    }
  }
  return [...ids].sort();
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Size and mtime of every pack file (missing files included), the cache key of a loaded pack. */
function signature(dir: string): string {
  return Object.values(PACK_FILES)
    .map(({ file }) => {
      try {
        const stat = fs.statSync(/*turbopackIgnore: true*/ path.join(dir, file));
        return `${file}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${file}:-`;
      }
    })
    .join("|");
}

function readPart<P extends PackPart>(id: string, dir: string, part: P): z.output<(typeof PACK_FILES)[P]["schema"]> {
  const { file, schema, required } = PACK_FILES[part];
  const filePath = path.join(dir, file);
  const configName = `${PACKS_DIR}/${id}/${file}`;
  let text: string;
  try {
    text = fs.readFileSync(/*turbopackIgnore: true*/ filePath, "utf8");
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "";
    if (code === "ENOENT" && !required) text = "{}";
    else throw new ConfigError({ configName, filePath, kind: code === "ENOENT" ? "missing" : "read", detail: code === "ENOENT" ? undefined : code || "read error" });
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const where = first?.linePos?.[0];
    const reason = (first?.message ?? "invalid YAML").split("\n")[0] ?? "invalid YAML";
    throw new ConfigError({ configName, filePath, kind: "yaml", detail: where ? `line ${where.line}, column ${where.col}: ${reason}` : reason });
  }
  const raw: unknown = doc.toJS() ?? {};
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError({ configName, filePath, kind: "schema", issues: zodIssues(result.error) });
  return result.data as z.output<(typeof PACK_FILES)[P]["schema"]>;
}

/** Read and validate the pack in `dir` (no cache). Throws ConfigError naming the file and the field paths. */
export function readPackDir(id: string, dir: string, layer: Pack["layer"]): Pack {
  const meta = readPart(id, dir, "meta");
  if (meta.id !== id) {
    throw new ConfigError({ configName: `${PACKS_DIR}/${id}/pack.yaml`, filePath: path.join(dir, PACK_FILES.meta.file), kind: "schema", issues: [{ path: "id", message: `must be "${id}" (the directory name)` }] });
  }
  return deepFreeze({ meta, geography: readPart(id, dir, "geography"), language: readPart(id, dir, "language"), rules: readPart(id, dir, "rules"), dir, layer });
}

const cache = new Map<string, { signature: string; pack: Pack }>();

/**
 * The pack with this id (user copy first, then the shipped one), validated and cached until one of its files changes.
 * Throws ConfigError(missing) when no such pack exists, or the error of the file that is invalid.
 */
export function loadPack(id: string): Pack {
  const found = resolvePackDir(id);
  if (found === null) {
    throw new ConfigError({ configName: `${PACKS_DIR}/${id}`, filePath: packDirs(id).shipped, kind: "missing", detail: "no such market pack" });
  }
  const sig = signature(found.dir);
  const hit = cache.get(found.dir);
  if (hit && hit.signature === sig) return hit.pack;
  const pack = readPackDir(id, found.dir, found.layer);
  cache.set(found.dir, { signature: sig, pack });
  return pack;
}

/** Drop the cached packs (tests, or after changing the config directories). */
export function resetPackCache(): void {
  cache.clear();
}

/** The pack that is always loaded under every market. */
export const GENERIC_PACK_ID = "generic";
