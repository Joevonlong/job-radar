import { withRebuiltCurrentScores } from "../helpers/current-scores";
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { saveStoriesAction } from "@/app/me/actions";
import { ensureProfileFiles, getConfigPath, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { closeDb, countStaleScores, getDb, hashProfileYaml, listProfileSnapshots, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { rollbackProfile, saveProfile, saveStories } from "@/lib/profile/service";
import { loadProfilePage } from "@/lib/profile/view";
import { EMPTY_STORY, type StoriesDraft, type StoryDraft } from "@/lib/stories/draft";
import { meConfigToDraft, preferencesConfigToDraft } from "@/lib/profile/draft";

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

function storiesFile(): string {
  return fs.readFileSync(getConfigPath("stories"), "utf8");
}

function hash(): string {
  return hashProfileYaml(storiesFile());
}

function story(patch: Partial<StoryDraft>): StoryDraft {
  return { ...EMPTY_STORY, title: "Moved billing", what: "Led the migration with a team of three.", ...patch };
}

async function save(draft: StoriesDraft) {
  return saveStories(draft, hash());
}

/** Two jobs scored from the current preferences snapshot: nothing stale. */
async function seedCurrentScores(): Promise<void> {
  const db = getDb();
  await saveProfile("me", meConfigToDraft(reloadConfig("me")));
  await saveProfile("preferences", preferencesConfigToDraft(reloadConfig("preferences")));
  const [snapshot] = await listProfileSnapshots(db, "preferences", 1);
  if (!snapshot) throw new Error("snapshot missing");
  for (let i = 0; i < 2; i += 1) {
    const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: `acme-${i}-${Math.random()}` }).returning();
    const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, title: "AI Engineer", titleNorm: "ai engineer" }).returning();
    await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job!.id, profileSnapshotId: snapshot.id, filterResult: "passed", score: 70 }));
  }
  expect(await countStaleScores(db)).toBe(0);
}

describe("a new installation", () => {
  it("has an empty library from the template, shown as an editable card", async () => {
    expect(reloadConfig("stories")).toEqual({ stories: [] });
    const page = await loadProfilePage();
    expect(page.stories.draft).toEqual({ stories: [] });
    expect(page.stories.loadError).toBeNull();
    expect(page.storyLimits.max_items).toBe(60);
  });
});

describe("saving the library", () => {
  it("writes stories.yaml with ids from the titles, keeps the comments and records a stories snapshot", async () => {
    const result = await save({ stories: [story({}), story({ title: "Cut build time", what: "Cached the builds.", metrics: ["from 40 to 12 minutes"], skills: ["Bazel"], period: "2024", language: "en" })] });
    expect(result.status).toBe("saved");
    const value = reloadConfig("stories");
    expect(value.stories.map((s) => s.id)).toEqual(["moved-billing", "cut-build-time"]);
    expect(value.stories[1]).toMatchObject({ metrics: ["from 40 to 12 minutes"], skills: ["Bazel"], period: "2024", language: "en", source: "manual" });
    expect(storiesFile()).toContain("# My experience library (template).");
    const snapshots = await listProfileSnapshots(getDb(), "stories", 10);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.contentYaml).toBe(storiesFile());
  });

  it("edits, reorders and deletes, ids staying with their stories", async () => {
    await save({ stories: [story({ title: "First" }), story({ title: "Second" }), story({ title: "Third" })] });
    const [first, , third] = reloadConfig("stories").stories.map((s) => ({ ...EMPTY_STORY, ...s, result: s.result ?? "", period: s.period ?? "", language: s.language ?? "" }));
    expect((await save({ stories: [{ ...third!, title: "Third, renamed", result: "It worked." }, first!] })).status).toBe("saved");
    const value = reloadConfig("stories");
    expect(value.stories.map((s) => [s.id, s.title])).toEqual([
      ["third", "Third, renamed"],
      ["first", "First"],
    ]);
    expect(value.stories[0]?.result).toBe("It worked.");
    // clearing an optional field removes its key
    const cleared = value.stories.map((s) => ({ ...EMPTY_STORY, ...s, result: "", period: s.period ?? "", language: s.language ?? "" }));
    expect((await save({ stories: cleared })).status).toBe("saved");
    expect(reloadConfig("stories").stories[0]).not.toHaveProperty("result");
    expect(storiesFile()).not.toContain("It worked.");
  });

  it("never makes a score stale, on save or on rollback", async () => {
    await seedCurrentScores();
    const db = getDb();
    await save({ stories: [story({})] });
    await save({ stories: [story({}), story({ title: "Second" })] });
    expect(await countStaleScores(db)).toBe(0);
    const snapshots = await listProfileSnapshots(db, "stories", 10);
    expect(snapshots).toHaveLength(2);
    expect((await rollbackProfile({ kind: "stories", snapshotId: snapshots[1]!.id })).status).toBe("saved");
    expect(await countStaleScores(db)).toBe(0);
    // no score ever points at a stories snapshot
    const scored = await db.select({ id: schema.scores.profileSnapshotId }).from(schema.scores);
    expect(scored.every((row) => !snapshots.some((s) => s.id === row.id))).toBe(true);
  });

  it("rolls back to an earlier version", async () => {
    await save({ stories: [story({})] });
    const v1 = storiesFile();
    await save({ stories: [story({}), story({ title: "Second" })] });
    const snapshots = await listProfileSnapshots(getDb(), "stories", 10);
    const old = snapshots.find((s) => s.contentYaml === v1);
    expect((await rollbackProfile({ kind: "stories", snapshotId: old!.id })).status).toBe("saved");
    expect(storiesFile()).toBe(v1);
    // snapshots of another kind are not stories
    const [me] = await listProfileSnapshots(getDb(), "me", 1);
    if (me) expect(await rollbackProfile({ kind: "stories", snapshotId: me.id })).toMatchObject({ formError: "snapshotNotFound" });
  });

  it("refuses a rollback to a version over today's writer.yaml limits", async () => {
    await save({ stories: [story({}), story({ title: "Second" })] });
    const [two] = await listProfileSnapshots(getDb(), "stories", 1);
    await save({ stories: [story({})] });
    fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), "stories:\n  max_items: 1\n");
    const before = storiesFile();
    expect(await rollbackProfile({ kind: "stories", snapshotId: two!.id })).toMatchObject({ status: "error", formError: "snapshotInvalid" });
    expect(storiesFile()).toBe(before);
  });
});

describe("refused saves leave the file alone", () => {
  it("over the writer.yaml limits, field by field", async () => {
    fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), "stories:\n  max_items: 1\n  title_max_chars: 10\n");
    const before = storiesFile();
    const result = await save({ stories: [story({ title: "A title that is too long" }), story({ title: "Two" })] });
    expect(result).toMatchObject({ status: "error", formError: null });
    expect(result.status === "error" ? result.fieldErrors.map((e) => [e.path, e.key]) : []).toEqual([
      ["stories", "tooMany"],
      ["stories.0.title", "tooLong"],
    ]);
    expect(storiesFile()).toBe(before);
    expect(await listProfileSnapshots(getDb(), "stories", 10)).toHaveLength(0);
  });

  it("an empty title or text is a field error", async () => {
    const result = await save({ stories: [story({ what: "  " })] });
    expect(result.status === "error" ? result.fieldErrors : []).toEqual([{ path: "stories.0.what", key: "required" }]);
  });

  it("a file changed elsewhere since the form was opened (stale)", async () => {
    const opened = hash();
    fs.writeFileSync(getConfigPath("stories"), "stories:\n  - id: by-hand\n    title: Edited by hand\n    what: Somewhere else\n");
    const result = await saveStories({ stories: [story({})] }, opened);
    expect(result).toMatchObject({ status: "error", formError: "stale" });
    expect(reloadConfig("stories").stories.map((s) => s.id)).toEqual(["by-hand"]);
  });

  it("a malformed request", async () => {
    expect(await saveStories({ stories: [{ title: "x" }] }, hash())).toMatchObject({ formError: "invalidPayload" });
    expect(await saveStoriesAction({ status: "idle" }, { draft: { stories: [] } })).toMatchObject({ kind: "stories", formError: "invalidPayload" });
  });
});

describe("a broken stories.yaml", () => {
  it("makes the card read-only with the error, the rest of /me still loads", async () => {
    fs.writeFileSync(getConfigPath("stories"), "stories:\n  - id: Not A Slug\n    title: x\n    what: y\n");
    const page = await loadProfilePage();
    expect(page.stories.draft).toBeNull();
    expect(page.stories.loadError).toMatch(/stories/);
    expect(page.me.draft).not.toBeNull();
    expect(page.preferences.draft).not.toBeNull();
  });
});
