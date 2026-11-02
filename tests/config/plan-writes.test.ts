// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyConfigMigrations, DEPLOY_WRITE_PLAN, ensureConfigFiles, ensureProfileFiles, planConfigMigrations, planConfigWrites } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

const NO_INIT = { convertOverlays: false, init: false } as const;
const kinds = (plan: ReturnType<typeof planConfigWrites>) => plan.writes.map((write) => `${write.kind}:${write.name}`).sort();

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig({ user: "empty" }); });
afterEach(() => tmp.cleanup());

/** notify.yaml as it was at config_version 1: one structural migration is pending for it. */
function putOldNotify(): string {
  const file = path.join(tmp.configDir, "notify.yaml");
  fs.copyFileSync(path.resolve(import.meta.dirname, "../fixtures/config/notify.v1.yaml"), file);
  return file;
}

describe("planConfigWrites", () => {
  it("lists the structural migration of a user file as `migrate`, with both versions", () => {
    const file = putOldNotify();
    const plan = planConfigWrites(NO_INIT);
    expect(plan.problems).toEqual([]);
    expect(plan.writes).toEqual([{ kind: "migrate", name: "notify", path: file, from: 1, to: expect.any(Number) }]);
    expect(plan.writes[0]?.to).toBeGreaterThan(1);
  });

  it("lists the files `config:init` would create as `create`, only with init", () => {
    expect(planConfigWrites(NO_INIT).writes).toEqual([]);
    const plan = planConfigWrites({ ...NO_INIT, init: true });
    expect(plan.writes.length).toBeGreaterThan(0);
    expect(plan.writes.every((write) => write.kind === "create")).toBe(true);
    // the wizard's own files are never created by a fill; the user files are
    expect(plan.writes.map((write) => write.name)).not.toContain("setup");
    expect(plan.writes.map((write) => write.name)).not.toContain("language");
    expect(plan.writes.map((write) => write.name)).toContain("ui");
  });

  it("lists the missing profile files as `create` in the config path of that name", () => {
    const plan = planConfigWrites({ ...NO_INIT, init: true });
    const profile = plan.writes.filter((write) => path.dirname(write.path) === tmp.profileDir);
    expect(profile.map((write) => path.basename(write.path))).toEqual(expect.arrayContaining(["me.yaml", "preferences.yaml"]));
  });

  it("combines migrations and creations, and carries problems along", () => {
    putOldNotify();
    fs.writeFileSync(path.join(tmp.configDir, "ui.yaml"), "config_version: 99\n");
    const plan = planConfigWrites({ ...NO_INIT, init: true });
    expect(plan.problems.map((problem) => problem.name)).toEqual(["ui"]);
    expect(kinds(plan)).toContain("migrate:notify");
    expect(kinds(plan).some((entry) => entry.startsWith("create:"))).toBe(true);
    // a file that exists (even an invalid one) is not planned for creation
    expect(kinds(plan)).not.toContain("create:ui");
  });

  it("writes nothing", () => {
    putOldNotify();
    const before = fs.readdirSync(tmp.configDir).sort();
    planConfigWrites(DEPLOY_WRITE_PLAN);
    expect(fs.readdirSync(tmp.configDir).sort()).toEqual(before);
    expect(fs.existsSync(tmp.profileDir) ? fs.readdirSync(tmp.profileDir) : []).toEqual([]);
  });

  it("becomes empty once the writes were made", async () => {
    putOldNotify();
    await applyConfigMigrations(planConfigMigrations());
    await ensureConfigFiles();
    await ensureProfileFiles();
    expect(planConfigWrites(DEPLOY_WRITE_PLAN)).toEqual({ writes: [], problems: [] });
  });
});

describe("DEPLOY_WRITE_PLAN", () => {
  it("is what the deploy's write step does: creates files, no overlay conversion yet", () => {
    expect(DEPLOY_WRITE_PLAN).toEqual({ convertOverlays: false, init: true });
  });
});
