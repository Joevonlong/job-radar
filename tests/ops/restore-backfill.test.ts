// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configRegistry, installedConfigFiles, LAYERED_CONFIG_NAMES, parseConfigText } from "@/lib/config";
import { ARCHIVE_META_YAML } from "@/lib/ops/config-archive";
import { tarChunks } from "@/lib/ops/tar";
import { EXISTING_INSTALL_LANGUAGE_YAML } from "@/lib/setup/existing-install";

import { REAL_CONFIG_LIB } from "./config-reader";
import { createRestoreHarness, type RestoreHarness } from "./restore-harness";

/**
 * `restore.sh --with-config` puts back an archive. One made before the setup wizard (no marker) must not send the install
 * into the wizard: when it holds config files but no setup.yaml, a completed one is written (and the old language.yaml
 * when that is missing too). An archive that carries the marker is restored as it is. All in a throw-away checkout with a
 * stub `docker` and stubs for everything that would touch the machine (launchd, systemd): `restore-harness.ts`.
 */
const MARKER = "data/config/.archive-meta.yaml";

let harness: RestoreHarness;
beforeEach(() => { harness = createRestoreHarness(); });
afterEach(() => harness.cleanup());
const live = (file: string) => harness.live(file);

/** The archive next to the dump, from member name -> text. */
function archive(members: Record<string, string>): void {
  const files = Object.entries(members).map(([name, text]) => ({ name, data: Buffer.from(text) }));
  fs.writeFileSync(harness.dump.replace(/\.dump$/, ".config.tgz"), gzipSync(Buffer.concat([...tarChunks(files)])));
}

const restore = (options: { noNode?: boolean } = {}) => harness.restore(options);

const WIZARD_WARNING = "predates the setup wizard";
const PENDING_SETUP = "config_version: 1\ncompleted_at: null\n";

describe("restore.sh --with-config and an archive from before the setup wizard", () => {
  it("config files but no setup.yaml and no language.yaml: both are written, completed, with a warning", () => {
    archive({ "data/config/ui.yaml": "ui\n", "data/config/schedule.yaml": "timezone: UTC\n", "data/profile/me.yaml": "me\n" });
    const before = Date.now();
    const result = restore();
    expect(result.stderr).toContain(WIZARD_WARNING);
    const setup = parseConfigText("setup", fs.readFileSync(live("setup.yaml"), "utf8"));
    expect(setup).toMatchObject({ completed_by: "existing_install", steps: {} });
    expect(Date.parse(setup.completed_at ?? "")).toBeGreaterThanOrEqual(before - 2000);
    expect(Date.parse(setup.completed_at ?? "")).toBeLessThanOrEqual(Date.now() + 2000);
    expect(fs.readFileSync(live("language.yaml"), "utf8")).toBe(EXISTING_INSTALL_LANGUAGE_YAML);
    expect(fs.statSync(live("setup.yaml")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(live("language.yaml")).mode & 0o777).toBe(0o600);
    // the restored files themselves
    expect(fs.readFileSync(live("ui.yaml"), "utf8")).toBe("ui\n");
  });

  it("only setup.yaml missing: only it is written, the archive's language.yaml stays as it is", () => {
    archive({ "data/config/ui.yaml": "ui\n", "data/config/language.yaml": "ui:\n  default_locale: en\n" });
    expect(restore().stderr).toContain(WIZARD_WARNING);
    expect(fs.readFileSync(live("language.yaml"), "utf8")).toBe("ui:\n  default_locale: en\n");
    expect(parseConfigText("setup", fs.readFileSync(live("setup.yaml"), "utf8")).completed_by).toBe("existing_install");
  });

  it("a setup.yaml in the archive is restored as it is, pending or not, and nothing else is added", () => {
    archive({ "data/config/ui.yaml": "ui\n", "data/config/setup.yaml": PENDING_SETUP });
    const result = restore();
    expect(result.stderr).not.toContain(WIZARD_WARNING);
    expect(fs.readFileSync(live("setup.yaml"), "utf8")).toBe(PENDING_SETUP);
    expect(fs.existsSync(live("language.yaml"))).toBe(false);
  });

  it("no layered config file in the archive (only the profile and other files): nothing is written", () => {
    archive({ "data/config/notes.txt": "x\n", "data/profile/me.yaml": "me\n" });
    const result = restore();
    expect(result.stderr).not.toContain(WIZARD_WARNING);
    expect(fs.existsSync(live("setup.yaml"))).toBe(false);
    expect(fs.existsSync(live("language.yaml"))).toBe(false);
  });

  it("a single layered file is enough to count as an install", () => {
    archive({ "data/config/traps.yaml": "x\n" });
    restore();
    expect(fs.existsSync(live("setup.yaml"))).toBe(true);
  });

  it("without node the result is the same", () => {
    archive({ "data/config/ui.yaml": "ui\n" });
    const result = restore({ noNode: true });
    expect(result.stderr).toContain("node is not installed");
    expect(result.stderr).toContain(WIZARD_WARNING);
    expect(parseConfigText("setup", fs.readFileSync(live("setup.yaml"), "utf8")).completed_by).toBe("existing_install");
    expect(fs.readFileSync(live("language.yaml"), "utf8")).toBe(EXISTING_INSTALL_LANGUAGE_YAML);
  });
});

describe("restore.sh --with-config and an archive that carries the marker", () => {
  it("a missing setup.yaml means the wizard is pending: nothing is written, no warning, and the marker is not restored", () => {
    archive({ "data/config/ui.yaml": "ui\n", [MARKER]: ARCHIVE_META_YAML });
    const result = restore();
    expect(result.stderr).not.toContain(WIZARD_WARNING);
    expect(fs.existsSync(live("setup.yaml"))).toBe(false);
    expect(fs.existsSync(live("language.yaml"))).toBe(false);
    expect(fs.existsSync(live(".archive-meta.yaml"))).toBe(false);
    expect(fs.readFileSync(live("ui.yaml"), "utf8")).toBe("ui\n");
  });

  it("with a setup.yaml: both files come back byte for byte", () => {
    archive({ "data/config/setup.yaml": PENDING_SETUP, "data/config/ui.yaml": "ui\n", [MARKER]: ARCHIVE_META_YAML });
    restore();
    expect(fs.readFileSync(live("setup.yaml"), "utf8")).toBe(PENDING_SETUP);
    expect(fs.readFileSync(live("ui.yaml"), "utf8")).toBe("ui\n");
    expect(fs.existsSync(live(".archive-meta.yaml"))).toBe(false);
  });

  it("a marker that cannot be read: a warning, nothing is guessed, and the marker is not restored", () => {
    archive({ "data/config/ui.yaml": "ui\n", [MARKER]: "archive_meta_version: 1\n" });
    const result = restore();
    expect(result.stderr).toContain("marker is unreadable");
    expect(result.stderr).not.toContain(WIZARD_WARNING);
    expect(fs.existsSync(live("setup.yaml"))).toBe(false);
    expect(fs.existsSync(live(".archive-meta.yaml"))).toBe(false);
  });
});

describe("the list of layered config files", () => {
  const fromShell = (): string[] => {
    const result = spawnSync("bash", ["-c", `source "${REAL_CONFIG_LIB}"; printf '%s\\n' $CFG_LAYERED_FILES`], { encoding: "utf8" });
    return result.stdout.split("\n").filter(Boolean);
  };

  it("CFG_LAYERED_FILES is the registry's layered files, no more and no fewer", () => {
    expect(fromShell().sort()).toEqual(LAYERED_CONFIG_NAMES.map((name) => configRegistry[name].file).sort());
  });

  it("the shell and the app agree on whether a directory holds a layered file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-"));
    try {
      const shellSays = () => spawnSync("bash", ["-c", `source "${REAL_CONFIG_LIB}"; stage_has_layered_config "${dir}"`]).status === 0;
      expect(shellSays()).toBe(false);
      expect(installedConfigFiles(dir)).toEqual([]);
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      expect(shellSays()).toBe(false);
      expect(installedConfigFiles(dir)).toEqual([]);
      for (const name of LAYERED_CONFIG_NAMES) {
        const file = path.join(dir, configRegistry[name].file);
        fs.writeFileSync(file, "x");
        expect(shellSays(), configRegistry[name].file).toBe(true);
        expect(installedConfigFiles(dir)).toEqual([configRegistry[name].file]);
        fs.rmSync(file);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
