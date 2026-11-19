import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from "vitest";

import type { Permission } from "@/lib/agent-access/permissions";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { createConnection } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { createReadOnlyDb } from "@/lib/db/read-only-client";
import { revertApplicationStatus, setApplicationStatus } from "@/lib/db/repos/applications";
import { addFavorite, removeFavorite, setFavoriteNote } from "@/lib/db/repos/favorites";
import { setFilterOverride } from "@/lib/db/repos/filter-overrides";
import { markSeen } from "@/lib/db/repos/seen";
import * as schema from "@/lib/db/schema";
import { SYNC_BLOCKS } from "@/lib/db/sync-sources";
import { getApplicationOutput, listFavoritesOutput } from "@/lib/mcp/dto/read-tracking";
import { listApplicationChangesOutput, listJobChangesOutput } from "@/lib/mcp/dto/sync";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

import { trapSettings } from "../traps/helpers";

const url = inject("testDatabaseUrl");
const writer = createConnection(url, { max: 1 });
const second = createConnection(url, { max: 1 });
const reader = createReadOnlyDb({ url });
const now = new Date("2026-03-13T12:00:00Z");
const text = mcpTranslator("en");
const closers: Array<() => Promise<void>> = [];
let companyId: number;

beforeEach(async () => {
  const [company] = await writer.db.insert(schema.companies).values({ name: "Example Systems", nameNorm: "example systems" }).returning();
  companyId = company!.id;
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

afterAll(async () => {
  await Promise.all([reader.close(), writer.sql.end({ timeout: 5 }), second.sql.end({ timeout: 5 })]);
});

async function addJob(title: string, status: "active" | "closed" = "active"): Promise<number> {
  const [job] = await writer.db.insert(schema.jobs).values({
    companyId, title, titleNorm: title.toLowerCase(), status, firstSeenAt: now, lastSeenAt: now,
  }).returning({ id: schema.jobs.id });
  return job!.id;
}

async function addSources(ids: readonly number[]): Promise<number> {
  const channelId = "fixture";
  await writer.db.insert(schema.channels).values({ id: channelId, family: "ats", kind: "ats" });
  const [raw] = await writer.db.insert(schema.rawPostings).values({ channelId, externalId: "posting", payloadJson: {} }).returning();
  await writer.db.insert(schema.jobSources).values(ids.map((jobId) => ({
    jobId, channelId, rawPostingId: raw!.id, url: "https://jobs.example.invalid/role", applyUrl: "https://jobs.example.invalid/apply",
  })));
  return raw!.id;
}

async function connect(permissions: Permission[] = ["tracking:read"]): Promise<Client> {
  const settings = mcpSchema.parse({
    enabled: true, permissions, stdio: { permissions }, sync: { max_batch: 10 }, limits: { max_results: 3 },
  });
  const ctx = defaultContext(reader.db, settings, { readSettings: () => settings, text, log: () => {} });
  ctx.now = () => now;
  ctx.traps = trapSettings;
  const server = buildServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tracking-sync-test", version: "1.0.0" });
  await client.connect(clientSide);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

async function readTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent;
}

async function sync(client: Client, args: { cursor?: string | null; limit?: number; blocks?: string[] } = {}) {
  return listApplicationChangesOutput.parse(await readTool(client, "list_application_changes", args));
}

function keys(items: { job_id: number; kind: string }[]) {
  return items.map(({ job_id, kind }) => [job_id, kind]);
}

async function stampChanges(tx: Executor, at: Date): Promise<void> {
  await tx.update(schema.agentChanges).set({ at }).where(sql`${schema.agentChanges.tx} = pg_current_xact_id()`);
}

describe("incremental application and favorite sync", () => {
  it("hides notes-only changes and their timestamps and hold counts outside the selected notes blocks", async () => {
    const jobId = await addJob("Tracked role");
    await setApplicationStatus(writer.db, jobId, "applied");
    await addFavorite(writer.db, jobId);
    const plain = await connect();
    const withNotes = await connect(["tracking:read", "notes:read"]);
    const baseBlocks = ["app", "fav"];
    const notesBlocks = ["app.notes", "fav.notes"];
    const base = await sync(plain);
    const baseWithGrant = await sync(withNotes, { blocks: baseBlocks });
    const notes = await sync(withNotes, { blocks: notesBlocks });
    const visibleAt = new Date("2026-03-13T12:01:00Z");
    const notesAt = new Date("2026-03-13T12:02:00Z");
    await second.db.transaction(async (tx) => {
      await tx.update(schema.applications).set({ nextAction: "Follow up" }).where(eq(schema.applications.jobId, jobId));
      await stampChanges(tx, visibleAt);
    });

    const paused = await writer.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_current_xact_id()`);
      await second.db.transaction(async (later) => {
        await later.update(schema.applications).set({ notesMd: "Application note sentinel" }).where(eq(schema.applications.jobId, jobId));
        await setFavoriteNote(later, jobId, "Favorite note sentinel");
        await stampChanges(later, notesAt);
      });
      const plainPage = await sync(plain, { cursor: base.next_cursor });
      const basePage = await sync(withNotes, { cursor: baseWithGrant.next_cursor, blocks: baseBlocks });
      for (const page of [plainPage, basePage]) {
        expect(page).toMatchObject({ has_more: false, held_back: 0, items: [{
          kind: "application", job_id: jobId, changed_at: visibleAt.toISOString(),
          application: { tracking: { application: { next_action: "Follow up" } } },
        }] });
        expect(JSON.stringify(page)).not.toContain("sentinel");
        expect(page.items[0]).not.toHaveProperty("application.notes");
      }
      const notesPage = await sync(withNotes, { cursor: notes.next_cursor, blocks: notesBlocks });
      expect(notesPage).toMatchObject({ has_more: false, held_back: 2, items: [] });
      return { plainPage, basePage, notesPage };
    });

    expect(await sync(plain, { cursor: paused.plainPage.next_cursor })).toMatchObject({ has_more: false, held_back: 0, items: [] });
    expect(await sync(withNotes, { cursor: paused.basePage.next_cursor, blocks: baseBlocks })).toMatchObject({ has_more: false, held_back: 0, items: [] });
    const released = await sync(withNotes, { cursor: paused.notesPage.next_cursor, blocks: notesBlocks });
    expect(released).toMatchObject({ has_more: false, held_back: 0, items: [
      { kind: "application", job_id: jobId, changed_at: notesAt.toISOString(), application: { notes: { application_notes: "Application note sentinel" } } },
      { kind: "favorite", job_id: jobId, changed_at: notesAt.toISOString(), favorite: { notes: { favorite_note: "Favorite note sentinel" } } },
    ] });
  });

  it("returns removals for a reverted application, an unfavorite and a deleted job", async () => {
    const applied = await addJob("Application to revert");
    const starred = await addJob("Favorite to remove");
    const deleted = await addJob("Job to delete");
    const reverted = await setApplicationStatus(writer.db, applied, "applied");
    const cascaded = await setApplicationStatus(writer.db, deleted, "applied");
    await addFavorite(writer.db, starred);
    await addFavorite(writer.db, deleted);
    const client = await connect();
    const start = await sync(client);

    expect(await revertApplicationStatus(writer.db, applied, { movedTo: "applied", restoreTo: "new" })).toMatchObject({ status: null, reverted: true });
    expect(await removeFavorite(writer.db, starred)).not.toBeNull();
    await writer.db.transaction(async (tx) => {
      expect(await revertApplicationStatus(tx, deleted, { movedTo: "applied", restoreTo: "new" })).toMatchObject({ status: null, reverted: true });
      await tx.delete(schema.jobs).where(eq(schema.jobs.id, deleted));
    });
    expect(await writer.db.select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, reverted.applicationId))).toEqual([]);
    expect(await writer.db.select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, cascaded.applicationId))).toEqual([]);
    expect(await writer.db.select().from(schema.jobFavorites).where(eq(schema.jobFavorites.jobId, deleted))).toEqual([]);

    const page = await sync(client, { cursor: start.next_cursor });
    expect(page.items).toEqual([
      { kind: "application", job_id: applied, removed: true, application: null, changed_at: expect.any(String) },
      { kind: "favorite", job_id: starred, removed: true, favorite: null, changed_at: expect.any(String) },
      { kind: "application", job_id: deleted, removed: true, application: null, changed_at: expect.any(String) },
      { kind: "favorite", job_id: deleted, removed: true, favorite: null, changed_at: expect.any(String) },
    ]);
    expect(page.has_more).toBe(false);
  });

  it("resumes a company rename between an application's and favorite's one-item pages", async () => {
    const both = await addJob("Application and favorite");
    const applied = await addJob("Application only");
    await addJob("Untracked");
    const starred = await addJob("Archived favorite", "closed");
    await setApplicationStatus(writer.db, both, "applied");
    await setApplicationStatus(writer.db, applied, "interested");
    await addFavorite(writer.db, both);
    await addFavorite(writer.db, starred);
    const client = await connect();
    const start = await sync(client);
    await writer.db.update(schema.companies).set({ name: "Renamed Systems" }).where(eq(schema.companies.id, companyId));

    const expected = [[both, "application"], [both, "favorite"], [applied, "application"], [starred, "favorite"]];
    const changed = new Set<string | null>();
    let cursor = start.next_cursor;
    for (const [index, key] of expected.entries()) {
      const page = await sync(client, { cursor, limit: 1 });
      expect(keys(page.items)).toEqual([key]);
      const item = page.items[0]!;
      expect(item.kind === "application" ? item.application?.company : item.favorite?.job.company).toBe("Renamed Systems");
      expect(page.has_more).toBe(index < expected.length - 1);
      changed.add(item.changed_at);
      cursor = page.next_cursor;
    }
    expect([...changed]).toEqual([expect.any(String)]);
    expect((await sync(client, { cursor })).items).toEqual([]);
  });

  it("expands shared rows only to current members of the masked tracking kind", async () => {
    const linked = await addJob("Linked application and favorite");
    const unlinked = await addJob("Unlinked favorite");
    const untracked = await addJob("Linked untracked job");
    const rawId = await addSources([linked, untracked]);
    await setApplicationStatus(writer.db, linked, "interested");
    await addFavorite(writer.db, linked);
    await addFavorite(writer.db, unlinked);
    const client = await connect();
    const start = await sync(client);
    await writer.db.insert(schema.agentChanges).values([
      { keyKind: "raw_posting", key: String(rawId), blocks: (1 << SYNC_BLOCKS.job.bit) | (1 << SYNC_BLOCKS.fav.bit) },
      { keyKind: "benchmark", key: "*", blocks: (1 << SYNC_BLOCKS.salary.bit) | (1 << SYNC_BLOCKS.app.bit) },
    ]);
    const page = await sync(client, { cursor: start.next_cursor });
    expect(keys(page.items)).toEqual([[linked, "favorite"], [linked, "application"]]);
    expect(page.has_more).toBe(false);
  });

  it("pages the snapshot by entity key and follows changes written during the snapshot", async () => {
    const earlier = await addJob("A job to star later");
    const both = await addJob("Application and favorite");
    const starred = await addJob("Favorite only");
    await setApplicationStatus(writer.db, both, "interested");
    await addFavorite(writer.db, both);
    await addFavorite(writer.db, starred);
    const client = await connect();

    const first = await sync(client, { limit: 1 });
    expect(keys(first.items)).toEqual([[both, "application"]]);
    expect(first).toMatchObject({ phase: "snapshot", snapshot_complete: false, has_more: true, held_back: null, items: [{ changed_at: null }] });
    await addFavorite(writer.db, earlier);
    await setApplicationStatus(writer.db, both, "applied");
    const middle = await sync(client, { cursor: first.next_cursor, limit: 1 });
    expect(keys(middle.items)).toEqual([[both, "favorite"]]);
    expect(middle).toMatchObject({ phase: "snapshot", snapshot_complete: false, has_more: true, generation: first.generation });
    const last = await sync(client, { cursor: middle.next_cursor, limit: 1 });
    expect(keys(last.items)).toEqual([[starred, "favorite"]]);
    expect(last).toMatchObject({ phase: "snapshot", snapshot_complete: true, has_more: false, generation: first.generation });

    const changes = await sync(client, { cursor: last.next_cursor });
    expect(keys(changes.items)).toEqual([[earlier, "favorite"], [both, "application"]]);
    expect(changes).toMatchObject({ phase: "changes", snapshot_complete: false, has_more: false, held_back: 0, generation: first.generation });
    expect(changes.items[1]).toMatchObject({ removed: false, application: { tracking: { application: { status: "applied" } } } });
  });

  it("rejects a cursor from either tool when calling the other tool", async () => {
    const client = await connect(["jobs:read", "tracking:read"]);
    const jobs = listJobChangesOutput.parse(await readTool(client, "list_job_changes"));
    const tracked = await sync(client);
    for (const [name, cursor] of [["list_job_changes", tracked.next_cursor], ["list_application_changes", jobs.next_cursor]] as const) {
      const result = await client.callTool({ name, arguments: { cursor } });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: text("sync.errors.scopeChanged") }] });
      expect(result.structuredContent).toBeUndefined();
    }
  });

  it.each([false, true])("matches the regular tracking readers field by field with notes=%s", async (notes) => {
    const jobId = await addJob("Role with tracking data");
    await addSources([jobId]);
    await setApplicationStatus(writer.db, jobId, "applied", "First event note", { occurredAt: now, reference: "Receipt example" });
    await setApplicationStatus(writer.db, jobId, "interviewing", "Second event note");
    await writer.db.update(schema.applications).set({ notesMd: "Private application note", nextAction: "Reply to invitation", interviewRounds: 2 }).where(eq(schema.applications.jobId, jobId));
    await addFavorite(writer.db, jobId, { note: "Private favorite note", createdAt: now });
    await markSeen(writer.db, jobId, "detail", now);
    await setFilterOverride(writer.db, jobId, "keep");
    const client = await connect(notes ? ["tracking:read", "notes:read"] : ["tracking:read"]);
    const first = await sync(client, { limit: 1 });
    const last = await sync(client, { cursor: first.next_cursor, limit: 1 });
    const { notices, ...application } = getApplicationOutput.parse(await readTool(client, "get_application", { job_id: jobId }));
    const favorites = listFavoritesOutput.parse(await readTool(client, "list_favorites"));

    expect(first.items[0]).toMatchObject({ kind: "application", job_id: jobId, removed: false });
    expect(first.items[0]?.kind === "application" && first.items[0].application).toEqual(application);
    expect(first.notices).toEqual(notices);
    expect(application.tracking.application).toMatchObject({ applied_at: now.toISOString(), history: expect.arrayContaining([
      expect.objectContaining({ occurred_at: now.toISOString(), reference: "Receipt example" }),
    ]) });
    expect(JSON.stringify(first.items[0])).not.toContain("days_in_status");
    expect(last.items[0]).toMatchObject({ kind: "favorite", job_id: jobId, removed: false });
    expect(last.items[0]?.kind === "favorite" && last.items[0].favorite).toEqual(favorites.favorites[0]);
    expect(last.notices).toEqual(favorites.notices);
    expect(favorites.favorites[0]?.job.links).toEqual([{ source: "ats", url: "https://jobs.example.invalid/role", apply_url: "https://jobs.example.invalid/apply" }]);
    expect(JSON.stringify([first.items, last.items]).includes("Private application note")).toBe(notes);
    expect(JSON.stringify([first.items, last.items]).includes("Private favorite note")).toBe(notes);
  });

  it.each([
    { permissions: ["jobs:read"], expected: ["list_job_changes"] },
    { permissions: ["tracking:read"], expected: ["list_application_changes"] },
    { permissions: ["notes:read"], expected: [] },
    { permissions: ["jobs:read", "tracking:read", "notes:read", "match:read"], expected: ["list_job_changes", "list_application_changes"] },
  ] satisfies { permissions: Permission[]; expected: string[] }[])("lists sync tools for $permissions", async ({ permissions, expected }) => {
    const client = await connect(permissions);
    const { tools } = await client.listTools();
    const syncTools = tools.filter(({ name }) => name === "list_job_changes" || name === "list_application_changes");
    expect(syncTools.map(({ name }) => name)).toEqual(expected);
    const applicationTool = syncTools.find(({ name }) => name === "list_application_changes");
    if (applicationTool) expect(JSON.stringify(applicationTool.outputSchema).includes("favorite_note")).toBe(permissions.includes("notes:read"));
  });
});
