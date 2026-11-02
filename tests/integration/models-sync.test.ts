/**
 * The model list refresh end to end: the web side queues a `models_sync` request, the ai-worker (never the runner) claims it, the
 * handler reads the public list (fixture), the result is what the page polls, and "add to my list" writes the user's overlay that
 * the catalog then sees. Nothing here talks to a provider.
 */
import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { aiWorkerRequestKinds, processNextControlRequest, registerControlHandler, resetControlHandlers, runnerRequestKinds } from "@/lib/control";
import { addSyncedModels } from "@/lib/control/models-sync-add";
import { createModelsSyncHandler } from "@/lib/control/models-sync";
import { loadControlRequestView } from "@/lib/control/request-view";
import { requestModelsSync } from "@/lib/control/service";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { closeDb, getControlRequest, getDb, insertControlRequest, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const fixture = fs.readFileSync(path.join(import.meta.dirname, "../fixtures/ai/openrouter-models.json"), "utf8");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table control_requests restart identity cascade`);
});

afterEach(() => {
  temp.cleanup();
  resetControlHandlers();
});

afterAll(async () => {
  await closeDb();
});

const userFile = () => path.join(temp.configDir, "models.yaml");
const aiWorker = () => ({ db: getDb(), signal: new AbortController().signal, logger: quietLogger, kinds: () => aiWorkerRequestKinds("host") });

describe("web side", () => {
  it("accepts a provider id and a filter word only, reuses an open request, refuses a repeat inside the interval", async () => {
    expect(await requestModelsSync({ provider: "openai" })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestModelsSync({ provider: "openrouter", url: "https://example.test/models" })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestModelsSync({ provider: "openrouter", path: "/etc/passwd" })).toMatchObject({ status: "error", error: "invalidPayload" });

    const first = await requestModelsSync({ provider: "openrouter" });
    expect(first).toMatchObject({ status: "queued", kind: "models_sync", existing: false });
    expect(await requestModelsSync({ provider: "openrouter" })).toMatchObject({ status: "queued", existing: true });
    expect(await requestModelsSync({ provider: "openrouter", filter: "claude" })).toMatchObject({ status: "queued", existing: false });

    if (first.status !== "queued") throw new Error("not queued");
    await getDb().update(schema.controlRequests).set({ status: "done", finishedAt: sql`now()` }).where(sql`id = ${first.request}`);
    expect(await requestModelsSync({ provider: "openrouter" })).toMatchObject({ status: "error", error: "tooSoon" });
  });
});

describe("who claims it", () => {
  it("the ai-worker claims it under either execution setting, the runner never does", async () => {
    const db = getDb();
    await insertControlRequest(db, { kind: "models_sync", payload: { provider: "openrouter" } });
    for (const execution of ["host", "container"] as const) {
      expect(aiWorkerRequestKinds(execution)).toContain("models_sync");
      expect(runnerRequestKinds(execution)).not.toContain("models_sync");
    }
    const seen: string[] = [];
    registerControlHandler("models_sync", async (request) => {
      seen.push(request.kind);
      return { status: "done", result: {} };
    });
    const runner = { db, signal: new AbortController().signal, logger: quietLogger, kinds: () => runnerRequestKinds("host") };
    expect(await processNextControlRequest(runner)).toBeNull();
    expect(seen).toEqual([]);
    expect((await processNextControlRequest(aiWorker()))?.kind).toBe("models_sync");
    expect(seen).toEqual(["models_sync"]);
  });
});

describe("refresh, view and add", () => {
  const register = (body: string, status = 200) =>
    registerControlHandler("models_sync", createModelsSyncHandler({ list: { fetch: async () => new Response(body, { status }) }, now: () => new Date("2026-11-01T12:00:00Z") }));

  it("the page's view carries the rows, and adding writes the overlay the catalog sees", async () => {
    register(fixture);
    const queued = await requestModelsSync({ provider: "openrouter", filter: "haiku" });
    if (queued.status !== "queued") throw new Error("not queued");
    expect(await processNextControlRequest(aiWorker())).toMatchObject({ id: queued.request, status: "done" });

    const view = await loadControlRequestView(getDb(), queued.request);
    expect(view).toMatchObject({ kind: "models_sync", status: "done" });
    const row = view?.result.sync?.rows.find((r) => r.id === "anthropic/claude-haiku-5.5");
    expect(row).toMatchObject({ inCatalog: false, addable: true });

    expect(fs.existsSync(userFile())).toBe(false);
    // ids that are not rows of the stored result, or already in the catalog, are refused; the page cannot choose a price
    expect(await addSyncedModels({ requestId: queued.request, ids: ["vendor/not-listed"] })).toMatchObject({ status: "error", error: "notAddable" });
    expect(await addSyncedModels({ requestId: queued.request, ids: ["anthropic/claude-haiku-5.5"], price: { input_per_mtok: 0 } })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await addSyncedModels({ requestId: 999_999, ids: ["anthropic/claude-haiku-5.5"] })).toMatchObject({ status: "error", error: "requestUnavailable" });
    expect(fs.existsSync(userFile())).toBe(false);

    expect(await addSyncedModels({ requestId: queued.request, ids: ["anthropic/claude-haiku-5.5"] }, getDb(), "2026-11-01")).toMatchObject({ status: "added", added: ["anthropic/claude-haiku-5.5"] });
    resetConfigCache();
    const added = loadConfig("models").providers.openrouter.models.find((m) => m.id === "anthropic/claude-haiku-5.5");
    expect(added?.price?.input_per_mtok).toBeGreaterThan(0);
    expect(added?.notes).toContain("2026-11-01");
    // the shipped model stays, the file holds only the addition
    expect(loadConfig("models").providers.openrouter.models.some((m) => m.id === "deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(fs.readFileSync(userFile(), "utf8")).not.toContain("deepseek/deepseek-v4.1-flash");
  });

  it("a failed refresh stores only the kind of failure", async () => {
    register("secret reply body sk-or-abc", 500);
    const row = await insertControlRequest(getDb(), { kind: "models_sync", payload: { provider: "openrouter" } });
    expect(await processNextControlRequest(aiWorker())).toMatchObject({ id: row.id, status: "failed" });
    const stored = await getControlRequest(getDb(), row.id);
    expect(stored?.result).toEqual({ error: "models_sync_failed", provider: "openrouter", errorKind: "provider_error" });
    expect(JSON.stringify(stored)).not.toContain("sk-or");
  });
});

describe("migration", () => {
  it("the control request kind enum has models_sync", async () => {
    const rows = await getDb().execute<{ label: string }>(sql`select unnest(enum_range(null::control_request_kind))::text as label`);
    expect(rows.map((r) => r.label)).toContain("models_sync");
  });
});
