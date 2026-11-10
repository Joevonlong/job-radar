import fs from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";

import { diffVersionAction, restoreVersionAction, saveProfileAction } from "@/app/career/actions";
import { careerAiView } from "@/lib/career/ai/view";
import { adoptDraft } from "@/lib/career/extract/adopt";
import { profileEntryCount } from "@/lib/career/schema/profile";
import { listVersions, readVersion } from "@/lib/career/store/history";
import { careerDir, careerProfilePath } from "@/lib/career/store/paths";
import { loadCareerProfile, restoreCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { draft } from "./extract-fixtures";
import { profile, tempCareer } from "./fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => { temp = tempCareer(); });
afterEach(() => temp.cleanup());

it("preserves stored adoption keys through an editor action and rejects a stale edit", async () => {
  const initial = { ...profile(), adopted_entries: ["1:d0", "2:headline"] };
  const saved = await saveCareerProfile(initial, { baseHash: null });
  if (!saved.ok) throw new Error(saved.code);
  const { adopted_entries, ...edit } = structuredClone(saved.profile);
  edit.experience[0]!.company = "Edited company";
  expect(await saveProfileAction({ profile: edit, baseHash: null })).toEqual({ ok: false, code: "stale" });
  expect((await loadCareerProfile()).profile).toEqual(saved.profile);
  const result = await saveProfileAction({ profile: edit, baseHash: saved.baseHash });
  expect(result).toMatchObject({ ok: true, profile: { adopted_entries } });
  const loaded = await loadCareerProfile();
  expect(loaded.profile.adopted_entries).toEqual(adopted_entries);
  expect(loaded.profile.experience[0]!.company).toBe("Edited company");
  expect(await readVersion((await listVersions())[0]!.id)).toEqual(loaded.profile);
  expect(await saveProfileAction({ profile: { ...edit, adopted_entries: ["99:d0"] }, baseHash: loaded.baseHash }))
    .toMatchObject({ ok: true, profile: { adopted_entries } });
});

it("keeps adoption closed after restoring a version from before the draft was adopted", async () => {
  const before = await saveCareerProfile(profile(), { baseHash: null });
  if (!before.ok) throw new Error(before.code);
  const version = (await listVersions())[0]!;
  const source = draft();
  const decisions = [{ key: source.sections.experience[0]!.key, action: "new" as const }];
  const adopted = await saveCareerProfile(adoptDraft(before.profile, source, decisions), { baseHash: before.baseHash });
  if (!adopted.ok) throw new Error(adopted.code);
  expect(adopted.profile.experience).toHaveLength(2);
  expect(await restoreVersionAction({ version: version.id, baseHash: adopted.baseHash }))
    .toMatchObject({ ok: true, profile: { adopted_entries: adopted.profile.adopted_entries } });
  const restored = await loadCareerProfile();
  expect(restored.profile.experience).toEqual(before.profile.experience);
  const retried = await saveCareerProfile(adoptDraft(restored.profile, source, decisions), { baseHash: restored.baseHash });
  expect(retried).toMatchObject({ ok: true, baseHash: restored.baseHash, profile: restored.profile });
});

it("unions current and restored adoption keys without duplicates", async () => {
  const saved = await saveCareerProfile({ ...profile(), adopted_entries: ["1:d0", "2:summary"] }, { baseHash: null });
  if (!saved.ok) throw new Error(saved.code);
  const historical = { ...saved.profile, adopted_entries: ["2:summary", "3:d1"] };
  expect(await restoreCareerProfile(historical, { baseHash: saved.baseHash }))
    .toMatchObject({ ok: true, profile: { adopted_entries: ["1:d0", "2:summary", "3:d1"] } });
});

it("hides metadata from version comparisons while retaining visible changes", async () => {
  const saved = await saveCareerProfile(profile(), { baseHash: null });
  if (!saved.ok) throw new Error(saved.code);
  const version = (await listVersions())[0]!;
  const current = await saveCareerProfile({ ...saved.profile, adopted_entries: ["1:d0"] }, { baseHash: saved.baseHash });
  if (!current.ok) throw new Error(current.code);
  const unchanged = await diffVersionAction({ version: version.id });
  expect(unchanged.ok).toBe(true);
  if (!unchanged.ok) throw new Error(unchanged.code);
  expect(unchanged.changes.every((part) => !part.added && !part.removed)).toBe(true);
  expect(unchanged.changes.map((part) => part.value).join("")).not.toMatch(/adopted_entries|1:d0/);
  const edit = structuredClone(current.profile);
  edit.experience[0]!.company = "Changed company";
  await saveCareerProfile(edit, { baseHash: current.baseHash });
  const changed = await diffVersionAction({ version: version.id });
  if (!changed.ok) throw new Error(changed.code);
  expect(changed.changes.some((part) => part.added && part.value.includes("Changed company"))).toBe(true);
  expect(changed.changes.some((part) => part.removed && part.value.includes("Example"))).toBe(true);
  expect(changed.changes.map((part) => part.value).join("")).not.toMatch(/adopted_entries|1:d0/);
});

it("keeps adoption metadata out of profile summaries and entry counts", () => {
  const original = profile();
  const adopted = { ...original, adopted_entries: ["1:d0", "2:headline"] };
  expect(profileEntryCount(adopted)).toBe(profileEntryCount(original));
  expect(careerAiView(adopted)).toBe(careerAiView(original));
  expect(careerAiView(adopted)).not.toContain("adopted_entries");
});

it("loads and saves an old-format profile without adding empty metadata", async () => {
  fs.mkdirSync(careerDir(), { recursive: true });
  fs.copyFileSync("tests/fixtures/career/profile-before-adoption.yaml", careerProfilePath());
  const loaded = await loadCareerProfile();
  expect(loaded.profile.adopted_entries).toEqual([]);
  expect(await saveProfileAction({ profile: parse(fs.readFileSync(careerProfilePath(), "utf8")), baseHash: loaded.baseHash }))
    .toMatchObject({ ok: true });
  loaded.profile.certifications[0]!.issuer = "Edited institute";
  const { adopted_entries, ...edit } = loaded.profile;
  expect(adopted_entries).toEqual([]);
  expect(await saveProfileAction({ profile: edit, baseHash: loaded.baseHash })).toMatchObject({ ok: true });
  expect(parse(fs.readFileSync(careerProfilePath(), "utf8"))).not.toHaveProperty("adopted_entries");
  expect((await loadCareerProfile()).profile).toEqual(loaded.profile);
  expect(await readVersion((await listVersions())[0]!.id)).toEqual(loaded.profile);
});
