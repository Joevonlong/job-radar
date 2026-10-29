// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { runConfigScript } from "../config/run-script";

/** scripts/config-get.ts, the validated values `cfg_get` hands to backup.sh and restore.sh. */
describe("config-get", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
  });
  afterEach(() => tmp.cleanup());

  const get = (...args: string[]) => runConfigScript(tmp, "config-get.ts", args);
  const shipped = () => fs.readFileSync(path.join(tmp.defaultsDir, "schedule.yaml"), "utf8");
  const writeUser = (text: string) => fs.writeFileSync(path.join(tmp.configDir, "schedule.yaml"), text);
  const shippedWith = (change: (doc: ReturnType<typeof parseDocument>) => void) => {
    const doc = parseDocument(shipped());
    change(doc);
    return doc.toString();
  };

  it("prints one line per path from the shipped file when there is no user file (strings as they are, the rest as JSON)", () => {
    const shippedDoc = parseDocument(shipped());
    const r = get("schedule.yaml", "timezone", "backup.max_age_hours", "doctor.compose_services");
    expect(r.status, r.out).toBe(0);
    expect(r.out.split("\n").filter(Boolean)).toEqual([
      String(shippedDoc.get("timezone")),
      String(shippedDoc.getIn(["backup", "max_age_hours"])),
      JSON.stringify((shippedDoc.getIn(["doctor", "compose_services"]) as { toJSON(): unknown }).toJSON()),
    ]);
  });

  it("takes the config name as well as the file name", () => {
    expect(get("schedule", "timezone").status).toBe(0);
  });

  it("a user file overrides the value", () => {
    writeUser(shippedWith((doc) => doc.set("timezone", "Pacific/Kiritimati")));
    const r = get("schedule.yaml", "timezone");
    expect(r).toMatchObject({ status: 0, out: "Pacific/Kiritimati\n" });
  });

  it("fills in the zod default of a key the user file leaves out (whole-file semantics: not the shipped value)", () => {
    writeUser(shippedWith((doc) => {
      doc.deleteIn(["backup", "keep_old_databases"]);
      doc.setIn(["backup", "max_age_hours"], 7);
    }));
    fs.writeFileSync(path.join(tmp.defaultsDir, "schedule.yaml"), shippedWith((doc) => doc.setIn(["backup", "keep_old_databases"], 4)));
    const r = get("schedule.yaml", "backup.max_age_hours", "backup.keep_old_databases");
    expect(r).toMatchObject({ status: 0, out: "7\n1\n" });
  });

  it("refuses !unset (not supported by this version): exit 1, nothing on stdout", () => {
    writeUser(`${shippedWith((doc) => doc.deleteIn(["backup", "max_age_hours"]))}`.replace("backup:\n", "backup:\n  max_age_hours: !unset\n"));
    const r = get("schedule.yaml", "timezone");
    expect(r.status).toBe(1);
    expect(r.out).toContain("!unset");
    expect(r.out).not.toMatch(/^Europe\//m);
  });

  it("a stub with only config_version is a whole file in this version, and invalid: exit 1", () => {
    writeUser("config_version: 1\n");
    const r = get("schedule.yaml", "timezone");
    expect(r.status).toBe(1);
    expect(r.out).toContain("schedule.yaml");
  });

  it("an invalid config: exit 1, the error names the file", () => {
    writeUser(shippedWith((doc) => doc.set("timezone", "Nowhere/Fakeland")));
    const r = get("schedule.yaml", "timezone");
    expect(r.status).toBe(1);
    expect(r.out).toContain("schedule.yaml");
  });

  it("a path that is not there: exit 3, and no partial answer on stdout", () => {
    const r = get("schedule.yaml", "timezone", "backup.no_such_key");
    expect(r.status).toBe(3);
    expect(r.out).toContain("has no backup.no_such_key");
    expect(r.out).not.toMatch(/^Europe\//m);
  });

  it("an unknown file or no path: exit 2", () => {
    expect(get("nope.yaml", "x").status).toBe(2);
    expect(get("schedule.yaml").status).toBe(2);
  });
});
