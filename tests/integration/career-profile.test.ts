import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getLocale: async () => "en", getTranslations: async () => (key: string) => key }));
import { CareerCard } from "@/components/career/career-card";
import CareerPage from "@/app/career/page";
import { deleteCareerAction, saveProfileAction } from "@/app/career/actions";
import { ensureProfileFiles, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { loadContact, saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { careerDir, careerProfilePath } from "@/lib/career/store/paths";
import { listVersions } from "@/lib/career/store/history";
import { loadCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { deleteCareerData } from "@/lib/career/store/delete";
import { listArchiveMembers, writeConfigArchive } from "@/lib/ops/config-archive";
import { profile, tempCareer } from "../career/fixtures";
import { withRebuiltCurrentScores } from "../helpers/current-scores";

const url = inject("testDatabaseUrl");
let temp: ReturnType<typeof tempCareer>;
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(() => {
  temp = tempCareer();
});
afterEach(() => {
  setOnProfileSaved(null);
  temp.cleanup();
  vi.restoreAllMocks();
});
afterAll(closeDb);

it("saves through the real file and database config locks with private permissions", async () => {
  const result = await saveCareerProfile(profile(), { baseHash: null });
  expect(result.ok).toBe(true);
  const contact = await saveContact({ ...emptyContact(), name: "Local sentinel" }, { baseHash: null });
  expect(contact.ok).toBe(true);
  const versions = await listVersions();
  expect(versions).toHaveLength(1);
  for (const file of [
    careerProfilePath(),
    path.join(careerDir(), "contact.yaml"),
    path.join(careerDir(), "history/profile", versions[0]!.id),
  ])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

it("serializes concurrent saves and rejects the stale base", async () => {
  const results = await Promise.all([
    saveCareerProfile(profile("First"), { baseHash: null }),
    saveCareerProfile(profile("Second"), { baseHash: null }),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "stale" }]);
  expect(await listVersions()).toHaveLength(1);
});

it("keeps stored adoption keys when the editor action saves under real locks", async () => {
  const saved = await saveCareerProfile({ ...profile(), adopted_entries: ["1:d0", "2:headline"] }, { baseHash: null });
  if (!saved.ok) throw new Error(saved.code);
  const { adopted_entries, ...edit } = saved.profile;
  edit.experience[0]!.company = "Edited company";
  expect(await saveProfileAction({ profile: edit, baseHash: null })).toEqual({ ok: false, code: "stale" });
  expect(await saveProfileAction({ profile: edit, baseHash: saved.baseHash }))
    .toMatchObject({ ok: true, profile: { adopted_entries } });
  expect((await loadCareerProfile()).profile).toEqual({ ...edit, adopted_entries });
});

it("leaves matching snapshots, score staleness and the existing profile files unchanged", async () => {
  await ensureProfileFiles();
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title: "Engineer", titleNorm: "engineer" })
    .returning();
  await withRebuiltCurrentScores(
    db,
    db.insert(schema.scores).values({ jobId: job!.id, filterResult: "passed", score: 70, stale: false }),
  );
  const snapshots = await db.select().from(schema.profileSnapshots);
  const scores = await db.select().from(schema.scores);
  const files = ["me.yaml", "stories.yaml"].map((file) => ({
    file,
    bytes: fs.readFileSync(path.join(temp.profileDir, file)),
  }));
  let called = false;
  setOnProfileSaved(async () => {
    called = true;
  });
  expect((await saveCareerProfile(profile(), { baseHash: null })).ok).toBe(true);
  expect(await db.select().from(schema.profileSnapshots)).toEqual(snapshots);
  expect(await db.select().from(schema.scores)).toEqual(scores);
  expect(called).toBe(false);
  for (const { file, bytes } of files) expect(fs.readFileSync(path.join(temp.profileDir, file))).toEqual(bytes);
});

it("includes the career directory and its history in a config archive and restores it intact", async () => {
  await saveCareerProfile(profile(), { baseHash: null });
  await saveContact({ ...emptyContact(), email: "contact-sentinel@example.invalid" }, { baseHash: null });
  const loaded = await loadCareerProfile();
  const contact = await loadContact();
  const versions = await listVersions();
  const dirs = { config: temp.configDir, profile: temp.profileDir };
  expect(await listArchiveMembers(dirs)).toEqual(
    expect.arrayContaining([
      "data/profile/career/profile.yaml",
      "data/profile/career/contact.yaml",
      `data/profile/career/history/profile/${versions[0]!.id}`,
    ]),
  );
  const destination = path.join(temp.root, "career.config.tgz");
  await writeConfigArchive({ dirs, destination });
  await deleteCareerData();
  const restored = path.join(temp.root, "restored");
  fs.mkdirSync(restored);
  const result = spawnSync("tar", ["-xzf", destination, "-C", restored], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  process.env.JOB_RADAR_PROFILE_DIR = path.join(restored, "data/profile");
  expect((await loadCareerProfile()).profile).toEqual(loaded.profile);
  expect((await loadCareerProfile()).baseHash).toBe(loaded.baseHash);
  expect(await loadContact()).toEqual(contact);
  expect(await listVersions()).toEqual(versions);
});

it("closes card, page and actions when the config breaks after a warm enabled cache", async () => {
  expect(reloadConfig("career").enabled).toBe(true);
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: [broken");
  expect(await CareerCard()).toBeNull();
  expect((await CareerPage()).props["data-testid"]).toBe("career-disabled");
  expect(await saveProfileAction({ profile: profile(), baseHash: null })).toEqual({ ok: false, code: "disabled" });
  expect(await deleteCareerAction({ confirmed: true, kind: "all" })).toEqual({ ok: false, code: "disabled" });
  expect(fs.existsSync(careerDir())).toBe(false);
  fs.unlinkSync(path.join(temp.configDir, "career.yaml"));
  expect(await CareerCard()).toBeNull();
});
