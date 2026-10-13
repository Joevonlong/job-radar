import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Every entry under a release directory, read with lstat (links are never followed): its path, type and permission
 * bits; for a file its sha256, for a link its target. One sorted line per entry, so two manifests compare with toEqual
 * and a difference names the entry.
 */
export function releaseTreeManifest(root: string): string[] {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel === "" ? root : path.join(root, rel);
    const st = fs.lstatSync(abs);
    const mode = (st.mode & 0o7777).toString(8).padStart(4, "0");
    const name = rel === "" ? "." : rel;
    if (st.isSymbolicLink()) {
      lines.push(`${name}\tlink\t${mode}\t${fs.readlinkSync(abs)}`);
    } else if (st.isDirectory()) {
      lines.push(`${name}\tdir\t${mode}`);
      for (const child of fs.readdirSync(abs)) walk(rel === "" ? child : path.join(rel, child));
    } else if (st.isFile()) {
      lines.push(`${name}\tfile\t${mode}\t${createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`);
    } else {
      lines.push(`${name}\tother\t${mode}`);
    }
  };
  walk("");
  return lines.sort();
}
