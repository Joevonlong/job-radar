import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { ensureProfileFiles, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { closeDb, getDb, listControlRequests, listProfileSnapshots, writeHeartbeat } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { requestTestTelegram } from "@/lib/control/service";
import { meConfigToDraft } from "@/lib/profile/draft";
import { runSetupCli, type CliIo } from "@/lib/setup/cli";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { saveMarketStep } from "@/lib/setup/steps/market";
import { saveProfileStep } from "@/lib/setup/steps/profile";
import { requestFirstCycle } from "@/lib/setup/steps/review";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
const ANSWERS = path.resolve(import.meta.dirname, "../fixtures/setup/answers.yaml");
let temp: TempConfig;

function io(): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), ask: async () => null };
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
afterAll(async () => {
  setOnProfileSaved(null);
  await closeDb();
});
beforeEach(async () => {
  process.env.DATABASE_URL = url;
  temp = makeTempConfig();
  await ensureProfileFiles();
  resetSetupStateCache();
});
afterEach(() => temp.cleanup());

describe("setup steps against the database", () => {
  it("profile and market saves record profile snapshots", async () => {
    expect(await saveProfileStep({ ...meConfigToDraft(reloadConfig("me")), summary: "Data engineer." })).toEqual({ status: "saved", step: "profile" });
    expect(await saveMarketStep({ market: { pack: "generic", country: "NL", currency: "EUR", home_language: "nl" }, locations: ["Amsterdam"], remote_scope: "home_country", timezone: "Europe/Amsterdam" })).toEqual({ status: "saved", step: "market" });
    const db = getDb();
    expect((await listProfileSnapshots(db, "me", 10)).length).toBeGreaterThan(0);
    expect((await listProfileSnapshots(db, "preferences", 10)).length).toBeGreaterThan(0);
  });

  it("the first cycle and the Telegram test are queued as control requests (they run while the setup is pending)", async () => {
    expect(readSetupState().pending).toBe(true);
    const cycle = await requestFirstCycle();
    expect(cycle).toMatchObject({ status: "queued", kind: "run_cycle", existing: false });
    expect(await requestFirstCycle()).toMatchObject({ status: "queued", existing: true });
    expect(await requestTestTelegram()).toMatchObject({ status: "queued", kind: "test_telegram" });
    const kinds = (await listControlRequests(getDb(), 10)).map((r) => r.kind).sort();
    expect(kinds).toEqual(["run_cycle", "test_telegram"]);
  });
});

describe("pnpm run setup against the database", () => {
  it("--answers with run_first_cycle queues a cycle, and --status --json reports the runner", async () => {
    const answers = path.join(temp.root, "answers.yaml");
    fs.writeFileSync(answers, fs.readFileSync(ANSWERS, "utf8").replace("run_first_cycle: false", "run_first_cycle: true"));
    const run = io();
    expect(await runSetupCli(["--answers", answers, "--lang", "en"], run)).toBe(0);
    expect(run.lines.some((l) => /^First cycle queued \(request \d+\)\.$/.test(l))).toBe(true);
    process.env.DATABASE_URL = url;
    expect((await listControlRequests(getDb(), 10)).map((r) => r.kind)).toEqual(["run_cycle"]);
    expect((await listProfileSnapshots(getDb(), "me", 10)).length).toBeGreaterThan(0);

    await writeHeartbeat(getDb(), "runner");
    const status = io();
    expect(await runSetupCli(["--status", "--json"], status)).toBe(0);
    const report = JSON.parse(status.lines.join("\n")) as { pending: boolean; completed_by: string; readiness: Array<{ id: string; status: string; params: Record<string, unknown> }> };
    expect(report).toMatchObject({ pending: false, completed_by: "cli" });
    expect(report.readiness.find((r) => r.id === "runner")).toMatchObject({ status: "ok", params: { state: "online" } });
  });
});
