// @vitest-environment node
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configPendingCheck } from "@/lib/ops/doctor/checks/config";
import { runDoctor } from "@/lib/ops/doctor/run";
import { createRealProbes } from "@/lib/ops/doctor/probes";
import { DEPLOY_WRITE_PLAN, planConfigWrites, type ConfigWritesPlan } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { makeContext, only } from "./helpers";

const check = (plan: ConfigWritesPlan, env: Record<string, string | undefined> = {}) => only(configPendingCheck, makeContext({ locale: "en", env, probes: { configWrites: async () => plan } }));
const none: ConfigWritesPlan = { writes: [], problems: [] };

describe("config.pending", () => {
  it("is ok when nothing is left to write", async () => {
    expect(await check(none)).toMatchObject({ id: "config.pending", group: "data", status: "ok", detail: "no config writes are pending" });
  });

  it("names each pending file by the kind of write", async () => {
    const result = await check({
      writes: [
        { kind: "migrate", name: "ui", path: "/u/ui.yaml", from: 1, to: 2 },
        { kind: "create", name: "search", path: "/u/search.yaml" },
      ],
      problems: [],
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("2 config file(s) wait for the next deploy: ui (format update), search (new file)");
    expect(result.hint).toContain("pnpm config:migrate --write");
  });

  it("adds the reason the last deploy skipped the writes, only when there is something pending", async () => {
    const pending: ConfigWritesPlan = { writes: [{ kind: "create", name: "search", path: "/u/search.yaml" }], problems: [] };
    const skipped = await check(pending, { CONFIG_PENDING_REASON: "a process runs an older version" });
    expect(skipped.status).toBe("warn");
    expect(skipped.detail).toContain("The last deploy skipped them: a process runs an older version");
    // a stale reason in the environment says nothing once the plan is empty
    expect(await check(none, { CONFIG_PENDING_REASON: "a process runs an older version" })).toMatchObject({ status: "ok", detail: "no config writes are pending" });
    // whitespace is no reason
    expect((await check(pending, { CONFIG_PENDING_REASON: "  " })).detail).not.toContain("skipped");
  });

  it("warns about files that cannot be migrated", async () => {
    const result = await check({ writes: [], problems: [{ name: "ui", path: "/u/ui.yaml", message: "config_version 3 is newer" }] });
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("1 config file(s) cannot be migrated: ui");
  });

  it("a failing probe is a failed check, not a crash", async () => {
    const ctx = makeContext({ locale: "en", probes: { configWrites: async () => { throw new Error("boom"); } } });
    const report = await runDoctor(ctx, [configPendingCheck]);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: "config.pending", status: "fail" });
    expect(report.checks[0]?.detail).toContain("boom");
  });
});

describe("config.pending with the real probe", () => {
  let tmp: TempConfig;
  afterEach(() => tmp.cleanup());
  const probes = () => createRealProbes({ commandTimeoutMs: 100, probeTimeoutMs: 100, now: () => new Date(), migrationsDir: path.join(tmp.root, "migrations") });

  it("reads the plan from the directories: a missing user file is pending, a filled directory is not", async () => {
    tmp = makeTempConfig({ user: "empty" });
    const missing = await probes().configWrites();
    expect(missing).toEqual(planConfigWrites(DEPLOY_WRITE_PLAN));
    expect(missing.writes.some((write) => write.kind === "create" && write.name === "ui")).toBe(true);
    tmp.cleanup();

    tmp = makeTempConfig({ user: "init" });
    const filled = await probes().configWrites();
    expect(filled.writes.filter((write) => write.kind === "create" && write.path.startsWith(tmp.configDir))).toEqual([]);
  });
});
