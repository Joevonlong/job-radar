// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelsSyncHandler } from "@/lib/control/models-sync";
import { modelsSyncPayloadSchema, type ControlHandlerContext } from "@/lib/control/types";
import { requestResultViewSchema } from "@/lib/control/request-view-schema";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { ControlRequest } from "@/lib/db/repos/control-requests";

import { quietLogger } from "../cycle/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";

const fixture = fs.readFileSync(path.join(import.meta.dirname, "../fixtures/ai/openrouter-models.json"), "utf8");

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

const context = (signal = new AbortController().signal): ControlHandlerContext => ({ db: {} as Db, signal, logger: quietLogger });
const request = (payload: unknown): ControlRequest => ({ id: 1, kind: "models_sync", payload, status: "running", result: null, requestedAt: new Date(), startedAt: new Date(), finishedAt: null });
const fetchOf = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });

describe("the models_sync payload", () => {
  it("accepts a provider id and a filter word, nothing else: no address, no path", () => {
    expect(modelsSyncPayloadSchema.safeParse({ provider: "openrouter" }).success).toBe(true);
    expect(modelsSyncPayloadSchema.safeParse({ provider: "openrouter", filter: " claude " }).data).toEqual({ provider: "openrouter", filter: "claude" });
    for (const bad of [{}, { provider: "openai" }, { provider: "nebius" }, { provider: "openrouter", url: "https://example.test" }, { provider: "openrouter", path: "/etc/passwd" }, { provider: "openrouter", filter: "" }, { provider: "openrouter", filter: "x".repeat(81) }, { provider: "https://example.test" }]) {
      expect(modelsSyncPayloadSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("models_sync handler", () => {
  const handler = (fetchImpl: typeof fetch) => createModelsSyncHandler({ list: { fetch: fetchImpl }, now: () => new Date("2026-11-01T12:00:00Z") });

  it("returns the rows next to the effective catalog as a result the page can read", async () => {
    const outcome = await handler(fetchOf(fixture))(request({ provider: "openrouter", filter: "haiku" }), context());
    expect(outcome.status).toBe("done");
    const view = requestResultViewSchema.parse(outcome.result);
    expect(view.sync).toMatchObject({ provider: "openrouter", matched: 1, fetchedAt: "2026-11-01T12:00:00.000Z" });
    expect(view.sync?.rows[0]).toMatchObject({ id: "anthropic/claude-haiku-5.5", inCatalog: false, addable: true });
    // the catalog's own model is in the fixture too: it is flagged as present
    const flash = await handler(fetchOf(fixture))(request({ provider: "openrouter", filter: "deepseek" }), context());
    expect(requestResultViewSchema.parse(flash.result).sync?.rows[0]).toMatchObject({ id: "deepseek/deepseek-v4.1-flash", inCatalog: true });
  });

  it("fails with a code and the kind of failure, never the provider's reply", async () => {
    const secret = "sk-or-leak-this-1234567890";
    const outcome = await handler(fetchOf(`{"error":"${secret}"}`, 500))(request({ provider: "openrouter" }), context());
    expect(outcome).toEqual({ status: "failed", result: { error: "models_sync_failed", provider: "openrouter", errorKind: "provider_error" } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    const network = await handler(async () => { throw new TypeError("fetch failed"); })(request({ provider: "openrouter" }), context());
    expect(network.result).toMatchObject({ errorKind: "network" });
  });

  it("refuses a payload that is not exactly a provider and a filter, before anything is fetched", async () => {
    let calls = 0;
    const counting: typeof fetch = async () => ((calls += 1), new Response(fixture));
    for (const payload of [{ provider: "openrouter", url: "https://example.test/models" }, { provider: "somewhere" }, null, "openrouter"]) {
      expect(await handler(counting)(request(payload), context())).toEqual({ status: "failed", result: { error: "invalid_payload" } });
    }
    expect(calls).toBe(0);
  });

  it("does not send to a host other than the provider's: a changed base_url fails without the opt-in", async () => {
    const ai = structuredClone(loadConfig("ai")) as ReturnType<typeof loadConfig<"ai">>;
    (ai.providers.openrouter as { base_url: string }).base_url = "https://example.test/api/v1";
    let calls = 0;
    const outcome = await createModelsSyncHandler({ config: ai, list: { env: {}, fetch: async () => ((calls += 1), new Response(fixture)) } })(request({ provider: "openrouter" }), context());
    expect(outcome.result).toMatchObject({ error: "models_sync_failed", errorKind: "not_configured" });
    expect(calls).toBe(0);
  });

  it("rethrows when the process is shutting down, so the request is not recorded as a provider failure", async () => {
    const controller = new AbortController();
    const aborting: typeof fetch = async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    await expect(handler(aborting)(request({ provider: "openrouter" }), context(controller.signal))).rejects.toBeDefined();
  });
});
