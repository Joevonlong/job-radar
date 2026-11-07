import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test } from "vitest";
import { POST } from "@/app/api/career/import/route";
import { addStoryToProfileAction } from "@/app/career/actions";
import { listPendingCareerDrafts } from "@/lib/career/extract/draft-store";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { careerDir } from "@/lib/career/store/paths";
import { loadCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { tempCareer, profile } from "./fixtures";

const sample = fs.readFileSync(path.join(import.meta.dirname, "../fixtures/career/sample.en.yaml"), "utf8");
const upload = (body: string) => POST(new Request("http://127.0.0.1/api/career/import", { method: "POST", headers: { "Content-Type": "application/yaml" }, body }));
const files = (directory: string): string[] => fs.existsSync(directory)
  ? fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
  : [];

let temp: ReturnType<typeof tempCareer> | undefined;
afterEach(() => { temp?.cleanup(); temp = undefined; });

test("an upload becomes a review draft and a contact comparison, and the file itself is not stored", async () => {
  temp = tempCareer();
  await saveContact({ ...emptyContact(), name: "Existing Name" }, { baseHash: null });
  const before = new Set(files(careerDir()));
  const response = await upload(sample);
  expect(response.status).toBe(200);
  const body = await response.json() as { draftId: number; contact: { incoming: { name: string }; current: { name: string } }; layout: { incoming: object } };
  expect(body.contact.incoming.name).toBe("Lena Hartmann");
  expect(body.contact.current.name).toBe("Existing Name");
  const drafts = await listPendingCareerDrafts();
  expect(drafts.map((draft) => [draft.request_id, draft.origin])).toEqual([[body.draftId, "imported"]]);
  const added = files(careerDir()).filter((file) => !before.has(file));
  expect(added.map((file) => path.relative(careerDir(), file))).toEqual([path.join("drafts", `${body.draftId}.yaml`)]);
  for (const file of files(temp.root)) expect(fs.readFileSync(file, "utf8")).not.toContain("lena.hartmann@example.com");
});

test("invalid, oversized and disabled uploads answer with a code and never echo content", async () => {
  temp = tempCareer({ import: { max_file_bytes: 2000 } });
  let response = await upload(stringify({ basics: { title: "Private Sentinel" } }));
  expect(response.status).toBe(422);
  expect(await response.text()).not.toContain("Private Sentinel");
  response = await upload("x".repeat(3000));
  expect(await response.json()).toMatchObject({ ok: false, error: "too_large" });
  temp.cleanup();
  temp = tempCareer({ enabled: false });
  response = await upload(sample);
  expect(response.status).toBe(409);
  expect(fs.existsSync(careerDir())).toBe(false);
});

test("an import is refused once the pending draft limit is reached", async () => {
  temp = tempCareer({ import: { max_pending_drafts: 1 } });
  expect((await upload(sample)).status).toBe(200);
  const response = await upload(sample);
  expect(await response.json()).toMatchObject({ ok: false, error: "drafts_full" });
  expect(await listPendingCareerDrafts()).toHaveLength(1);
});

test("adding a story leaves the stories file byte for byte unchanged", async () => {
  temp = tempCareer();
  const storiesFile = path.join(temp.profileDir, "stories.yaml");
  fs.mkdirSync(temp.profileDir, { recursive: true });
  fs.writeFileSync(storiesFile, "# my stories\nstories:\n  - id: billing-migration\n    title: Billing\n    what: Moved billing to the new platform\n");
  const before = fs.readFileSync(storiesFile);
  const saved = await saveCareerProfile(profile("Existing bullet"), { baseHash: null });
  if (!saved.ok) throw new Error("fixture save failed");
  const experienceId = saved.profile.experience[0]!.id;
  const result = await addStoryToProfileAction({ storyId: "billing-migration", experienceId, target: "bullet", baseHash: saved.baseHash });
  expect(result).toMatchObject({ ok: true });
  expect(fs.readFileSync(storiesFile).equals(before)).toBe(true);
  const loaded = await loadCareerProfile();
  expect(loaded.profile.experience[0]!.bullets.at(-1)!.wordings[0]).toMatchObject({ origin: "from_story", from_story: "billing-migration" });
  expect(await addStoryToProfileAction({ storyId: "billing-migration", experienceId, target: "bullet", baseHash: loaded.baseHash })).toEqual({ ok: false, code: "story_present" });
});
