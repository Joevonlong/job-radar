// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { parseConfigText } from "@/lib/config";

import { FIXTURE_DEFAULTS_DIR } from "../config/helpers";
import { pathWithoutNode, REAL_CONFIG_LIB } from "./config-reader";

/**
 * scripts/ops/lib/config.sh: `cfg_identity` (the shell reader) against the loader, and `cfg_get` without node. The user
 * and shipped directories are temporary; no node runs the real loader here except through `parseConfigText` in-process.
 */
const SHIPPED_TEXT = fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "schedule.yaml"), "utf8");
const NO_ZONEINFO = "/nonexistent-zoneinfo-dir";
const HAS_ZONEINFO = fs.existsSync("/usr/share/zoneinfo/Europe/Berlin");

let tmp = "";
let counter = 0;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-sh-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Files {
  /** The user's schedule.yaml (absent when undefined). */
  user?: string | Buffer;
  /** The shipped schedule.yaml (default: the fixture's). */
  shipped?: string;
}
interface Options {
  /** Fill the overlay format table for schedule.yaml (empty in this version). */
  overlayFrom?: number;
  zoneinfo?: string;
  env?: Record<string, string>;
}

function dirs(files: Files): { user: string; shipped: string } {
  counter += 1;
  const user = path.join(tmp, `case-${counter}`, "user");
  const shipped = path.join(tmp, `case-${counter}`, "shipped");
  fs.mkdirSync(user, { recursive: true });
  fs.mkdirSync(shipped, { recursive: true });
  if (files.user !== undefined) fs.writeFileSync(path.join(user, "schedule.yaml"), files.user);
  fs.writeFileSync(path.join(shipped, "schedule.yaml"), files.shipped ?? SHIPPED_TEXT);
  return { user, shipped };
}

function bash(script: string, files: Files, options: Options = {}) {
  const { user, shipped } = dirs(files);
  const table = options.overlayFrom === undefined ? "" : `cfg_overlay_format_version() { [[ $1 == schedule.yaml ]] && printf '%s' ${options.overlayFrom}; }\n`;
  const r = spawnSync("bash", ["-c", `source "$CONFIG_LIB"\n${table}${script}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CONFIG_LIB: REAL_CONFIG_LIB, CFG_USER_DIR: user, CFG_SHIPPED_DIR: shipped, JOB_RADAR_ZONEINFO_DIR: options.zoneinfo ?? NO_ZONEINFO, ...options.env },
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

/** cfg_identity schedule.yaml <key> <validator> [<default>] */
function identity(key: string, validator: string, fallback: string | null, files: Files, options: Options = {}) {
  const args = [key, validator, ...(fallback === null ? [] : [fallback])].map((arg) => `'${arg}'`).join(" ");
  return bash(`cfg_identity schedule.yaml ${args}`, files, options);
}
const timezone = (files: Files, options: Options = {}) => identity("timezone", "timezone", null, files, options);
const composeProject = (files: Files, options: Options = {}) => identity("doctor.compose_project", "compose_project", "job-radar", files, options);

/** The shipped fixture with edits made through the YAML document (block style kept). */
function edited(change: (doc: ReturnType<typeof parseDocument>) => void, text = SHIPPED_TEXT): string {
  const doc = parseDocument(text);
  change(doc);
  return doc.toString();
}
const withoutDoctor = edited((doc) => doc.delete("doctor"));
const withoutTimezone = edited((doc) => doc.delete("timezone"));
const withZone = (zone: string) => edited((doc) => doc.set("timezone", zone));

/** What the loader makes of a user schedule.yaml: the value at the path, or null when it fails. */
function loaderValue(text: string, keyPath: string[]): unknown {
  try {
    let value: unknown = parseConfigText("schedule", text, "/tmp/schedule.yaml");
    for (const key of keyPath) value = (value as Record<string, unknown>)[key];
    return value;
  } catch {
    return null;
  }
}

describe("cfg_identity: which file it reads", () => {
  const shipped = SHIPPED_TEXT.replace("compose_project: job-radar", "compose_project: shipped-name");

  it("a valid whole-file user file without `doctor` gives the script default (the zod default), not the shipped value", () => {
    const r = composeProject({ user: withoutDoctor, shipped });
    expect(r).toMatchObject({ status: 0, stdout: "job-radar" });
    expect(loaderValue(withoutDoctor, ["doctor", "compose_project"])).toBe("job-radar");
  });

  it("the script defaults equal the zod defaults", () => {
    const r = bash('printf "%s %s\\n" "$CFG_DEFAULT_COMPOSE_PROJECT" "$CFG_DEFAULT_BACKUP_MAX_AGE_HOURS"', {});
    const withoutMaxAge = edited((doc) => doc.deleteIn(["backup", "max_age_hours"]));
    expect(r.stdout).toBe(`${String(loaderValue(withoutDoctor, ["doctor", "compose_project"]))} ${String(loaderValue(withoutMaxAge, ["backup", "max_age_hours"]))}`);
  });

  it("without a user file it reads the shipped file", () => {
    expect(composeProject({ shipped })).toMatchObject({ status: 0, stdout: "shipped-name" });
    expect(timezone({ shipped })).toMatchObject({ status: 0, stdout: "Europe/Berlin" });
  });

  it("a whole-file user file wins over the shipped file", () => {
    const user = edited((doc) => doc.setIn(["doctor", "compose_project"], "user-name"));
    expect(composeProject({ user, shipped })).toMatchObject({ status: 0, stdout: "user-name" });
  });

  it("refuses !unset in a whole-file user file (every file in this version)", () => {
    expect(composeProject({ user: `${withoutDoctor}doctor: !unset\n`, shipped }).status).toBe(2);
  });

  describe("in the overlay format (the version table filled in for the test)", () => {
    const overlay = (body: string) => `config_version: 9\n${body}`;
    it.each([
      { name: "the key is !unset", body: "doctor:\n  compose_project: !unset\n" },
      { name: "a parent is !unset", body: "doctor: !unset\n" },
    ])("$name: the script default", ({ body }) => {
      expect(composeProject({ user: overlay(body), shipped }, { overlayFrom: 9 })).toMatchObject({ status: 0, stdout: "job-radar" });
    });
    it("a key the overlay does not have comes from the shipped file", () => {
      expect(composeProject({ user: overlay("timezone: UTC\n"), shipped }, { overlayFrom: 9 })).toMatchObject({ status: 0, stdout: "shipped-name" });
    });
    it("a key the overlay sets wins", () => {
      expect(composeProject({ user: overlay("doctor:\n  compose_project: mine\n"), shipped }, { overlayFrom: 9 })).toMatchObject({ status: 0, stdout: "mine" });
    });
    it("a user file below the overlay version is read as a whole file", () => {
      expect(composeProject({ user: "config_version: 8\ntimezone: UTC\n", shipped }, { overlayFrom: 9 })).toMatchObject({ status: 0, stdout: "job-radar" });
    });
  });
});

describe("cfg_identity: timezone is required (no script default)", () => {
  const rows = [
    { name: "a whole-file user file without it", user: withoutTimezone, overlayFrom: undefined },
    { name: "!unset in an overlay", user: "config_version: 9\ntimezone: !unset\n", overlayFrom: 9 },
  ];
  it.each(rows)("$name: missing (exit 3), and the loader fails on the same file", ({ user, overlayFrom }) => {
    expect(timezone({ user }, { overlayFrom }).status).toBe(3);
    expect(loaderValue(user, ["timezone"])).toBeNull();
  });

  it.each(["Europe/Berlin", "UTC", "Etc/GMT+5", "America/Argentina/Buenos_Aires"])("a valid %s reads the same as the loader", (zone) => {
    const user = withZone(zone);
    expect(timezone({ user })).toMatchObject({ status: 0, stdout: loaderValue(user, ["timezone"]) });
  });

  it("where the loader fails, the shell reader never gives a value", () => {
    for (const user of [withZone("Nowhere/Fakeland"), `${SHIPPED_TEXT}\nunknown_key: 1\n`.replace("timezone: Europe/Berlin", "timezone: [x]")]) {
      expect(loaderValue(user, ["timezone"])).toBeNull();
      expect([2, 3]).toContain(timezone({ user }, { zoneinfo: HAS_ZONEINFO ? "/usr/share/zoneinfo" : NO_ZONEINFO }).status);
    }
  });
});

describe("cfg_identity: time zone formats", () => {
  const accepted = ["UTC", "Etc/UTC", "Etc/Zulu", "Etc/GMT", "Etc/GMT0", "Etc/GMT-0", "Etc/GMT+5", "Etc/GMT+12", "Etc/GMT-14", "Europe/Berlin", "America/Argentina/Buenos_Aires"];
  const rejected = ["Etc/GMT+13", "Etc/GMT+15", "Etc/GMT-15", "Etc/GMT-99", "Etc/GMT+05", "Etc/Foo", "Etc/GMT+1/x", "Foo", "a/b/c/d", "Europe/ Berlin", "Japan", "GMT", "EST5EDT"];

  it.each(accepted)("accepts %s without zoneinfo", (zone) => {
    expect(timezone({ user: `timezone: "${zone}"\n` })).toMatchObject({ status: 0, stdout: zone });
  });
  it.each(rejected)("rejects '%s' without zoneinfo (exit 2)", (zone) => {
    expect(timezone({ user: `timezone: "${zone}"\n` }).status).toBe(2);
  });
  it.runIf(HAS_ZONEINFO).each(accepted)("accepts %s with the system zoneinfo", (zone) => {
    expect(timezone({ user: `timezone: ${zone}\n` }, { zoneinfo: "/usr/share/zoneinfo" })).toMatchObject({ status: 0, stdout: zone });
  });
  it("with a zoneinfo directory the zone must exist in it", () => {
    const zoneinfo = path.join(tmp, "zoneinfo");
    fs.mkdirSync(path.join(zoneinfo, "Europe"), { recursive: true });
    fs.writeFileSync(path.join(zoneinfo, "Europe/Berlin"), "TZif");
    expect(timezone({ user: "timezone: Europe/Berlin\n" }, { zoneinfo }).status).toBe(0);
    expect(timezone({ user: "timezone: Europe/Paris\n" }, { zoneinfo }).status).toBe(2);
  });
});

describe("cfg_identity: the YAML subset", () => {
  it.each([
    { name: "a plain value with a comment", text: "timezone: Europe/Berlin # here\n", value: "Europe/Berlin" },
    { name: "a single-quoted value", text: "timezone: 'Europe/Berlin'\n", value: "Europe/Berlin" },
    { name: "a double-quoted value", text: 'timezone: "Europe/Berlin"\n', value: "Europe/Berlin" },
    { name: "Windows line ends", text: "timezone: Europe/Berlin\r\n", value: "Europe/Berlin" },
    { name: "a list at the indentation of its key", text: "cycles:\n- a\n- b\ntimezone: Europe/Berlin\n", value: "Europe/Berlin" },
    { name: "flow style and anchors elsewhere in the file", text: "other: [a, b]\nx: &a 1\ntimezone: Europe/Berlin\n", value: "Europe/Berlin" },
  ])("reads $name", ({ text, value }) => {
    expect(timezone({ user: text })).toMatchObject({ status: 0, stdout: value });
  });

  it("reads a nested key under comments and blank lines", () => {
    expect(composeProject({ user: "timezone: UTC\ndoctor:\n  # the project\n\n  web_url: x\n  compose_project: \"mine\"  # quoted\n" })).toMatchObject({ status: 0, stdout: "mine" });
  });

  it.each([
    { name: "flow style", text: "timezone: {a: 1}\n" },
    { name: "flow style on a parent", text: "timezone: UTC\ndoctor: {compose_project: x}\n", compose: true },
    { name: "an anchor", text: "timezone: &zone Europe/Berlin\n" },
    { name: "an alias", text: "zone: &z Europe/Berlin\ntimezone: *z\n" },
    { name: "a literal block scalar", text: "timezone: |\n  Europe/Berlin\n" },
    { name: "a folded block scalar", text: "timezone: >\n  Europe/Berlin\n" },
    { name: "two documents", text: "timezone: Europe/Berlin\n---\ntimezone: UTC\n" },
    { name: "tab indentation", text: "timezone: UTC\ndoctor:\n\tcompose_project: x\n", compose: true },
    { name: "a duplicate key", text: "timezone: Europe/Berlin\ntimezone: UTC\n" },
    { name: "a duplicate parent", text: "timezone: UTC\ndoctor:\n  compose_project: a\ndoctor:\n  compose_project: b\n", compose: true },
    { name: "an unknown tag", text: "timezone: !!str Europe/Berlin\n" },
    { name: "a custom tag", text: "timezone: !zone Europe/Berlin\n" },
    { name: "a parent that is a scalar", text: "timezone: UTC\ndoctor: job-radar\n", compose: true },
    { name: "a parent that is a list", text: "timezone: UTC\ndoctor:\n- compose_project: x\n", compose: true },
    { name: "a merge key", text: "timezone: UTC\ndoctor:\n  <<: {compose_project: x}\n", compose: true },
    { name: "a value on several lines", text: "timezone: Europe\n  /Berlin\n" },
    { name: "escapes in a double-quoted value", text: 'timezone: "Europe\\/Berlin"\n' },
    { name: "a value that fails its check", text: "timezone: Europe/Berlin\ndoctor:\n  compose_project: Not_Valid\n", compose: true },
    { name: "a number where a name is expected", text: "timezone: UTC\ndoctor:\n  compose_project: 123\n", compose: true },
    { name: "no value", text: "timezone:\n" },
    { name: "a mapping where a value is expected", text: "timezone:\n  zone: UTC\n" },
  ])("$name is unclear (exit 2)", ({ text, compose }) => {
    const r = compose === true ? composeProject({ user: text }) : timezone({ user: text });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("schedule.yaml");
  });

  it("a file that is not UTF-8 is unclear (exit 2)", () => {
    const r = timezone({ user: Buffer.concat([Buffer.from("timezone: Europe/Berlin\nnote: caf"), Buffer.from([0xe9]), Buffer.from("\n")]) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not UTF-8");
  });

  it("an unreadable file is unclear (exit 2)", () => {
    const { user, shipped } = dirs({ user: "timezone: UTC\n" });
    fs.chmodSync(path.join(user, "schedule.yaml"), 0o000);
    try {
      const r = spawnSync("bash", ["-c", 'source "$CONFIG_LIB"; cfg_identity schedule.yaml timezone timezone'], {
        encoding: "utf8",
        env: { ...process.env, CONFIG_LIB: REAL_CONFIG_LIB, CFG_USER_DIR: user, CFG_SHIPPED_DIR: shipped, JOB_RADAR_ZONEINFO_DIR: NO_ZONEINFO },
      });
      // root can read a file of mode 000
      if (process.getuid?.() !== 0) expect(r.status).toBe(2);
    } finally {
      fs.chmodSync(path.join(user, "schedule.yaml"), 0o600);
    }
  });

  it("positive_int takes plain whole numbers above zero only", () => {
    const read = (value: string) => identity("backup.max_age_hours", "positive_int", "30", { user: `timezone: UTC\nbackup:\n  max_age_hours: ${value}\n` });
    expect(read("12")).toMatchObject({ status: 0, stdout: "12" });
    for (const value of ["0", "-1", "1.5", '"12"', "twelve"]) expect(read(value).status, value).toBe(2);
  });
});

describe("cfg_get", () => {
  it("fails without node, without running anything", () => {
    const linkDir = path.join(tmp, "tools");
    const r = bash("cfg_get schedule.yaml timezone", {}, { env: { PATH: pathWithoutNode(process.env.PATH ?? "", linkDir, ["bash", "cat", "dirname", "awk", "iconv", "env"]) } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("node is not installed");
  });
});
