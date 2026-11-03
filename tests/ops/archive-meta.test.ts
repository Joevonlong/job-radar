// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARCHIVE_META_NAME, ARCHIVE_META_YAML, ARCHIVE_SETUP_SEMANTICS, listArchiveMembers, readArchiveSetupSemantics, writeConfigArchive } from "@/lib/ops/config-archive";
import { readTarGz } from "@/lib/ops/tar";

import { installConfigReader } from "./config-reader";
import { createRestoreHarness, type RestoreHarness } from "./restore-harness";

/**
 * The archive marker (`data/config/.archive-meta.yaml`, setup_semantics 2) in the archives `backup.sh` and
 * `config-archive.ts` write, packed by a real `tar` of both kinds (bsdtar on macOS, GNU tar on Linux) and put back by the
 * real `restore.sh`. A kind that this machine has neither natively nor as `gtar` / `bsdtar` is run in the pinned
 * Debian image when `docker` is on the PATH and the image is already pulled; otherwise that kind is skipped, with the reason
 * on stderr.
 */
const REPO = path.resolve(import.meta.dirname, "../..");
const BACKUP = path.join(REPO, "scripts/ops/backup.sh");
const EXISTING_LIB = path.join(REPO, "scripts/ops/lib/existing-install.sh");
const MARKER_MEMBER = `data/config/${ARCHIVE_META_NAME}`;
/** GNU tar for machines that have none: a Debian release, by name. */
const GNU_IMAGE = "debian:12-slim";

type Flavour = "bsdtar" | "gnu";

interface TarKind {
  flavour: Flavour;
  /** The command words that run this kind of tar; null: not available here. */
  command: string[] | null;
  skip: string | null;
  /** Mount for the container (the tests' temp root), when the tar runs in one. */
  container: boolean;
}

function output(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.error || result.status !== 0 ? null : `${result.stdout}${result.stderr}`;
}

const isBsdtar = (command: string): boolean => /bsdtar|libarchive/i.test(output(command, ["--version"]) ?? "");
const isGnuTar = (command: string): boolean => /GNU tar/i.test(output(command, ["--version"]) ?? "");
/** The absolute path of a command, or null. The shim must not name `tar` itself: it sits first on the PATH. */
const locate = (command: string): string | null => output("which", [command])?.trim().split("\n")[0] ?? null;
const onPath = (command: string): boolean => locate(command) !== null;

function resolveTar(flavour: Flavour): TarKind {
  const matches = flavour === "bsdtar" ? isBsdtar : isGnuTar;
  const candidates = flavour === "bsdtar" ? ["tar", "bsdtar"] : ["tar", "gtar"];
  const native = candidates.map(locate).find((found) => found !== null && matches(found));
  if (native !== undefined && native !== null) return { flavour, command: [native], skip: null, container: false };
  const docker = locate("docker");
  if (flavour === "gnu" && docker !== null && output(docker, ["image", "inspect", GNU_IMAGE]) !== null) {
    return { flavour, command: [docker, "run", "--rm", "--network", "none", "-u", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`], skip: null, container: true };
  }
  const reason = flavour === "bsdtar" ? "no bsdtar here (tar is not libarchive's, and there is no bsdtar)" : `no GNU tar here (no gtar, and ${onPath("docker") ? `the image ${GNU_IMAGE} is not pulled` : "no docker"})`;
  return { flavour, command: null, skip: reason, container: false };
}

// A tar in a container starts a process per call: a run takes tens of seconds, hence the long timeout of the cases below.
const KINDS = (["bsdtar", "gnu"] as const).map(resolveTar);
for (const kind of KINDS) if (kind.skip !== null) process.stderr.write(`archive-meta: the ${kind.flavour} cases are skipped: ${kind.skip}\n`);

/**
 * The temp directory under every spelling the scripts may use for it (`/var/...` and `/private/var/...` on macOS: `mktemp -d`
 * does not follow $TMPDIR there), so a tar in a container sees the same paths.
 */
const MOUNTS = [...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])];

/** Write an executable `tar` into `dir` that runs this kind of tar. */
function installTar(kind: TarKind, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const words = (kind.command ?? []).map((word) => `'${word}'`);
  const volumes = MOUNTS.map((mount) => `-v '${mount}:${mount}'`).join(" ");
  const script = kind.container
    ? `#!/usr/bin/env bash\nexec ${words.join(" ")} ${volumes} -w "$PWD" ${GNU_IMAGE} tar "$@"\n`
    : `#!/usr/bin/env bash\nexec ${words.join(" ")} "$@"\n`;
  fs.writeFileSync(path.join(dir, "tar"), script, { mode: 0o755 });
}

const DB_STUB = `#!/usr/bin/env bash
if [[ "$*" == *"ps --status running --services"* ]]; then echo db; exit 0; fi
if [[ "$*" == *to_char* ]]; then echo 20300102-030405; exit 0; fi
if [[ "$*" == *pg_dump* ]]; then printf 'PGDMP-custom-body'; exit 0; fi
if [[ "$*" == *"pg_restore --list"* ]]; then [[ "$(cat)" == PGDMP-custom-body ]] || exit 1; exit 0; fi
exit 0
`;

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

describe.each(KINDS.filter((kind) => kind.skip === null))("$flavour: backup.sh packs the marker, restore.sh puts the archive back", { timeout: 180_000 }, (kind) => {
  let root = "";
  let app = "";
  let out = "";
  let tools = "";
  let stubs = "";

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archive-meta-")));
    app = path.join(root, "checkout");
    out = path.join(root, "out");
    tools = path.join(root, "tar-bin");
    stubs = path.join(root, "bin");
    fs.mkdirSync(path.join(root, "tmp"));
    write(path.join(app, "scripts/ops/backup.sh"), fs.readFileSync(BACKUP, "utf8"), 0o755);
    write(path.join(app, "scripts/ops/lib/timezone.sh"), fs.readFileSync(path.join(REPO, "scripts/ops/lib/timezone.sh"), "utf8"));
    write(path.join(app, "scripts/ops/lib/existing-install.sh"), fs.readFileSync(EXISTING_LIB, "utf8"));
    installConfigReader(app, stubs);
    write(path.join(stubs, "docker"), DB_STUB, 0o755);
    write(path.join(app, "config/schedule.yaml"), "timezone: UTC\n");
    write(path.join(app, "data/config/schedule.yaml"), "timezone: UTC\n");
    write(path.join(app, "data/config/ui.yaml"), "ui\n");
    write(path.join(app, "data/config/.backup/2026-10-09T10-00-00Z/schedule.yaml"), "old\n");
    write(path.join(app, "data/profile/me.yaml"), "summary: x\n");
    installTar(kind, tools);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const env = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${tools}:${stubs}:${process.env.PATH ?? ""}`, TMPDIR: path.join(root, "tmp") });
  const backup = (label: string, extraPath = "") =>
    spawnSync("bash", [path.join(app, "scripts/ops/backup.sh"), "--dir", out, "--label", label], { encoding: "utf8", cwd: root, timeout: 120_000, env: { ...env(), PATH: `${extraPath}${env().PATH}` } });
  const archiveOf = (label: string) => path.join(out, fs.readdirSync(out).find((name) => name.endsWith(`-${label}.config.tgz`)) ?? `missing-${label}`);
  const listing = (archive: string): string[] => (spawnSync("tar", ["-tzf", archive], { encoding: "utf8", env: env() }).stdout).split("\n").filter(Boolean);

  function unpack(archive: string): string {
    const dir = fs.mkdtempSync(path.join(root, "unpacked-"));
    const result = spawnSync("tar", ["-xzf", archive, "-C", dir], { encoding: "utf8", env: env() });
    expect(result.status, result.stderr).toBe(0);
    return dir;
  }

  function shell(script: string, ...args: string[]) {
    return spawnSync("bash", ["-c", `source "${EXISTING_LIB}"; ${script}`, "bash", ...args], { encoding: "utf8", env: env(), cwd: root });
  }

  it("the archive holds the generated marker once, and the shell reads setup_semantics 2 from it", () => {
    const r = backup("a");
    expect(r.status, r.stderr).toBe(0);
    const archive = archiveOf("a");
    const members = listing(archive);
    expect(members.filter((name) => name.endsWith(ARCHIVE_META_NAME))).toEqual([MARKER_MEMBER]);
    expect(members).toContain("data/config/ui.yaml");
    expect(members).toContain("data/profile/me.yaml");
    expect(members.some((name) => name.includes(".backup"))).toBe(false);

    const dir = unpack(archive);
    expect(fs.readFileSync(path.join(dir, MARKER_MEMBER), "utf8")).toBe(ARCHIVE_META_YAML);
    const semantics = shell('archive_setup_semantics "$1"', path.join(dir, "data/config"));
    expect(semantics.status).toBe(0);
    expect(semantics.stdout.trim()).toBe(String(ARCHIVE_SETUP_SEMANTICS));
    expect(readArchiveSetupSemantics(path.join(dir, "data/config"))).toBe(ARCHIVE_SETUP_SEMANTICS);
    expect(shell('archive_marker_check "$1"', archive).status).toBe(0);
  });

  it("a file of that name in the live directory never reaches the archive: only the generated marker does", () => {
    write(path.join(app, MARKER_MEMBER), "archive_meta_version: 1\nsetup_semantics: 1\n");
    const r = backup("b");
    expect(r.status, r.stderr).toBe(0);
    const archive = archiveOf("b");
    expect(listing(archive).filter((name) => name.endsWith(ARCHIVE_META_NAME))).toEqual([MARKER_MEMBER]);
    expect(fs.readFileSync(path.join(unpack(archive), MARKER_MEMBER), "utf8")).toBe(ARCHIVE_META_YAML);
    // and the live file is untouched
    expect(fs.readFileSync(path.join(app, MARKER_MEMBER), "utf8")).toContain("setup_semantics: 1");
  });

  it("the real restore.sh puts such an archive back on a new install without writing a setup.yaml", () => {
    expect(backup("c").status).toBe(0);
    const harness: RestoreHarness = createRestoreHarness();
    try {
      installTar(kind, path.join(harness.root, "tar-bin"));
      fs.copyFileSync(archiveOf("c"), harness.dump.replace(/\.dump$/, ".config.tgz"));
      const result = harness.restore({ pathPrefix: path.join(harness.root, "tar-bin") });
      expect(result.stderr).not.toContain("predates the setup wizard");
      expect(result.stderr).not.toContain("marker");
      expect(fs.existsSync(harness.live("setup.yaml"))).toBe(false);
      expect(fs.existsSync(harness.live("language.yaml"))).toBe(false);
      expect(fs.existsSync(harness.live(ARCHIVE_META_NAME))).toBe(false);
      expect(fs.readFileSync(harness.live("ui.yaml"), "utf8")).toBe("ui\n");
    } finally {
      harness.cleanup();
    }
  });

  describe("the check before the archive is published", () => {
    /** A `tar` in front of the real one that misbehaves on the second step, the `-rf` that appends the marker. */
    function misbehaving(body: string): string {
      const dir = path.join(root, "bad-tar");
      write(path.join(dir, "tar"), `#!/usr/bin/env bash\nreal='${path.join(tools, "tar")}'\nif [[ "$1" == -rf ]]; then\n${body}\nfi\nexec "$real" "$@"\n`, 0o755);
      return `${dir}:`;
    }
    const expectNoArchive = (r: ReturnType<typeof backup>) => {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("warning: could not archive");
      expect(r.stdout).not.toContain("config written");
      expect(fs.readdirSync(out).filter((name) => name.endsWith(".config.tgz"))).toEqual([]);
      expect(fs.readdirSync(out).filter((name) => name.includes("partial"))).toEqual([]);
      // the database backup is fine
      expect(fs.readdirSync(out).filter((name) => name.endsWith(".dump"))).toHaveLength(1);
    };

    it("a failing append: no config archive, no .partial left, a warning, and the database backup is kept", () => {
      expectNoArchive(backup("d", misbehaving('echo "tar: simulated failure" >&2; exit 1')));
    });

    it("two markers in the archive: refused the same way", () => {
      expectNoArchive(backup("e", misbehaving('"$real" "$@" || exit 1')));
    });
  });
});

describe("config-archive.ts writes the same marker", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ts-"));
    write(path.join(dir, "config/ui.yaml"), "ui\n");
    write(path.join(dir, "profile/me.yaml"), "me\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dirs = () => ({ config: path.join(dir, "config"), profile: path.join(dir, "profile") });

  it("the archive holds the generated marker once, whatever the config directory holds under that name", async () => {
    write(path.join(dir, "config", ARCHIVE_META_NAME), "setup_semantics: 1\n");
    const result = await writeConfigArchive({ dirs: dirs(), destination: path.join(dir, "out.config.tgz") });
    const members = await readTarGz(fs.readFileSync(result.path));
    const markers = members.filter((member) => member.name === MARKER_MEMBER);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.data.toString("utf8")).toBe(ARCHIVE_META_YAML);
    expect(members.map((member) => member.name).sort()).toEqual(["data/config/ui.yaml", "data/profile/me.yaml", MARKER_MEMBER].sort());
    expect(await listArchiveMembers(dirs())).toContain(MARKER_MEMBER);
  });

  it("a real tar reads it, and the shell reads setup_semantics 2 from what it unpacks", async () => {
    const result = await writeConfigArchive({ dirs: dirs(), destination: path.join(dir, "out.config.tgz") });
    const unpacked = path.join(dir, "unpacked");
    fs.mkdirSync(unpacked);
    expect(spawnSync("tar", ["-xzf", result.path, "-C", unpacked]).status).toBe(0);
    const semantics = spawnSync("bash", ["-c", `source "${EXISTING_LIB}"; archive_setup_semantics "$1"; archive_marker_check "$2"`, "bash", path.join(unpacked, "data/config"), result.path], { encoding: "utf8" });
    expect(semantics.status).toBe(0);
    expect(semantics.stdout.trim()).toBe(String(ARCHIVE_SETUP_SEMANTICS));
  });
});

describe("the marker's name and value in shell and TypeScript", () => {
  it("agree", () => {
    const shellSays = spawnSync("bash", ["-c", `source "${EXISTING_LIB}"; printf '%s %s' "$ARCHIVE_META_NAME" "$ARCHIVE_SETUP_SEMANTICS"`], { encoding: "utf8" }).stdout;
    expect(shellSays).toBe(`${ARCHIVE_META_NAME} ${ARCHIVE_SETUP_SEMANTICS}`);
    expect(ARCHIVE_META_YAML).toContain(`setup_semantics: ${ARCHIVE_SETUP_SEMANTICS}\n`);
  });
});
