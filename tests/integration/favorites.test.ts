import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, getJobDetail, getNavCounts, listFavoriteJobs, listJobs, schema, type JobFilters } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { setApplicationStatus } from "@/lib/db/repos/applications";
import { addFavorite, countFavorites, getFavorite, getFavoriteStates, removeFavorite, setFavoriteNote } from "@/lib/db/repos/favorites";
import { seedDatabase } from "@/lib/db/seed";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-07T12:00:00Z");

const list = (filters: JobFilters) => listJobs(getDb(), { filters, sort: "first_seen", page: 1, pageSize: 100, timezone: TZ });
const idOf = async (title: string): Promise<number> => {
  const [row] = await getDb().select({ id: schema.jobs.id }).from(schema.jobs).where(sql`${schema.jobs.title} = ${title}`);
  if (!row) throw new Error(`no seed job ${title}`);
  return row.id;
};
const rowCount = async (table: string): Promise<number> => Number((await getDb().execute<{ n: string }>(sql.raw(`select count(*)::text as n from ${table}`)))[0]?.n);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, runtime_state restart identity cascade`);
  await seedDatabase(getDb(), { now: NOW, timezone: TZ });
});

afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
  await closeDb();
});

describe("favorites repo", () => {
  it("adds once, reports a repeat as unchanged, removes with what the star held, and restores it as it was", async () => {
    const db = getDb();
    const id = await idOf("Data Engineer");
    expect(await getFavorite(db, id)).toBeNull();
    expect(await addFavorite(db, id)).toEqual({ changed: true });
    expect(await addFavorite(db, id)).toEqual({ changed: false });
    expect(await setFavoriteNote(db, id, "call Anna")).toBe(true);

    const before = await getFavorite(db, id);
    const removed = await removeFavorite(db, id);
    expect(removed).toEqual(before);
    expect(removed?.note).toBe("call Anna");
    expect(await removeFavorite(db, id)).toBeNull();

    const earlier = new Date("2026-09-01T08:00:00Z");
    expect(await addFavorite(db, id, { note: "call Anna", createdAt: earlier })).toEqual({ changed: true });
    expect(await getFavorite(db, id)).toEqual({ note: "call Anna", createdAt: earlier });
  });

  it("changes a note only on a starred job, and clears it with null", async () => {
    const db = getDb();
    const id = await idOf("Data Engineer");
    expect(await setFavoriteNote(db, id, "x")).toBe(false);
    await addFavorite(db, id);
    expect(await setFavoriteNote(db, id, "x")).toBe(true);
    expect(await setFavoriteNote(db, id, null)).toBe(true);
    expect((await getFavorite(db, id))?.note).toBeNull();
  });

  it("is removed with its job (cascade)", async () => {
    const db = getDb();
    const id = await idOf("Data Engineer");
    await addFavorite(db, id);
    const before = await rowCount("job_favorites");
    await db.delete(schema.jobs).where(sql`${schema.jobs.id} = ${id}`);
    expect(await rowCount("job_favorites")).toBe(before - 1);
  });

  it("touches neither applications, application events nor scores", async () => {
    const db = getDb();
    const id = await idOf("Data Engineer");
    const counts = async () => [await rowCount("applications"), await rowCount("application_events"), await rowCount("scores")];
    const before = await counts();
    const nav = await getNavCounts(db, { now: NOW, timezone: TZ });
    await addFavorite(db, id);
    await setFavoriteNote(db, id, "n");
    expect(await counts()).toEqual(before);
    await removeFavorite(db, id);
    expect(await counts()).toEqual(before);
    await addFavorite(db, id);
    const after = await getNavCounts(db, { now: NOW, timezone: TZ });
    expect(after.pipeline).toBe(nav.pipeline);
    expect(after.jobs).toBe(nav.jobs);
    expect(after.favorites).toBe(nav.favorites + 1);
  });
});

describe("favorites in the queries", () => {
  it("the seed stars a high-score job, a closed one and an applied one; the count includes the closed one", async () => {
    const db = getDb();
    const states = await getFavoriteStates(db, [await idOf("LLM Engineer"), await idOf("Prompt Engineer"), await idOf("Machine Learning Engineer, Perception"), await idOf("Data Engineer")]);
    expect([...states.values()].map((s) => s.note)).toContain("Ask about visa sponsorship before applying");
    expect(states.size).toBe(3);
    expect(await countFavorites(db)).toBe(3);
    expect((await getNavCounts(db, { now: NOW, timezone: TZ })).favorites).toBe(3);
  });

  it("listFavoriteJobs lists every star unfiltered: closed jobs and ignored jobs too, newest star first or by rank", async () => {
    const db = getDb();
    const closed = await idOf("Prompt Engineer");
    const ignored = await idOf("Data Engineer");
    await addFavorite(db, ignored);
    await setApplicationStatus(db, ignored, "archived");

    const starred = await listFavoriteJobs(db, { sort: "starred" });
    const ids = starred.map((c) => c.id);
    expect(ids).toContain(closed);
    expect(ids).toContain(ignored);
    expect(starred.find((c) => c.id === closed)?.status).toBe("closed");
    expect(starred.find((c) => c.id === ignored)?.applicationStatus).toBe("archived");
    // the star just added is the newest
    expect(ids[0]).toBe(ignored);
    const times = starred.map((c) => c.favorite?.createdAt.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const ranked = await listFavoriteJobs(db, { sort: "rank" });
    expect([...ranked.map((c) => c.id)].sort()).toEqual([...ids].sort());
    const values = ranked.filter((c) => c.rank?.filterResult !== "filtered_out").map((c) => c.rank?.rankValue ?? -1);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("a starred job can be applied at the same time: the star and the status are independent", async () => {
    const db = getDb();
    const id = await idOf("Machine Learning Engineer, Perception");
    const card = (await listFavoriteJobs(db, { sort: "starred" })).find((c) => c.id === id);
    expect(card?.applicationStatus).toBe("applied");
    expect(card?.favorite).not.toBeNull();
    await setApplicationStatus(db, id, "interviewing");
    expect(await getFavorite(db, id)).not.toBeNull();
    await removeFavorite(db, id);
    expect((await getJobDetail(db, id))?.application?.status).toBe("interviewing");
    expect((await getJobDetail(db, id))?.favorite).toBeNull();
  });

  it("favoritesOnly keeps only starred jobs, stacks with other filters and still hides filtered-out jobs unless asked", async () => {
    const db = getDb();
    const all = await list({});
    const only = await list({ favoritesOnly: true });
    expect(only.jobs.every((j) => j.favorite !== null)).toBe(true);
    expect(only.total).toBeLessThan(all.total);
    expect(only.total).toBeGreaterThan(0);

    const applied = await list({ favoritesOnly: true, applicationStatuses: ["applied"] });
    expect(applied.jobs.map((j) => j.title)).toEqual(["Machine Learning Engineer, Perception"]);

    // a starred job the hard filter removed obeys "show filtered"
    const victim = (await list({ includeFiltered: true })).jobs.find((j) => j.rank?.filterResult === "filtered_out");
    expect(victim).toBeDefined();
    if (!victim) return;
    await addFavorite(db, victim.id);
    expect((await list({ favoritesOnly: true })).jobs.map((j) => j.id)).not.toContain(victim.id);
    expect((await list({ favoritesOnly: true, includeFiltered: true })).jobs.map((j) => j.id)).toContain(victim.id);
    expect((await listFavoriteJobs(db, { sort: "starred" })).map((c) => c.id)).toContain(victim.id);
  });

  it("the list cards and the detail carry the note and time of the star", async () => {
    const db = getDb();
    const id = await idOf("LLM Engineer");
    const card = (await list({ q: "LLM Engineer" })).jobs.find((j) => j.id === id);
    expect(card?.favorite?.note).toBe("Ask about visa sponsorship before applying");
    expect((await getJobDetail(db, id))?.favorite?.note).toBe("Ask about visa sponsorship before applying");
  });
});
