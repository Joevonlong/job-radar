/**
 * Live smoke test of the JSearch channel: ONE search (one RapidAPI request) against the real API.
 *
 *   pnpm smoke:jsearch [--group <keyword group>] [--location Berlin] [--remote] [--window-hours 24]
 *   pnpm exec tsx --env-file=/path/to/.env scripts/smoke-jsearch.ts
 *
 * It uses one request of your plan's monthly quota. Nothing is written to the database: usage is
 * tracked in memory and printed, together with how the records parse. Needs JSEARCH_API_KEY in the
 * environment; the key is never printed. Ignores `enabled` and `pace_requests` in sources.yaml.
 */
import { parseArgs } from "node:util";

import { BudgetTracker, monthKey } from "../src/lib/channels/budget";
import { createChannelContext, httpSettingsFromConfig } from "../src/lib/channels/context";
import { createLogger } from "../src/lib/channels/logger";
import { createJsearchChannel, JSEARCH_API_KEY_ENV } from "../src/lib/channels/jsearch";
import { queryId } from "../src/lib/channels/query";
import { settingsFromConfig } from "../src/lib/channels/registry";
import { createMemoryStateStore } from "../src/lib/channels/store";
import { normalizedPostingDraftSchema } from "../src/lib/channels/types";
import { loadConfig } from "../src/lib/config";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      group: { type: "string" },
      location: { type: "string" },
      remote: { type: "boolean", default: false },
      "window-hours": { type: "string", default: "24" },
    },
    strict: true,
  });
  if ((process.env[JSEARCH_API_KEY_ENV] ?? "").trim() === "") {
    console.error(`smoke:jsearch: ${JSEARCH_API_KEY_ENV} is not set (the channel is "not configured"); nothing was sent`);
    return 2;
  }
  const windowHours = Number(values["window-hours"]);
  const channels = loadConfig("channels");
  const search = loadConfig("search");
  const schedule = loadConfig("schedule");
  const groupId = values.group ?? Object.keys(search.keyword_groups)[0];
  const keywords = groupId ? search.keyword_groups[groupId] : undefined;
  const location = values.remote ? null : (values.location ?? search.locations[0] ?? null);
  if (!Number.isFinite(windowHours) || windowHours <= 0 || !groupId || !keywords || (!values.remote && location === null)) {
    console.error("smoke:jsearch: bad --window-hours, unknown keyword group, or no location configured");
    return 2;
  }

  const channel = createJsearchChannel();
  // the smoke run is a single request: keep it single whatever the configured limits are
  const base = settingsFromConfig("jsearch", channels);
  const settings = { ...base, extra: { ...base.extra, keywords_per_query: 1, pages_per_query: 1, fetch_details: false, pace_requests: false } };
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
    signal: AbortSignal.timeout(120_000),
    cycle: { id: null, kind: "manual" },
    logger: createLogger({ minLevel: "info" }),
  });

  const remoteScope = values.remote && search.remote_scope !== "none" ? search.remote_scope : null;
  const query = {
    id: queryId({ keywords, keywordGroup: groupId, location, remote: values.remote, remoteScope }),
    keywords: [...keywords],
    keywordGroup: groupId,
    location,
    remote: values.remote,
    remoteScope,
    company: null,
    windowHours,
    maxResults: 10,
  };
  console.log(`smoke: group=${groupId} first keyword="${keywords[0] ?? ""}" location=${location ?? "(remote)"} windowHours=${windowHours}`);

  const postings = await channel.collect(query, ctx);
  const usage = ctx.budget.snapshot();
  console.log(`smoke: postings=${postings.length}; requests used this run (in memory only, not persisted): ${usage.records}`);

  let parsed = 0;
  let failed = 0;
  const fields = new Set<string>();
  for (const posting of postings) {
    const record = (posting.payload as { search?: unknown }).search;
    if (typeof record === "object" && record !== null) for (const key of Object.keys(record)) fields.add(key);
    try {
      const draft = normalizedPostingDraftSchema.parse(channel.parse(posting.payload));
      parsed += 1;
      console.log(
        `  - ${draft.title} @ ${draft.companyName} | ${draft.locations[0]?.label ?? "?"} | posted ${draft.postedAt?.toISOString() ?? "?"} | salary ${draft.salaryText ?? "-"} | ${draft.workplace} | apply via ${String(draft.extra?.applyPublisher ?? "?")}${draft.extra?.applyIsDirect === true ? " (direct)" : ""}`,
      );
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
    console.error(`smoke:jsearch: ${error instanceof Error ? `${error.name}: ${error.message}` : "failed"}`);
    process.exit(1);
  },
);
