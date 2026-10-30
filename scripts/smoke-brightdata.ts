/**
 * Live smoke test of the Bright Data LinkedIn channel: ONE tiny query against the real API.
 *
 *   pnpm smoke:brightdata [--limit 10] [--group <keyword group>] [--location Berlin] [--window-hours 24]
 *   pnpm exec tsx --env-file=/path/to/.env scripts/smoke-brightdata.ts
 *
 * It consumes provider quota (the provider bills every record it delivers, even though nothing is stored here), so the limit is
 * capped at 10. Nothing is written to the database: usage is tracked in memory and printed, together
 * with how the records parse. Needs BRIGHT_DATA_API_KEY in the environment; the key is never printed.
 */
import { parseArgs } from "node:util";

import { BudgetTracker, monthKey } from "../src/lib/channels/budget";
import { createChannelContext, httpSettingsFromConfig } from "../src/lib/channels/context";
import { createLogger } from "../src/lib/channels/logger";
import { createBrightDataChannel } from "../src/lib/channels/linkedin/brightdata";
import { queryId } from "../src/lib/channels/query";
import { settingsFromConfig } from "../src/lib/channels/registry";
import { createMemoryStateStore } from "../src/lib/channels/store";
import { normalizedPostingDraftSchema } from "../src/lib/channels/types";
import { loadConfig } from "../src/lib/config";

const HARD_LIMIT = 10;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", default: String(HARD_LIMIT) },
      group: { type: "string" },
      location: { type: "string" },
      "window-hours": { type: "string", default: "24" },
    },
    strict: true,
  });
  const limit = Math.min(HARD_LIMIT, Math.max(1, Number(values.limit)));
  const windowHours = Number(values["window-hours"]);
  if (!Number.isFinite(limit) || !Number.isFinite(windowHours) || windowHours <= 0) {
    console.error("smoke:brightdata: bad --limit or --window-hours");
    return 2;
  }

  const channels = loadConfig("channels");
  const search = loadConfig("search");
  const schedule = loadConfig("schedule");
  const groupId = values.group ?? Object.keys(search.keyword_groups)[0];
  const keywords = groupId ? search.keyword_groups[groupId] : undefined;
  const location = values.location ?? search.locations[0];
  if (!groupId || !keywords || !location) {
    console.error("smoke:brightdata: unknown keyword group or no location configured");
    return 2;
  }

  const channel = createBrightDataChannel({ costPer1kUsd: () => channels.linkedin.brightdata.cost_per_1k_usd });
  const settings = settingsFromConfig("linkedin-brightdata", channels);
  const budget = await BudgetTracker.create({
    store: createMemoryStateStore(),
    month: monthKey(new Date(), schedule.timezone),
    globalCapUsd: channels.paid_total_monthly_budget_usd,
    settingsFor: () => settings,
  });
  const ctx = createChannelContext({
    channelId: channel.id,
    settings,
    http: httpSettingsFromConfig(channels),
    budget: budget.forChannel(channel),
    signal: AbortSignal.timeout(channels.linkedin.brightdata.timeout_ms + 30_000),
    cycle: { id: null, kind: "manual" },
    logger: createLogger({ minLevel: "info" }),
  });

  const query = {
    id: queryId({ keywords, keywordGroup: groupId, location, remote: false, remoteScope: null }),
    keywords: [...keywords],
    keywordGroup: groupId,
    location,
    remote: false,
    remoteScope: null, company: null,
    windowHours,
    maxResults: limit,
  };
  console.log(`smoke: group=${groupId} (${keywords.length} keywords OR-merged) location=${location} windowHours=${windowHours} limit=${limit}`);

  const postings = await channel.collect(query, ctx);
  const usage = ctx.budget.snapshot();
  console.log(`smoke: stored-worthy postings=${postings.length} (after de-duplication and the local time filter)`);
  console.log(`smoke: usage this run (in memory only, not persisted): records=${usage.records} usd=${usage.usd} freeRecordsLeft=${usage.freeRecordsLeft}`);
  console.log(`smoke: NOTE the provider BILLED these ${usage.records} records against your Bright Data quota; this smoke run stores nothing and does NOT add them to the persisted monthly usage`);

  let parsed = 0;
  let failed = 0;
  const fields = new Set<string>();
  for (const posting of postings) {
    if (typeof posting.payload === "object" && posting.payload !== null) for (const key of Object.keys(posting.payload)) fields.add(key);
    try {
      const draft = normalizedPostingDraftSchema.parse(channel.parse(posting.payload));
      parsed += 1;
      console.log(`  - ${draft.title} @ ${draft.companyName} | ${draft.locations[0]?.label ?? "?"} | posted ${draft.postedAt?.toISOString() ?? "?"} | salary ${draft.salaryText ?? "-"} | ${draft.workplace}`);
    } catch (error) {
      failed += 1;
      console.log(`  - parse failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  console.log(`smoke: parsed ${parsed}/${postings.length} (${failed} failed)`);
  console.log(`smoke: record fields seen: ${[...fields].sort().join(", ")}`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`smoke:brightdata: ${error instanceof Error ? `${error.name}: ${error.message}` : "failed"}`);
    process.exit(1);
  },
);
