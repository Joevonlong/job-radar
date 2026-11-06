import fs from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { careerDraftPath, discardCareerDraft, listPendingCareerDrafts, readCareerDraft, writeCareerDraft } from "@/lib/career/extract/draft-store";
import { careerDir } from "@/lib/career/store/paths";
import { draft } from "./extract-fixtures";
import { tempCareer } from "./fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => { temp = tempCareer({ import: { draft_ttl_days: 2 } }); });
afterEach(() => temp.cleanup());
it("commits and reads a private draft, then removes it under its own lock", async () => {
  const value = { ...draft(), created_at: new Date().toISOString() };
  expect(await writeCareerDraft(value, async () => true)).toBe(true);
  expect(fs.statSync(careerDraftPath(1)).mode & 0o777).toBe(0o600);
  expect(await readCareerDraft(1)).toEqual(value);
  expect(await listPendingCareerDrafts()).toEqual([value]);
  await discardCareerDraft(1);
  expect(await listPendingCareerDrafts()).toEqual([]);
});
it("does not recreate the career directory for a cancelled request", async () => {
  expect(await writeCareerDraft(draft(), async () => false)).toBe(false);
  expect(fs.existsSync(careerDir())).toBe(false);
});
it("prunes expired drafts on listing and new writes", async () => {
  await writeCareerDraft(draft(), async () => true);
  await writeCareerDraft({ ...draft(2), created_at: new Date().toISOString() }, async () => true);
  expect(fs.existsSync(careerDraftPath(1))).toBe(false);
  expect(await listPendingCareerDrafts()).toHaveLength(1);
  await discardCareerDraft(2);
  await writeCareerDraft(draft(), async () => true);
  expect(await listPendingCareerDrafts()).toEqual([]);
});
it("rejects invalid draft IDs and wraps corrupt YAML without source text", async () => {
  expect(() => careerDraftPath(-1)).toThrow();
  await writeCareerDraft(draft(), async () => true);
  fs.writeFileSync(careerDraftPath(1), "sections: [private-value");
  await expect(readCareerDraft(1)).rejects.toMatchObject({ code: "draft_invalid" });
});
