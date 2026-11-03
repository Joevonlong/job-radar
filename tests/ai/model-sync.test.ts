// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AiProviderError } from "@/lib/ai/errors";
import { buildSyncResult, catalogEntryFor, compareWithCatalog, displayLabel, listedFrom, listProviderModels, type ListedModel } from "@/lib/ai/model-sync";
import { listOpenRouterModels } from "@/lib/ai/model-sync/openrouter";
import { loadConfig } from "@/lib/config";
import type { ModelsConfig } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../fixtures/ai/openrouter-models.json"), "utf8")) as { data: unknown[] };

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

const reply = (body: unknown, init: ResponseInit = {}): typeof fetch => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
const base = { baseUrl: "https://openrouter.ai/api/v1", maxTokensField: "max_tokens" as const, timeoutMs: 5000, maxResponseBytes: 4_194_304, maxNameChars: 120 };
const listed = (): ListedModel[] => fixture.data.flatMap((raw) => listedFrom(raw, "max_tokens") ?? []);
const byId = (id: string): ListedModel => {
  const found = listed().find((m) => m.id === id);
  if (!found) throw new Error(`fixture lacks ${id}`);
  return found;
};

describe("the model list of OpenRouter", () => {
  it("reads the public list without a key, from the configured base_url, and refuses redirects", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const models = await listOpenRouterModels({ ...base, fetch: async (url, init) => ((seen = { url: String(url), init }), new Response(JSON.stringify(fixture))) });
    expect(models.length).toBe(fixture.data.length);
    expect(seen).toMatchObject({ url: "https://openrouter.ai/api/v1/models", init: { method: "GET", redirect: "error" } });
    expect(JSON.stringify(seen!.init?.headers ?? {}).toLowerCase()).not.toContain("authorization");
  });

  it("converts the per-token price to USD per million tokens without float noise", () => {
    expect(byId("deepseek/deepseek-v4.1-flash").price).toEqual({ input_per_mtok: 0.045, output_per_mtok: 0.5, cached_input_per_mtok: 0.006 });
    expect(byId("google/gemini-3.8-flash").price).toMatchObject({ input_per_mtok: 0.825, output_per_mtok: 4.125 });
    expect(byId("anthropic/claude-haiku-5.5").price).toMatchObject({ input_per_mtok: 0.1, output_per_mtok: 0.5, cached_input_per_mtok: 0.01, cache_write_per_mtok: 0.125 });
  });

  it("tells chat models from image models, JSON support from none, usable prices from a router's -1, and a retirement date", () => {
    expect(byId("deepseek/deepseek-v4.1-flash")).toMatchObject({ textChat: true, json: "yes", contextLength: 1048576, expiresOn: null });
    expect(byId("google/gemini-nano-banana-2.1").textChat).toBe(false);
    expect(byId("moondream/moondream3-preview").json).toBe("no");
    expect(byId("typesafe/jev-router").price).toBeNull();
    expect(byId("dots-studio/dots-3-note-preview:free")).toMatchObject({ price: { input_per_mtok: 0, output_per_mtok: 0 }, expiresOn: "2026-12-31" });
  });

  it("a model whose parameters are not stated is unverified; an OpenAI model must take the configured length field", () => {
    expect(listedFrom({ id: "v/none", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" } }, "max_tokens")?.json).toBe("unverified");
    const openai = { id: "openai/x", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["response_format", "max_completion_tokens"] };
    expect(listedFrom(openai, "max_tokens")?.json).toBe("unverified");
    expect(listedFrom(openai, "max_completion_tokens")?.json).toBe("yes");
    expect(listedFrom({ ...openai, id: "other/x" }, "max_tokens")?.json).toBe("yes");
  });

  it("refuses a reply over the size limit, declared or streamed, and cuts a long name", async () => {
    const big = JSON.stringify({ data: [{ id: "v/a", name: "x".repeat(5000) }] });
    await expect(listOpenRouterModels({ ...base, maxResponseBytes: 1000, fetch: reply(big) })).rejects.toMatchObject({ kind: "provider_error", message: expect.stringContaining("too large") });
    await expect(listOpenRouterModels({ ...base, maxResponseBytes: 1000, fetch: reply("{}", { headers: { "content-length": "99999" } }) })).rejects.toMatchObject({ kind: "provider_error" });
    const [model] = await listOpenRouterModels({ ...base, maxNameChars: 40, fetch: reply(big) });
    expect(model?.name).toHaveLength(40);
  });

  it("skips entries that do not fit and duplicate ids, and fails on a body that is not a list", async () => {
    const models = await listOpenRouterModels({ ...base, fetch: reply({ data: [fixture.data[0], 5, { nope: true }, fixture.data[0]] }) });
    expect(models).toHaveLength(1);
    await expect(listOpenRouterModels({ ...base, fetch: reply({ models: [] }) })).rejects.toMatchObject({ kind: "provider_error" });
    await expect(listOpenRouterModels({ ...base, fetch: reply("not json") })).rejects.toMatchObject({ kind: "provider_error" });
    await expect(listOpenRouterModels({ ...base, fetch: reply({ data: [] }) })).rejects.toMatchObject({ kind: "provider_error" });
  });

  it("errors name the kind of failure and never the reply body", async () => {
    const secret = "sk-or-leak-this-1234567890";
    const status = await listOpenRouterModels({ ...base, fetch: reply(`{"error":"${secret}"}`, { status: 500 }) }).catch((e: unknown) => e);
    expect(status).toBeInstanceOf(AiProviderError);
    expect((status as AiProviderError).message).not.toContain(secret);
    await expect(listOpenRouterModels({ ...base, fetch: reply("{}", { status: 429 }) })).rejects.toMatchObject({ kind: "rate_limited" });
    const network = await listOpenRouterModels({ ...base, fetch: async () => { throw new TypeError(`fetch failed ${secret}`); } }).catch((e: unknown) => e);
    expect((network as AiProviderError).kind).toBe("network");
    expect((network as AiProviderError).message).not.toContain(secret);
  });

  it("only goes to the provider's own host unless custom endpoints are allowed", async () => {
    const refused = await listOpenRouterModels({ ...base, baseUrl: "https://example.test/api/v1", env: {}, fetch: reply(fixture) }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: "not_configured" });
    await expect(listOpenRouterModels({ ...base, baseUrl: "https://example.test/api/v1", env: { JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" }, fetch: reply(fixture) })).resolves.toHaveLength(fixture.data.length);
  });

  it("takes the base_url and the length field from ai.yaml", async () => {
    let url = "";
    const ai = loadConfig("ai");
    await listProviderModels("openrouter", ai, { fetch: async (u) => ((url = String(u)), new Response(JSON.stringify(fixture))) });
    expect(url).toBe(`${ai.providers.openrouter.base_url.replace(/\/+$/, "")}/models`);
  });
});

describe("the list next to the catalog", () => {
  const catalog = (): ModelsConfig => structuredClone(loadConfig("models")) as ModelsConfig;
  const NOW = new Date("2026-11-01T12:00:00Z");

  it("marks models already in the catalog, a changed price, and what can be added", () => {
    const cat = catalog();
    const flash = cat.providers.openrouter.models.find((m) => m.id === "deepseek/deepseek-v4.1-flash")!;
    flash.price = { input_per_mtok: 0.14, output_per_mtok: 0.42 };
    const result = buildSyncResult("openrouter", listed(), cat, { now: NOW });
    const row = (id: string) => result.rows.find((r) => r.id === id)!;
    expect(row("deepseek/deepseek-v4.1-flash")).toMatchObject({ inCatalog: true, priceWas: { input_per_mtok: 0.14, output_per_mtok: 0.42 }, addable: true });
    expect(row("anthropic/claude-haiku-5.5")).toMatchObject({ inCatalog: false, priceWas: null, addable: true, addableUnverified: false });
    expect(row("google/gemini-nano-banana-2.1")).toMatchObject({ addable: false, addableUnverified: false });
    expect(row("moondream/moondream3-preview")).toMatchObject({ addable: false });
    expect(row("typesafe/jev-router")).toMatchObject({ addable: false });
    expect(result.listed).toBe(fixture.data.length);
  });

  it("an unchanged price is not a difference, and the cache price counts only when both sides have it", () => {
    const cat = catalog();
    cat.providers.openrouter.models[0]!.price = { input_per_mtok: 0.045, output_per_mtok: 0.5 };
    expect(compareWithCatalog(byId("deepseek/deepseek-v4.1-flash"), cat, "openrouter", "2026-11-01").priceWas).toBeNull();
    cat.providers.openrouter.models[0]!.price = { input_per_mtok: 0.045, output_per_mtok: 0.5, cached_input_per_mtok: 0.007 };
    expect(compareWithCatalog(byId("deepseek/deepseek-v4.1-flash"), cat, "openrouter", "2026-11-01").priceWas).not.toBeNull();
  });

  it("a model that retires today or earlier cannot be added; one that retires later can, and says when", () => {
    const soon = byId("dots-studio/dots-3-note-preview:free");
    expect(compareWithCatalog(soon, catalog(), "openrouter", "2026-12-30")).toMatchObject({ addable: true, expiresOn: "2026-12-31" });
    expect(compareWithCatalog(soon, catalog(), "openrouter", "2026-12-31").addable).toBe(false);
  });

  it("an unverified model is listed and only addable by asking", () => {
    const unverified: ListedModel = { id: "v/u", name: "U", textChat: true, price: { input_per_mtok: 1, output_per_mtok: 1 }, contextLength: 1000, json: "unverified", expiresOn: null };
    expect(compareWithCatalog(unverified, catalog(), "openrouter", "2026-11-01")).toMatchObject({ addable: false, addableUnverified: true });
  });

  it("flags catalog models the service no longer lists, never removes them, and ignores the filter for it", () => {
    const cat = catalog();
    cat.providers.openrouter.models.push({ id: "old/gone", price: { input_per_mtok: 1, output_per_mtok: 1 } }, { id: "old/retired", deprecated: true, price: { input_per_mtok: 1, output_per_mtok: 1 } });
    const result = buildSyncResult("openrouter", listed(), cat, { filter: "haiku", now: NOW });
    expect(result.gone).toEqual(["old/gone"]);
    expect(result.rows.map((r) => r.id)).toEqual(["anthropic/claude-haiku-5.5"]);
    expect(result.matched).toBe(1);
  });

  it("sorts what can be added first and caps the rows it returns", () => {
    const result = buildSyncResult("openrouter", listed(), catalog(), { now: NOW, maxRows: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.rows.every((r) => r.addable)).toBe(true);
  });

  it("builds the entry written to the user's file: label without the vendor prefix, price, the sync date; a price update keeps the earlier notes", () => {
    const row = buildSyncResult("openrouter", listed(), catalog(), { now: NOW }).rows.find((r) => r.id === "anthropic/claude-haiku-5.5")!;
    expect(displayLabel("Anthropic: Claude Haiku 5.5")).toBe("Claude Haiku 5.5");
    expect(catalogEntryFor(row, null, "2026-11-01")).toEqual({ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", price: row.price, notes: "synced 2026-11-01" });
    expect(catalogEntryFor(row, null, "2026-11-01", true).notes).toBe("synced 2026-11-01; JSON mode unverified");
    const existing = { id: row.id, label: "Mine", notes: "up to 100K tier; synced 2026-10-01", price: { input_per_mtok: 9, output_per_mtok: 9 }, aliases: ["a"] };
    expect(catalogEntryFor(row, existing, "2026-11-01")).toEqual({ ...existing, price: row.price, notes: "up to 100K tier; synced 2026-11-01" });
    expect(() => catalogEntryFor({ ...row, price: null }, null, "2026-11-01")).toThrow();
  });
});
