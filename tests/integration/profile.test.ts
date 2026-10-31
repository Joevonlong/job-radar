import { withRebuiltCurrentScores } from "../helpers/current-scores";
import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { getConfigPath, loadConfig, ensureProfileFiles, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { closeDb, countStaleScores, getDb, hashProfileYaml, listProfileSnapshots, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { meConfigToDraft, preferencesConfigToDraft, type MeDraft, type PreferencesDraft } from "@/lib/profile/draft";
import { savePreferencesAction } from "@/app/me/actions";
import { rollbackProfile, saveProfile } from "@/lib/profile/service";
import { recordProfileSnapshot } from "@/lib/profile/snapshots";
import { buildHistory } from "@/lib/profile/view";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterAll(async () => {
  setOnProfileSaved(null);
  await closeDb();
});

beforeEach(async () => {
  temp = makeTempConfig();
  await ensureProfileFiles();
  const db = getDb();
  await withRebuiltCurrentScores(db, db.delete(schema.scores));
  await db.delete(schema.jobs);
  await db.delete(schema.companies);
  await db.delete(schema.profileSnapshots);
  return () => temp.cleanup();
});

function readFile(name: "me" | "preferences"): string {
  return fs.readFileSync(getConfigPath(name), "utf8");
}

function prefsDraft(): PreferencesDraft {
  return preferencesConfigToDraft(reloadConfig("preferences"));
}
function meDraft(): MeDraft {
  return meConfigToDraft(reloadConfig("me"));
}

/** `count` jobs with one score each, computed from `snapshotId` (one result per job and snapshot). */
async function seedScores(snapshotId: number | null, count = 2): Promise<void> {
  const db = getDb();
  for (let i = 0; i < count; i += 1) {
    const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: `acme-${Math.random()}` }).returning();
    if (!company) throw new Error("company");
    const [job] = await db.insert(schema.jobs).values({ companyId: company.id, title: "AI Engineer", titleNorm: "ai engineer" }).returning();
    if (!job) throw new Error("job");
    await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job.id, profileSnapshotId: snapshotId, filterResult: "passed", score: 70 }));
  }
}

describe("saving the profile", () => {
  it("updates the YAML, keeps comments, stores a snapshot and persists across a reload", async () => {
    const before = readFile("preferences");
    const draft = prefsDraft();
    const result = await saveProfile("preferences", {
      ...draft,
      salary_floor_year: "85000",
      exclude_keywords: [...draft.exclude_keywords, "Praktikum"],
    });
    expect(result.status).toBe("saved");

    const after = readFile("preferences");
    expect(after).not.toBe(before);
    expect(after).toContain("# 年薪底线（EUR，税前）");
    expect(after).toContain("# 我要什么（模板）");
    expect(after).toMatch(/salary_floor_year: 85000/);
    expect(after).toContain("Praktikum");

    // "refresh": drop the cache and read the file again
    expect(reloadConfig("preferences").salary_floor_year).toBe(85000);
    expect(loadConfig("preferences").exclude_keywords).toEqual(["Praktikum"]);

    const snapshots = await listProfileSnapshots(getDb(), "preferences", 10);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.contentYaml).toBe(after);
  });

  it("changes a language level in me.yaml without touching the other entries", async () => {
    const draft = meDraft();
    const languages = draft.languages.map((row) => (row.code === "de" ? { ...row, level: "C1" } : row));
    expect((await saveProfile("me", { ...draft, languages })).status).toBe("saved");
    expect(reloadConfig("me").languages).toEqual([{ en: "C1" }, { de: "C1" }, { es: "native" }]);
    expect(readFile("me")).toContain("# 每种语言一行");
  });

  it("returns field errors and leaves the file and the history untouched for invalid input", async () => {
    const before = readFile("preferences");
    const result = await saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "-1000" });
    expect(result).toMatchObject({
      status: "error",
      kind: "preferences",
      formError: null,
      fieldErrors: [{ path: "salary_floor_year", key: "min", params: { min: 0 } }],
    });
    expect(readFile("preferences")).toBe(before);
    expect(await listProfileSnapshots(getDb(), "preferences", 10)).toHaveLength(0);
  });

  it("refuses a market that cannot be resolved, field by field", async () => {
    const before = readFile("preferences");
    const result = await saveProfile("preferences", { ...prefsDraft(), market: { pack: "generic", country: "", currency: "", home_language: "" } });
    expect(result).toMatchObject({ status: "error", formError: null });
    expect(result.status === "error" ? result.fieldErrors.map((e) => `${e.path}:${e.key}`) : []).toEqual(["market.country:required", "market.currency:required", "market.home_language:required"]);
    const unknown = await saveProfile("preferences", { ...prefsDraft(), market: { pack: "nowhere", country: "", currency: "", home_language: "" } });
    expect(unknown).toMatchObject({ status: "error", fieldErrors: [{ path: "market.pack", key: "invalidChoice" }] });
    expect(readFile("preferences")).toBe(before);
    const ok = await saveProfile("preferences", { ...prefsDraft(), market: { pack: "generic", country: "US", currency: "USD", home_language: "en" } });
    expect(ok).toMatchObject({ status: "saved" });
    expect(reloadConfig("preferences").market).toEqual({ pack: "generic", country: "US", currency: "USD", home_language: "en" });
  });

  it("rejects a payload that is not a draft", async () => {
    const result = await saveProfile("me", { languages: "en" });
    expect(result).toMatchObject({ status: "error", formError: "invalidPayload" });
  });

  it("does not store identical content twice", async () => {
    const draft = prefsDraft();
    await saveProfile("preferences", draft);
    await saveProfile("preferences", draft);
    await saveProfile("preferences", draft);
    expect(await listProfileSnapshots(getDb(), "preferences", 10)).toHaveLength(1);
  });

  it("reports a failed snapshot after the file was written", async () => {
    await closeDb();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://nobody:nope@127.0.0.1:1/none";
    try {
      const result = await saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "91000" });
      expect(result).toMatchObject({ status: "error", formError: "snapshotFailed" });
      expect(reloadConfig("preferences").salary_floor_year).toBe(91000);
    } finally {
      await closeDb();
      process.env.DATABASE_URL = saved;
    }
  });
});

describe("saving on an older version", () => {
  it("refuses a save whose base hash is not the file's any more, and leaves the file alone", async () => {
    const file = getConfigPath("preferences");
    const opened = hashProfileYaml(fs.readFileSync(file, "utf8"));
    expect((await saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "81000" }, opened)).status).toBe("saved");
    const afterFirst = fs.readFileSync(file, "utf8");
    const result = await saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "82000" }, opened);
    expect(result).toMatchObject({ status: "error", kind: "preferences", formError: "stale", baseHash: hashProfileYaml(afterFirst) });
    expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
  });

  it("two saves opened on the same version at once: one is saved, the other is stale", async () => {
    const file = getConfigPath("preferences");
    const opened = hashProfileYaml(fs.readFileSync(file, "utf8"));
    const results = await Promise.all([
      saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "83000" }, opened),
      saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "84000" }, opened),
    ]);
    expect(results.map((result) => (result.status === "error" ? result.formError : result.status)).sort()).toEqual(["saved", "stale"]);
  });

  it("the /me actions refuse a save without the hash the form was opened on", async () => {
    const before = fs.readFileSync(getConfigPath("preferences"), "utf8");
    const result = await savePreferencesAction({ status: "idle" } as never, { draft: { ...prefsDraft(), salary_floor_year: "85000" } });
    expect(result).toMatchObject({ status: "error", kind: "preferences", formError: "invalidPayload" });
    expect(fs.readFileSync(getConfigPath("preferences"), "utf8")).toBe(before);
  });
});

describe("stale scores", () => {
  it("marks scores of older snapshots stale on save and keeps current ones", async () => {
    const db = getDb();
    await saveProfile("preferences", prefsDraft());
    const [current] = await listProfileSnapshots(db, "preferences", 1);
    if (!current) throw new Error("snapshot missing");
    await seedScores(current.id, 3);
    expect(await countStaleScores(db)).toBe(0);

    // unchanged content: same snapshot, nothing becomes stale
    expect((await saveProfile("preferences", prefsDraft())).status).toBe("saved");
    expect(await countStaleScores(db)).toBe(0);

    await saveProfile("preferences", { ...prefsDraft(), salary_floor_year: "99000" });
    expect(await countStaleScores(db)).toBe(3);
    const rows = await db.select().from(schema.scores).where(eq(schema.scores.stale, true));
    expect(rows).toHaveLength(3);
  });

  it("reports how many rows were newly marked and ignores scores without a snapshot", async () => {
    const db = getDb();
    const first = await recordProfileSnapshot(db, "me", "a: 1\n");
    await seedScores(first.snapshot.id, 2);
    await seedScores(null, 1);
    const second = await recordProfileSnapshot(db, "me", "a: 2\n");
    expect(second.staleMarked).toBe(2);
    expect(await countStaleScores(db)).toBe(2);
    // already stale rows are not counted again
    const third = await recordProfileSnapshot(db, "me", "a: 3\n");
    expect(third.staleMarked).toBe(0);
  });
});

describe("history and rollback", () => {
  it("shows the difference between two versions and restores the file on rollback", async () => {
    const db = getDb();
    const original = prefsDraft();
    await saveProfile("preferences", original); // v1: normalised baseline
    const v1Text = readFile("preferences");

    await saveProfile("preferences", { ...original, salary_floor_year: "120000", exclude_keywords: ["Thesis"] }); // v2
    const v2Text = readFile("preferences");
    expect(v2Text).not.toBe(v1Text);

    const snapshots = await listProfileSnapshots(db, "preferences", 10);
    expect(snapshots).toHaveLength(2);
    const history = buildHistory(snapshots, null);
    const newest = history[0];
    expect(newest?.diff?.filter((line) => line.type === "add").map((l) => l.text.trim())).toEqual(
      expect.arrayContaining(["salary_floor_year: 120000"]),
    );
    expect(newest?.diff?.some((line) => line.type === "del" && line.text.includes("salary_floor_year: 70000"))).toBe(true);

    const v1 = snapshots.find((s) => s.contentYaml === v1Text);
    if (!v1) throw new Error("v1 snapshot missing");
    const result = await rollbackProfile({ kind: "preferences", snapshotId: v1.id });
    expect(result.status).toBe("saved");
    expect(readFile("preferences")).toBe(v1Text);
    expect(reloadConfig("preferences").salary_floor_year).toBe(70000);

    // the rollback is a save: the old version moves to the top, no duplicate row appears
    const after = await listProfileSnapshots(db, "preferences", 10);
    expect(after).toHaveLength(2);
    expect(after[0]?.id).toBe(v1.id);
  });

  it("marks scores of the rolled-back-from version stale", async () => {
    const db = getDb();
    const draft = prefsDraft();
    await saveProfile("preferences", draft);
    const [v1] = await listProfileSnapshots(db, "preferences", 1);
    await saveProfile("preferences", { ...draft, salary_floor_year: "123000" });
    const [v2] = await listProfileSnapshots(db, "preferences", 1);
    if (!v1 || !v2) throw new Error("snapshots missing");
    await seedScores(v2.id, 2);
    expect(await countStaleScores(db)).toBe(0);
    await rollbackProfile({ kind: "preferences", snapshotId: v1.id });
    expect(await countStaleScores(db)).toBe(2);
  });

  it("refuses unknown snapshots, snapshots of the other kind and malformed requests", async () => {
    const db = getDb();
    await saveProfile("me", meDraft());
    const [meSnapshot] = await listProfileSnapshots(db, "me", 1);
    if (!meSnapshot) throw new Error("snapshot missing");

    expect(await rollbackProfile({ kind: "preferences", snapshotId: meSnapshot.id })).toMatchObject({ formError: "snapshotNotFound" });
    expect(await rollbackProfile({ kind: "me", snapshotId: 987654321 })).toMatchObject({ formError: "snapshotNotFound" });
    expect(await rollbackProfile({ kind: "me", snapshotId: "1" })).toMatchObject({ formError: "invalidPayload" });
    expect(await rollbackProfile({ kind: "interests", snapshotId: 1 })).toMatchObject({ formError: "invalidPayload" });
  });

  it("refuses a snapshot that no longer passes the schema and leaves the file alone", async () => {
    const db = getDb();
    const bad = await db.insert(schema.profileSnapshots).values({ kind: "me", contentYaml: "city: Berlin\nextra: 1\n", hash: "bad" }).returning();
    const before = readFile("me");
    expect(await rollbackProfile({ kind: "me", snapshotId: bad[0]?.id ?? 0 })).toMatchObject({ formError: "snapshotInvalid" });
    expect(readFile("me")).toBe(before);
  });

  it("only touches files inside the profile directory", async () => {
    await saveProfile("me", meDraft());
    expect(fs.readdirSync(temp.profileDir).sort()).toEqual(["me.yaml", "preferences.yaml", "stories.yaml"]);
    expect(path.dirname(getConfigPath("me"))).toBe(temp.profileDir);
  });
});
