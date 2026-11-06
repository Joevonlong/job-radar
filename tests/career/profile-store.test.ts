import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { loadContact, saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { clearCareerHistory, deleteCareerData } from "@/lib/career/store/delete";
import { listVersions, readVersion } from "@/lib/career/store/history";
import { careerDir, careerProfilePath, careerContactPath, careerHistoryDir } from "@/lib/career/store/paths";
import { loadCareerProfile, restoreCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { setConfigWriteLockProviderForTests } from "@/lib/config/write-lock";
import { inProcessConfigWriteLock } from "../config/in-process-lock";
import { profile, tempCareer } from "./fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => {
  temp = tempCareer({ history: { keep_versions: 2 } });
});
afterEach(() => temp.cleanup());

async function save(value = "Built a service") {
  const loaded = await loadCareerProfile();
  const draft = loaded.baseHash ? loaded.profile : profile(value);
  draft.experience[0]!.bullets[0]!.wordings[0]!.text = value;
  const result = await saveCareerProfile(draft, { baseHash: loaded.baseHash });
  if (!result.ok) throw new Error(result.code);
  return result;
}

describe("career profile storage", () => {
  it("does not create directories while loading an empty profile or contact", async () => {
    expect((await loadCareerProfile()).baseHash).toBeNull();
    expect((await loadContact()).baseHash).toBeNull();
    expect(await listVersions()).toEqual([]);
    expect(fs.existsSync(careerDir())).toBe(false);
  });
  it("saves with stable ids, hashes, exact private modes and one history version", async () => {
    const saved = await save();
    expect((await loadCareerProfile()).profile).toEqual(saved.profile);
    expect(saved.baseHash).toMatch(/^[a-f0-9]{64}$/);
    const versions = await listVersions();
    expect(versions).toHaveLength(1);
    expect(await readVersion(versions[0]!.id)).toEqual(saved.profile);
    for (const file of [careerProfilePath(), path.join(careerHistoryDir(), "profile", versions[0]!.id)])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const next = await save("Changed");
    expect(next.profile.experience[0]!.id).toBe(saved.profile.experience[0]!.id);
  });
  it("rejects stale saves including concurrent requests and leaves unchanged saves unversioned", async () => {
    const saved = await save();
    expect(await saveCareerProfile(saved.profile, { baseHash: null })).toEqual({ ok: false, code: "stale" });
    const before = fs.statSync(careerProfilePath()).mtimeMs;
    await saveCareerProfile(saved.profile, { baseHash: saved.baseHash });
    expect(await listVersions()).toHaveLength(1);
    expect(fs.statSync(careerProfilePath()).mtimeMs).toBe(before);
    const a = structuredClone(saved.profile);
    a.experience[0]!.company = "First";
    const b = structuredClone(saved.profile);
    b.experience[0]!.company = "Second";
    const results = await Promise.all([
      saveCareerProfile(a, { baseHash: saved.baseHash }),
      saveCareerProfile(b, { baseHash: saved.baseHash }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "stale" }]);
  });
  it("prunes oldest versions and restores old content as a new version with its original ids", async () => {
    const first = await save("One");
    const oldest = (await listVersions())[0]!;
    await save("Two");
    await save("Three");
    expect(await listVersions()).toHaveLength(2);
    await expect(readVersion(oldest.id)).rejects.toThrow("version_missing");
    const current = await loadCareerProfile();
    const restored = await restoreCareerProfile(first.profile, { baseHash: current.baseHash });
    expect(restored.ok).toBe(true);
    expect((await loadCareerProfile()).profile).toEqual(first.profile);
    expect(await listVersions()).toHaveLength(2);
    expect((await listVersions())[0]!.id).not.toBe(oldest.id);
  });
  it("returns a history warning when only history fails", async () => {
    fs.mkdirSync(careerDir(), { recursive: true });
    fs.writeFileSync(careerHistoryDir(), "not a directory");
    const result = await save();
    expect(result.warnings).toEqual(["history_failed"]);
    expect((await loadCareerProfile()).baseHash).toBe(result.baseHash);
  });
  it("scrubs parser details without a cause", async () => {
    fs.mkdirSync(careerDir(), { recursive: true });
    for (const [file, load, code] of [
      [careerProfilePath(), loadCareerProfile, "profile_invalid"],
      [careerContactPath(), loadContact, "contact_invalid"],
    ] as const) {
      fs.writeFileSync(file, "private-sentinel: [broken");
      try {
        await load();
        throw new Error("did not reject");
      } catch (error) {
        expect(error).toBeInstanceOf(CareerStoreError);
        expect((error as CareerStoreError).code).toBe(code);
        expect("cause" in (error as Error)).toBe(false);
        expect(String(error)).not.toContain("private-sentinel");
      }
    }
  });
  it("rejects unknown ids and enforces configured limits on the save path", async () => {
    const result = await save();
    await deleteCareerData();
    await expect(saveCareerProfile(result.profile, { baseHash: null })).rejects.toThrow("unknown_id");
    temp.cleanup();
    temp = tempCareer({ profile: { max_bullets_per_entry: 1 } });
    const draft = profile();
    draft.experience[0]!.bullets.push(profile().experience[0]!.bullets[0]!);
    await expect(saveCareerProfile(draft, { baseHash: null })).rejects.toThrow("limits");
  });
  it("records no history when another process deletes the profile between the two locks", async () => {
    const saved = await save();
    let acquired = 0;
    setConfigWriteLockProviderForTests(async (options) => {
      acquired += 1;
      if (acquired === 2) fs.rmSync(careerDir(), { recursive: true, force: true });
      return inProcessConfigWriteLock(options);
    });
    try {
      const draft = structuredClone(saved.profile);
      draft.experience[0]!.company = "Changed";
      const result = await saveCareerProfile(draft, { baseHash: saved.baseHash });
      expect(result).toMatchObject({ ok: true, warnings: [] });
    } finally {
      setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
    }
    expect(acquired).toBe(2);
    expect(fs.existsSync(careerDir())).toBe(false);
  });
});

describe("contact and deletion", () => {
  it("distinguishes unreadable contact files from invalid contact content", async () => {
    fs.mkdirSync(careerContactPath(), { recursive: true });
    await expect(loadContact()).rejects.toMatchObject({ code: "contact_unreadable" });
    fs.rmdirSync(careerContactPath());
    fs.writeFileSync(careerContactPath(), "name: [private-parser-sentinel");
    await expect(loadContact()).rejects.toMatchObject({ code: "contact_invalid" });
  });
  it("overwrites contact without history and keeps old contact values out of history", async () => {
    await save();
    const first = await saveContact({ ...emptyContact(), email: "old-contact@example.invalid" }, { baseHash: null });
    if (!first.ok) throw new Error("save failed");
    const second = await saveContact(
      { ...first.contact, email: "new-contact@example.invalid" },
      { baseHash: first.baseHash },
    );
    expect(second.ok).toBe(true);
    expect(fs.statSync(careerContactPath()).mode & 0o777).toBe(0o600);
    expect(await saveContact(first.contact, { baseHash: first.baseHash })).toEqual({ ok: false, code: "stale" });
    const versions = await listVersions();
    expect(versions).toHaveLength(1);
    for (const version of versions)
      expect(JSON.stringify(await readVersion(version.id))).not.toContain("contact@example.invalid");
    expect(fs.readFileSync(careerContactPath(), "utf8")).not.toContain("old-contact");
  });
  it("clears only history, then invokes the cancellation seam and deletes the entire directory", async () => {
    await save();
    await saveContact(emptyContact(), { baseHash: null });
    await clearCareerHistory();
    expect(fs.existsSync(careerHistoryDir())).toBe(false);
    expect(fs.existsSync(careerProfilePath())).toBe(true);
    expect(fs.existsSync(careerContactPath())).toBe(true);
    let cancelled = false;
    await deleteCareerData(async () => {
      expect(fs.existsSync(careerDir())).toBe(true);
      cancelled = true;
    });
    expect(cancelled).toBe(true);
    expect(fs.existsSync(careerDir())).toBe(false);
    await deleteCareerData();
    expect(fs.existsSync(careerDir())).toBe(false);
  });
});
