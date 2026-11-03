// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARCHIVE_META_NAME, ARCHIVE_META_YAML, ARCHIVE_SETUP_SEMANTICS, readArchiveSetupSemantics } from "@/lib/ops/config-archive";
import { existingInstallSetupYaml, EXISTING_INSTALL_LANGUAGE_YAML } from "@/lib/setup/existing-install";

/**
 * `restore.sh` writes what a pre-wizard archive needs from `scripts/ops/lib/existing-install.sh` (no node there), and
 * `config:init --from` writes the same from `src/lib/setup/existing-install.ts`. The two must not drift apart.
 */
const LIB = path.resolve(import.meta.dirname, "../../scripts/ops/lib/existing-install.sh");
const NOW = new Date("2026-10-09T08:00:00.000Z");

function shell(...call: string[]) {
  const result = spawnSync("bash", ["-c", 'source "$1"; shift; "$@"', "bash", LIB, ...call], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("the texts", () => {
  it("setup.yaml: the shell function prints the TypeScript text byte for byte", () => {
    const result = shell("existing_install_setup_yaml", NOW.toISOString());
    expect(result.status).toBe(0);
    expect(result.out).toBe(existingInstallSetupYaml(NOW));
  });

  it("setup.yaml: the time is the only thing that differs between two stamps", () => {
    const other = new Date("2027-01-02T03:04:05.678Z");
    expect(shell("existing_install_setup_yaml", other.toISOString()).out).toBe(existingInstallSetupYaml(other));
  });

  it("language.yaml: the shell function prints the TypeScript text byte for byte", () => {
    const result = shell("existing_install_language_yaml");
    expect(result.status).toBe(0);
    expect(result.out).toBe(EXISTING_INSTALL_LANGUAGE_YAML);
  });

  it("the archive marker: the shell function prints the TypeScript text, and name and value agree", () => {
    expect(shell("archive_meta_yaml").out).toBe(ARCHIVE_META_YAML);
    const variables = spawnSync("bash", ["-c", `source "${LIB}"; printf '%s\\n%s' "$ARCHIVE_META_NAME" "$ARCHIVE_SETUP_SEMANTICS"`], { encoding: "utf8" });
    expect(variables.stdout).toBe(`${ARCHIVE_META_NAME}\n${ARCHIVE_SETUP_SEMANTICS}`);
  });

  it("the marker text carries the value the reader looks for", () => {
    expect(ARCHIVE_META_YAML).toMatch(new RegExp(`^setup_semantics: ${ARCHIVE_SETUP_SEMANTICS}$`, "m"));
  });
});

describe("reading the marker of an unpacked archive: shell and TypeScript agree", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "marker-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = () => path.join(dir, ARCHIVE_META_NAME);

  /** The shell's answer as the TypeScript reader gives it: the value, "none" (rc 3) or "unreadable" (rc 2). */
  function viaShell(): number | "none" | "unreadable" {
    const result = shell("archive_setup_semantics", dir);
    if (result.status === 3) return "none";
    if (result.status === 2) return "unreadable";
    expect(result.status).toBe(0);
    return Number(result.out.trim());
  }

  it.each([
    ["no marker", (): void => undefined, "none"],
    ["the generated marker", () => fs.writeFileSync(marker(), ARCHIVE_META_YAML), ARCHIVE_SETUP_SEMANTICS],
    ["another version number", () => fs.writeFileSync(marker(), "archive_meta_version: 1\nsetup_semantics: 7\n"), 7],
    ["a marker without the value", () => fs.writeFileSync(marker(), "archive_meta_version: 1\n"), "unreadable"],
    ["a value that is not a number", () => fs.writeFileSync(marker(), "setup_semantics: soon\n"), "unreadable"],
    ["an empty marker", () => fs.writeFileSync(marker(), ""), "unreadable"],
    ["a marker that is a directory", () => fs.mkdirSync(marker()), "unreadable"],
  ] as const)("%s", (_name, arrange, expected) => {
    arrange();
    expect(readArchiveSetupSemantics(dir)).toBe(expected);
    expect(viaShell()).toBe(expected);
  });
});
