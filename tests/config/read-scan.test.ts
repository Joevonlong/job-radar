import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A file of the user's directories can be replaced by a process on the other side of a bind mount, and a plain read can
 * then answer ENOENT for a file that is there (`src/lib/config/read-user-file.ts`). Every direct read in the code that
 * handles those files is listed here with what it reads; a new one fails until someone decides.
 */
const REPO = path.resolve(import.meta.dirname, "../..");
const SCANNED = ["src/lib/config", "src/lib/setup", "src/lib/profile", "src/lib/settings", "src/lib/security"];

const ALLOWED = new Map<string, string>([
  ["src/lib/config/read-user-file.ts", "the reader itself"],
  ["src/lib/config/atomic.ts", "reads back its own temp file"],
  ["src/lib/config/examples.ts", "shipped files"],
  ["src/lib/config/load.ts", "the shipped models.yaml"],
  ["src/lib/config/models-overlay.ts", "the shipped models.yaml"],
  ["src/lib/config/paths.ts", "package.json of the app"],
  ["src/lib/config/private-file.ts", "a shipped template"],
  ["src/lib/config/protected-check.ts", "shipped files"],
  ["src/lib/config/shipped-id.ts", "shipped files"],
  ["src/lib/settings/advanced/service.ts", "the shipped file a text is compared with"],
  ["src/lib/settings/advanced/view.ts", "the shipped file shown next to the user's"],
  ["src/lib/setup/cli.ts", "the answers file named on the command line"],
  ["src/lib/setup/env-file.ts", ".env and .env.example, on the host"],
  ["src/lib/setup/steps/targets.ts", "shipped search.yaml"],
  ["src/lib/setup/state.ts", "the shipped setup.yaml"],
]);

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true, recursive: true }).flatMap((entry) => {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
    return [path.relative(REPO, path.join(entry.parentPath, entry.name))];
  });
}

describe("reads of the user's config and profile files", () => {
  it("go through readUserFile, apart from the listed reads", () => {
    const direct = SCANNED.flatMap(sources).filter((file) => /\b(?:fs|fsp)\.readFile(?:Sync)?\(|\breadFile(?:Sync)?\(\s*(?:\/\*|path\.)/.test(fs.readFileSync(path.join(REPO, file), "utf8")));
    expect(direct.filter((file) => !ALLOWED.has(file))).toEqual([]);
    expect([...ALLOWED.keys()].filter((file) => !direct.includes(file))).toEqual([]);
  });
});
