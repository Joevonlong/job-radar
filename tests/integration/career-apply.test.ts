import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { POST as apply } from "@/app/api/career/apply/route";
import { POST as storyExtract } from "@/app/api/me/story-extract/route";
import { POST as storyPrepare } from "@/app/api/me/story-extract/prepare/route";
import { confirmApply, previewApply, type ApplyPreview } from "@/lib/career/apply/service";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { saveCareerProfile } from "@/lib/career/store/profile";
import { getConfigPath, resetConfigCache, setOnProfileSaved } from "@/lib/config";
import { closeDb, getDb, saveProfileSnapshot, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { previewStaleOnProfileChange, recordProfileSnapshot, registerProfileSnapshotHook } from "@/lib/profile/snapshots";
import { careerProfileSchema } from "@/lib/career/schema/profile";
import { text, tempCareer } from "../career/fixtures";
import { withRebuiltCurrentScores } from "../helpers/current-scores";

const url = inject("testDatabaseUrl");
let temp: ReturnType<typeof tempCareer>;

const ME = "languages: []\nskills:\n  - { name: Go, years: 5 }\nyears_experience: 5\ncity: Example City\nneeds_visa_sponsorship: false\nsummary: Backend engineer.\n";
const STORIES = "stories:\n  - id: my-own\n    title: My own story\n    what: Written by hand.\n";

const SENTINEL = {
  name: "Zed Sentinelname",
  address: "Sentinelstrasse 99",
  email: "sentinel@example.invalid",
  phone: "+49 30 99887766",
  work_auth: "Sentinel work permit text",
  availability: "Sentinel availability text",
  location: "Sentinelcity",
  link: "https://sentinel.example.invalid/me",
};

function profileWith(bullet = "Cut build time by 40%.", extra: Record<string, unknown> = {}) {
  return careerProfileSchema.parse({
    summary: text("Platform engineer."),
    languages: [{ id: "", name: "English", level: "fluent", code: "en", cefr: "C1" }],
    skills: [{ id: "", group: "Code", items: [{ id: "", name: "TypeScript", years: 4 }] }],
    experience: [{ id: "", company: "Acme", role: text("Engineer"), start: "2020-01", end: "2021-12", summary: text("Ran the platform team."), bullets: [text(bullet)], stack: ["TypeScript"] }],
    ...extra,
  });
}

function profileFile(name: "me" | "stories"): string {
  return fs.readFileSync(getConfigPath(name), "utf8");
}

async function seedScores(count: number): Promise<number> {
  const db = getDb();
  const snapshot = await saveProfileSnapshot(db, "preferences", `seed: ${Math.random()}\n`);
  for (let i = 0; i < count; i += 1) {
    const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: `acme-${Math.random()}` }).returning();
    const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, title: "Engineer", titleNorm: "engineer" }).returning();
    await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job!.id, profileSnapshotId: snapshot.id, filterResult: "passed", score: 70 }));
  }
  return snapshot.id;
}

async function scoreState() {
  const rows = await getDb().select({ id: schema.scores.id, stale: schema.scores.stale }).from(schema.scores);
  return rows.sort((a, b) => a.id - b.id);
}

function realHook() {
  registerProfileSnapshotHook();
  setOnProfileSaved(async (kind, yamlText) => {
    if (kind === "stories") {
      await saveProfileSnapshot(getDb(), kind, yamlText);
      return;
    }
    return { staleMarked: (await recordProfileSnapshot(getDb(), kind, yamlText)).staleMarked };
  });
}

function request(body: unknown, route = "http://127.0.0.1/api/career/apply"): Request {
  return new Request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function setUpProfile(bullet?: string) {
  const saved = await saveCareerProfile(profileWith(bullet), { baseHash: null });
  if (!saved.ok) throw new Error(saved.code);
}

async function preview(): Promise<ApplyPreview> {
  const result = await previewApply(null);
  if ("error" in result) throw new Error(result.error);
  return result;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  temp = tempCareer();
  fs.mkdirSync(path.dirname(getConfigPath("me")), { recursive: true });
  fs.writeFileSync(getConfigPath("me"), ME);
  fs.writeFileSync(getConfigPath("stories"), STORIES);
  fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), "enabled: true\n");
  resetConfigCache();
  const db = getDb();
  await withRebuiltCurrentScores(db, db.delete(schema.scores));
  await db.delete(schema.jobs);
  await db.delete(schema.companies);
  await db.delete(schema.profileSnapshots);
  await db.delete(schema.controlRequests);
  realHook();
});

afterEach(() => {
  realHook();
  temp.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  setOnProfileSaved(null);
  await closeDb();
});

describe("the stale count of the preview", () => {
  it("equals what the real save marks, branch by branch", async () => {
    const db = getDb();
    await seedScores(3);
    const first = "languages: []\nskills: []\nyears_experience: 1\ncity: X\nneeds_visa_sponsorship: false\nsummary: A\n";
    const expectSame = async (yaml: string) => {
      const expected = await previewStaleOnProfileChange(db, yaml);
      const actual = (await recordProfileSnapshot(db, "me", yaml)).staleMarked;
      expect(expected).toBe(actual);
      return actual;
    };
    expect(await expectSame(first)).toBe(3);
    expect(await expectSame(first)).toBe(0);
    expect(await expectSame(`${first}# only a comment\n`)).toBe(0);
    await seedScores(2);
    const second = first.replace("summary: A", "summary: B");
    expect(await expectSame(second)).toBe(2);
    expect(await expectSame(second.replace("summary: B", "summary: C"))).toBe(0);
    await seedScores(1);
    expect(await expectSame(first)).toBe(1);
  });
});

describe("apply to matching", () => {
  it("previews without writing anything", async () => {
    await setUpProfile();
    await seedScores(2);
    const before = { me: profileFile("me"), stories: profileFile("stories"), scores: await scoreState(), snapshots: await getDb().select().from(schema.profileSnapshots) };
    const result = await preview();
    expect(result.staleCount).toBe(2);
    expect(result.selection.me).toEqual({ languages: true, skills: true, years_experience: true, summary: false });
    expect(result.stories.changes.map((change) => change.kind)).toEqual(["new"]);
    expect({ me: profileFile("me"), stories: profileFile("stories"), scores: await scoreState(), snapshots: await getDb().select().from(schema.profileSnapshots) }).toEqual(before);
  });

  it("writes both files, reports the scores it marked and is idempotent", async () => {
    await setUpProfile();
    await seedScores(2);
    const first = await preview();
    const result = await confirmApply(first.selection, first.bases);
    expect(result).toEqual({ status: "applied", me: "written", stories: "written", staleMarked: 2, staleExpected: 2 });
    expect(profileFile("me")).toContain("TypeScript");
    expect(profileFile("me")).toContain("Example City");
    expect(profileFile("stories")).toContain("my-own");
    expect(profileFile("stories")).toMatch(/id: career-[a-z2-7]{10}/);
    const bytes = { me: profileFile("me"), stories: profileFile("stories") };
    const again = await preview();
    expect(again.noChanges).toBe(true);
    expect(await confirmApply(again.selection, again.bases)).toEqual({ status: "applied", me: "unchanged", stories: "unchanged", staleMarked: 0, staleExpected: 0 });
    expect({ me: profileFile("me"), stories: profileFile("stories") }).toEqual(bytes);
  });

  it("refuses a confirmation whose files changed since the preview and writes nothing", async () => {
    await setUpProfile();
    const first = await preview();
    fs.writeFileSync(getConfigPath("stories"), `${STORIES}  - id: added-meanwhile\n    title: Added\n    what: Meanwhile.\n`);
    resetConfigCache();
    const stories = profileFile("stories");
    const me = profileFile("me");
    const result = await confirmApply(first.selection, first.bases);
    expect(result.status).toBe("stale");
    expect({ me: profileFile("me"), stories: profileFile("stories") }).toEqual({ me, stories });
  });

  it("refuses a confirmation when a score finished after the preview", async () => {
    await setUpProfile();
    await seedScores(1);
    const first = await preview();
    await seedScores(1);
    const me = profileFile("me");
    const result = await confirmApply(first.selection, first.bases);
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.preview.staleCount).toBe(2);
    expect(profileFile("me")).toBe(me);
    expect((await scoreState()).every((row) => !row.stale)).toBe(true);
  });

  it("shows the number actually marked when a score finishes between the recheck and the save", async () => {
    await setUpProfile();
    await seedScores(1);
    const first = await preview();
    registerProfileSnapshotHook();
    setOnProfileSaved(async (kind, yamlText) => {
      if (kind === "stories") return;
      await seedScores(1);
      return { staleMarked: (await recordProfileSnapshot(getDb(), kind, yamlText)).staleMarked };
    });
    const result = await confirmApply(first.selection, first.bases);
    expect(result).toMatchObject({ status: "applied", me: "written", staleMarked: 2, staleExpected: 1 });
  });

  it("reports me.yaml written while stories.yaml failed, and an unknown count when the snapshot failed", async () => {
    await setUpProfile();
    fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), "enabled: true\nstories:\n  text_max_chars: 100\n");
    fs.writeFileSync(getConfigPath("stories"), `stories:\n  - id: my-own\n    title: My own story\n    what: ${"x".repeat(150)}\n`);
    resetConfigCache();
    const first = await preview();
    expect(await confirmApply(first.selection, first.bases)).toMatchObject({ status: "applied", me: "written", stories: "failed" });

    fs.writeFileSync(getConfigPath("me"), ME);
    fs.writeFileSync(getConfigPath("stories"), STORIES);
    resetConfigCache();
    setOnProfileSaved(async () => {
      throw new Error("database down");
    });
    const second = await preview();
    expect(await confirmApply(second.selection, second.bases)).toMatchObject({ status: "applied", me: "snapshot_failed", staleMarked: null });
    expect(profileFile("me")).toContain("TypeScript");
  });

  it("keeps contact details out of me.yaml, stories.yaml, snapshots and the preview", async () => {
    const contact = await saveContact({ ...emptyContact(), name: SENTINEL.name, address: SENTINEL.address, email: SENTINEL.email, phone: SENTINEL.phone, work_auth: SENTINEL.work_auth, availability: SENTINEL.availability, location: SENTINEL.location, links: [{ label: "Site", url: SENTINEL.link }] }, { baseHash: null });
    expect(contact.ok).toBe(true);
    const leaky = `Reach ${SENTINEL.name} at ${SENTINEL.email} or ${SENTINEL.phone}, ${SENTINEL.address}, ${SENTINEL.link}. ${SENTINEL.work_auth}. ${SENTINEL.availability}.`;
    const saved = await saveCareerProfile(profileWith(leaky, {
      summary: text(leaky),
      skills: [{ id: "", group: "Code", items: [{ id: "", name: SENTINEL.email, years: 1 }, { id: "", name: "TypeScript", years: 4 }] }],
      experience: [{ id: "", company: "Acme", url: "https://acme.example.invalid/", location: SENTINEL.location, role: text("Engineer"), start: "2020-01", end: "2021-12", summary: text(leaky), bullets: [text(leaky)], stack: [SENTINEL.name, "TypeScript"] }],
    }), { baseHash: null });
    if (!saved.ok) throw new Error(saved.code);
    const first = await preview();
    const response = await apply(request({ action: "preview", selection: { ...first.selection, me: { ...first.selection.me, summary: true } } }));
    const body = await response.text();
    const second = (JSON.parse(body) as { preview: ApplyPreview }).preview;
    const result = await confirmApply(second.selection, second.bases);
    expect(result).toMatchObject({ status: "applied", me: "written", stories: "written" });
    const snapshots = (await getDb().select().from(schema.profileSnapshots)).map((row) => row.contentYaml).join("\n");
    const outputs = [profileFile("me"), profileFile("stories"), snapshots, body, JSON.stringify(first)].join("\n");
    for (const value of [SENTINEL.name, SENTINEL.address, SENTINEL.email, SENTINEL.phone, SENTINEL.work_auth, SENTINEL.availability, SENTINEL.link, "acme.example.invalid"]) expect(outputs).not.toContain(value);
    expect(profileFile("me")).toContain("city: Example City");
    expect(outputs).not.toContain(SENTINEL.location);
  });
});

describe("the apply route", () => {
  it("is refused while the career profile is off", async () => {
    fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: false\n");
    resetConfigCache();
    const response = await apply(request({ action: "preview", selection: null }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "disabled" });
  });

  it("asks for me.yaml first", async () => {
    await setUpProfile();
    fs.unlinkSync(getConfigPath("me"));
    resetConfigCache();
    const response = await apply(request({ action: "preview", selection: null }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "me_required" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("starts the experience library when there is no stories.yaml yet", async () => {
    await setUpProfile();
    fs.unlinkSync(getConfigPath("stories"));
    resetConfigCache();
    const preview = await previewApply(null);
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.stories.changes.some((change) => change.kind === "new")).toBe(true);
    expect(await confirmApply(preview.selection, preview.bases)).toMatchObject({ status: "applied", stories: "written" });
    expect(fs.existsSync(getConfigPath("stories"))).toBe(true);
  });
});

describe("story extraction while the career profile is on", () => {
  const sources = [
    () => storyPrepare(request({ origin: "profile" }, "http://127.0.0.1/api/me/story-extract/prepare")),
    () => storyPrepare(request({ text: "A pasted self-description that is long enough to read." }, "http://127.0.0.1/api/me/story-extract/prepare")),
    () => {
      const form = new FormData();
      form.set("file", new File(["A résumé text that is long enough to be read."], "resume.txt"));
      return storyPrepare(new Request("http://127.0.0.1/api/me/story-extract/prepare", { method: "POST", body: form }));
    },
    ...(["profile", "self_description", "resume"] as const).map((origin) => () => storyExtract(request({ origin, text: "Confirmed text that is long enough to be sent." }, "http://127.0.0.1/api/me/story-extract"))),
  ];

  it.each(sources.map((source, index) => [index, source] as const))("refuses source %i with use_career and queues nothing", async (_index, source) => {
    const response = await source();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "use_career" });
    expect(await getDb().select().from(schema.controlRequests)).toEqual([]);
  });

  it("treats a broken career.yaml as off and goes through the preview path", async () => {
    fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: [broken");
    resetConfigCache();
    const response = await storyPrepare(request({ text: "A pasted self-description that is long enough to be read by the preview." }, "http://127.0.0.1/api/me/story-extract/prepare"));
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.error).not.toBe("use_career");
  });
});
