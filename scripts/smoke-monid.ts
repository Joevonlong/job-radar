/**
 * One tiny paid LinkedIn query, at most 10 results, with in-memory accounting only.
 * pnpm smoke:monid [--limit 10] [--group <keyword group>] [--location <city>] [--window-hours 24]
 * pnpm smoke:monid --discover   (discover + inspect only; no billable run)
 * The package command loads .env. MONID_API_KEY is never printed and requests never follow redirects.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import { BudgetTracker, monthKey } from "../src/lib/channels/budget";
import { createChannelContext, httpSettingsFromConfig } from "../src/lib/channels/context";
import { createHttpClient, readTextUpTo, type FetchLike } from "../src/lib/channels/http";
import { buildActorInputs } from "../src/lib/channels/linkedin/apify/contract";
import { acceptedRunSchema, createMonidChannel, MAX_RESPONSE_CHARS, MONID_API_KEY_ENV, priceSchema, runResponseSchema, type MonidSettings } from "../src/lib/channels/linkedin/monid";
import { createLogger } from "../src/lib/channels/logger";
import { marketForChannel } from "../src/lib/channels/market";
import { queryId } from "../src/lib/channels/query";
import { settingsFromConfig } from "../src/lib/channels/registry";
import { createMemoryStateStore } from "../src/lib/channels/store";
import { normalizedPostingDraftSchema, type HttpClient, type SearchQuery } from "../src/lib/channels/types";
import { loadConfig } from "../src/lib/config";
import { checkCredentialEndpoint } from "../src/lib/credential-endpoints";

const HARD_LIMIT = 10;
// Discovery and inspection also list matrix/tiered prices, which have no scalar amount.
const priceTypeSchema = z.looseObject({ type: z.string().min(1) });
const endpointSchema = z.object({ provider: z.string().min(1), endpoint: z.string().startsWith("/"), price: priceTypeSchema });
const discoverySchema = z.union([z.array(z.unknown()), z.object({ results: z.array(z.unknown()) }), z.object({ endpoints: z.array(z.unknown()) })]);
const inspectionSchema = z.object({ price: priceTypeSchema, stoppable: z.boolean().optional() });
const diagnosticSchema = z.union([
  runResponseSchema.extend({ stoppable: z.boolean().optional() }),
  acceptedRunSchema.extend({ stoppable: z.boolean().optional() }),
]);
const salaryMetadataSchema = z.object({ salary: z.object({ providedByEmployer: z.boolean().optional(), compensationSource: z.unknown().optional() }).optional(), compensationSource: z.unknown().optional() });

const redact = (text: string): string => {
  const key = process.env[MONID_API_KEY_ENV]?.trim();
  return key ? text.replaceAll(key, "[redacted]") : text;
};
const print = (value: unknown): void => console.log(redact(JSON.stringify(value)));

interface MonidSmokeDiagnostics {
  http: HttpClient;
  settings: MonidSettings;
  headers: Record<string, string>;
  print: (value: unknown) => void;
  warn: (value: unknown) => void;
}

function priceDetails(price: z.infer<typeof priceTypeSchema>): Record<string, unknown> {
  const parsed = priceSchema.safeParse(price);
  return { priceType: price.type, ...(parsed.success && price.type === "PER_RESULT"
    ? { amount: parsed.data.amount, flatFee: parsed.data.flatFee ?? null } : {}) };
}

export async function inspectMonidEndpoint(options: MonidSmokeDiagnostics, provider: string, endpoint: string) {
  const { http, settings, headers, print, warn } = options;
  const result = await http.json(new URL("/v1/inspect", settings.api_base_url).toString(), inspectionSchema, {
    method: "POST", headers, body: JSON.stringify({ provider, endpoint }), redirect: "error", maxRetries: 0,
  });
  print({ provider, endpoint, price: result.price, ...priceDetails(result.price), stoppable: result.stoppable ?? null });
  if (provider === settings.provider && endpoint === settings.endpoint) {
    const parsed = priceSchema.safeParse(result.price);
    if (!parsed.success || parsed.data.type !== "PER_RESULT") {
      warn({ warning: "Monid inspected price is not a supported USD per-result price", provider, endpoint });
    } else {
      const inspected = { price_per_1k_usd: parsed.data.amount.value * 1000, flat_fee_usd: parsed.data.flatFee?.value ?? 0 };
      if (inspected.price_per_1k_usd !== settings.price_per_1k_usd || inspected.flat_fee_usd !== settings.flat_fee_usd) {
        warn({ warning: "Monid configured price differs from inspected price", provider, endpoint,
          configured: { price_per_1k_usd: settings.price_per_1k_usd, flat_fee_usd: settings.flat_fee_usd }, inspected });
      }
    }
  }
  return result;
}

export async function discoverMonidEndpoints(options: MonidSmokeDiagnostics): Promise<number> {
  const { http, settings, headers, print } = options;
  const discovery = await http.json(new URL("/v1/discover", settings.api_base_url).toString(), discoverySchema, {
    method: "POST", headers, body: JSON.stringify({ query: "linkedin jobs search", limit: HARD_LIMIT }), redirect: "error", maxRetries: 0,
  });
  const entries = Array.isArray(discovery) ? discovery : "results" in discovery ? discovery.results : discovery.endpoints;
  const jobs = entries.flatMap((entry) => {
    const parsed = endpointSchema.safeParse(entry);
    if (!parsed.success || !/linkedin/i.test(parsed.data.endpoint) || !/job/i.test(parsed.data.endpoint)) return [];
    if (parsed.data.price.type === "PER_RESULT" && !priceSchema.safeParse(parsed.data.price).success) return [];
    return [parsed.data];
  });
  for (const entry of jobs) {
    print({ provider: entry.provider, endpoint: entry.endpoint, price: entry.price, ...priceDetails(entry.price) });
    await inspectMonidEndpoint(options, entry.provider, entry.endpoint);
  }
  if (!jobs.some((entry) => entry.provider === settings.provider && entry.endpoint === settings.endpoint)) {
    await inspectMonidEndpoint(options, settings.provider, settings.endpoint);
  }
  print({ discoveredLinkedinJobEndpoints: jobs.length });
  return jobs.length;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    discover: { type: "boolean", default: false }, limit: { type: "string", default: String(HARD_LIMIT) },
    group: { type: "string" }, location: { type: "string" }, "window-hours": { type: "string", default: "24" },
  }, strict: true });
  const key = process.env[MONID_API_KEY_ENV]?.trim();
  if (!key) throw new Error("MONID_API_KEY is not set");
  const channels = loadConfig("channels");
  const block = channels.linkedin.monid;
  const verdict = checkCredentialEndpoint("monid", block.api_base_url);
  if (verdict.status === "refused") throw new Error(verdict.message);
  if (verdict.status === "custom") console.warn(redact(verdict.message));
  const signal = AbortSignal.timeout(block.timeout_ms + block.stop_grace_ms + channels.http.timeout_ms);
  const logger = createLogger({ minLevel: "info", sink: print });
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" };
  const http = createHttpClient({ settings: httpSettingsFromConfig(channels), signal, logger });
  const diagnostics: MonidSmokeDiagnostics = { http, settings: block, headers, print,
    warn: (value) => console.warn(redact(JSON.stringify(value))) };

  if (values.discover) {
    await discoverMonidEndpoints(diagnostics);
    return 0;
  }

  const limit = Number(values.limit);
  const windowHours = Number(values["window-hours"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > HARD_LIMIT || !Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("--limit must be a whole number from 1 to 10; --window-hours must be positive");
  }
  const search = loadConfig("search");
  const schedule = loadConfig("schedule");
  const group = values.group ?? Object.keys(search.keyword_groups)[0];
  const keywords = group ? search.keyword_groups[group] : undefined;
  const location = values.location ?? search.locations[0];
  if (!group || !keywords?.length || !location) throw new Error("Unknown keyword group or no location configured");
  const query: SearchQuery = {
    id: queryId({ keywords, keywordGroup: group, location, remote: false, remoteScope: null }),
    keywords: [...keywords], keywordGroup: group, location, remote: false, remoteScope: null, company: null, windowHours, maxResults: limit,
  };
  const inputs = buildActorInputs(query, block, limit, marketForChannel());
  if (inputs.length !== 1) throw new Error("Choose a shorter keyword group: smoke permits exactly one run");
  const inspection = await inspectMonidEndpoint(diagnostics, block.provider, block.endpoint);
  print({ query: inputs[0], limit, windowHours, note: "One paid run; no database writes or persisted monthly usage" });

  // Capture only diagnostics; the channel still validates and accounts for every response itself.
  let oversizedOutput = false;
  let runId: string | undefined;
  const fetchWithDiagnostics: FetchLike = async (url, init) => {
    const response = await fetch(url, init);
    const body = await readTextUpTo(response, MAX_RESPONSE_CHARS);
    if (!body.truncated) {
      let value: unknown;
      try { value = JSON.parse(body.text) as unknown; } catch { value = null; }
      const parsed = diagnosticSchema.safeParse(value);
      if (parsed.success) {
        const run = parsed.data;
        runId = run.runId ?? runId;
        print({ status: run.status ?? null, runId: runId ?? null, billedUnits: run.billedUnits ?? null,
          cost: run.cost ?? null, billing: run.billing ?? null, price: run.price ?? null,
          stoppable: run.stoppable ?? inspection.stoppable ?? null,
          outputShape: Array.isArray(run.output) ? "array" : typeof run.output,
          rawCount: Array.isArray(run.output) ? run.output.length : null });
        if (Array.isArray(run.output)) {
          if (run.output.length > limit) oversizedOutput = true;
          for (const item of run.output) {
            const metadata = salaryMetadataSchema.safeParse(item);
            if (metadata.success) print({ salary: metadata.data.salary ?? null, compensationSource: metadata.data.compensationSource ?? null });
          }
        }
      }
    }
    return {
      status: response.status, ok: response.ok, headers: response.headers,
      text: async () => body.text, textUpTo: async () => body,
      json: async (): Promise<unknown> => JSON.parse(body.text),
    };
  };
  const channel = createMonidChannel({ pricePer1kUsd: () => block.price_per_1k_usd });
  const settings = settingsFromConfig("linkedin-monid", channels);
  const budget = await BudgetTracker.create({ store: createMemoryStateStore(), month: monthKey(new Date(), schedule.timezone),
    globalCapUsd: channels.paid_total_monthly_budget_usd, settingsFor: () => settings });
  const ctx = createChannelContext({ channelId: channel.id, settings, http: httpSettingsFromConfig(channels),
    budget: budget.forChannel(channel), signal, cycle: { id: null, kind: "manual" }, logger, fetch: fetchWithDiagnostics });
  let failed = 0;
  try {
    const postings = await channel.collect(query, ctx);
    for (const posting of postings) {
      try {
        const draft = normalizedPostingDraftSchema.parse(channel.parse(posting.payload));
        print({ title: draft.title, workplace: draft.workplace });
      } catch { failed += 1; }
    }
    print({ postings: postings.length, parsed: postings.length - failed, parseFailed: failed });
  } finally {
    print({ usageInMemoryOnly: ctx.budget.snapshot(), note: "Check this charge in the Monid workspace dashboard" });
  }
  if (oversizedOutput) console.error("smoke:monid: Monid exceeded maxItems; check the dashboard charge before retrying");
  return failed > 0 || oversizedOutput ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(redact(`smoke:monid: ${error instanceof Error ? error.message : "failed"}`));
    process.exitCode = 1;
  });
}
