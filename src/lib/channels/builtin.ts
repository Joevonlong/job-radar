import { registerJobspyChannels } from "./jobspy";
import { arbeitsagenturChannel } from "./arbeitsagentur";
import { stepstoneChannel } from "./stepstone";
import { xingChannel } from "./xing";
import { registerAtsChannels } from "./ats";
import { createBraveChannel, createTavilyChannel } from "./discovery";
import { registerEmailChannels } from "./email";
import { createJsearchChannel } from "./jsearch";
import { loadConfig } from "@/lib/config";

import { createApifyChannel } from "./linkedin/apify";
import { createBrightDataChannel } from "./linkedin/brightdata";
import { createSessionChannels } from "./linkedin/session";
import type { ChannelRegistry } from "./registry";

/**
 * Register every real channel with `registry`. Collection features (Arbeitsagentur,
 * jobspy, ATS and discovery, Bright Data, ...) add their `registry.register(...)` call here; the
 * runner and `pnpm cycle:run` call this once at start-up. Which of them actually run is decided by
 * sources.yaml.
 */
export function registerBuiltinChannels(registry: ChannelRegistry): void {
  registerJobspyChannels(registry); // linkedin-guest, indeed, jobspy-google
  registry.register(arbeitsagenturChannel);
  registerAtsChannels(registry); // greenhouse, lever
  registry.register(createTavilyChannel()); // discovery of new ATS boards through Tavily (no postings; the default search backend)
  registry.register(createBraveChannel()); // the same through Brave Search (off by default)
  registerEmailChannels(registry); // gmail-alerts
  registry.register(stepstoneChannel);
  registry.register(xingChannel);
  registry.register(createJsearchChannel()); // Google Jobs through JSearch (RapidAPI)
  // The price is read per call, so a config reload takes effect without re-registering
  registry.register(createBrightDataChannel({ costPer1kUsd: () => loadConfig("channels").linkedin.brightdata.cost_per_1k_usd }));
  // Second in the LinkedIn cascade; without APIFY_TOKEN (or an actor id) the cascade skips it as "not configured"
  registry.register(
    createApifyChannel({
      actorId: () => loadConfig("channels").linkedin.apify.actor_id,
      pricePer1kUsd: () => loadConfig("channels").linkedin.apify.price_per_1k_usd,
    }),
  );
  // Third in the LinkedIn cascade (the user's own logged-in browser, read-only) and the once-a-day "recommended for you" read.
  // Without .auth/linkedin.json both are "not configured" and do nothing.
  const linkedinSession = createSessionChannels();
  registry.register(linkedinSession.session);
  registry.register(linkedinSession.recommended);
}
