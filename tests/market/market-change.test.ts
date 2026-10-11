// @vitest-environment node
/**
 * The market changed in the wizard or on /me (the web writes preferences.yaml) is in effect from the runner's next
 * cycle on, without a restart: the channel set, the hard filter and the base currency all follow it.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelRegistry } from "@/lib/channels/registry";
import { loadConfig } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { compileFilter, evaluateJob, type FilterJob } from "@/lib/filter/rules";
import { loadPipeline, resetMarketCache } from "@/lib/market";
import { loadBaseCurrency } from "@/lib/signals/floor";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, probeChannel, quietLogger } from "../cycle/helpers";

/** A migration step that throws (a bug, not a ConfigError) for preferences.yaml while `brokenMigration.on` is set. */
const brokenMigration = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/config/migrations/version", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config/migrations/version")>();
  return {
    ...original,
    migrateConfigDocument: (...args: Parameters<typeof original.migrateConfigDocument>) => {
      if (brokenMigration.on && args[0] === "preferences") throw new TypeError("migration step bug");
      return original.migrateConfigDocument(...args);
    },
  };
});

const US = "market:\n  pack: generic\n  country: US\n  currency: USD\n  home_language: en\n";
const DE = "market:\n  pack: de\n  country: DE\n  currency: EUR\n  home_language: de\n";

let tmp: TempConfig;
let preferencesFile: string;
let template: string;

/** What the web process does when the wizard or /me saves: a new file, this process's caches untouched. */
function webSavesMarket(market: string): void {
  fs.writeFileSync(preferencesFile, template.replace(/market:\n(?:  .*\n)+/, market));
}

const usRemoteJob: FilterJob = {
  title: "Senior AI Engineer - US",
  description: null,
  companyName: "Example",
  companyAliases: [],
  companyBlacklisted: false,
  locations: [],
  workplace: "remote",
  seniority: "senior",
  contract: "permanent",
  salary: null,
};

function filterVerdict() {
  return evaluateJob(usRemoteJob, compileFilter(loadConfig("preferences"), loadPipeline()));
}

async function cycleChannels(): Promise<string[]> {
  const registry = new ChannelRegistry();
  const probes = ["arbeitsagentur", "stepstone", "greenhouse"].map((id) => probeChannel(id));
  for (const probe of probes) registry.register(probe);
  await runCycle("manual", { dryRun: true, registry, config: config(), logger: quietLogger, sleep: async () => {} });
  return probes.filter((p) => p.calls.length > 0).map((p) => p.id);
}

beforeEach(() => {
  tmp = makeTempConfig();
  fs.mkdirSync(tmp.profileDir, { recursive: true });
  preferencesFile = path.join(tmp.profileDir, "preferences.yaml");
  template = fs.readFileSync(path.join(tmp.defaultsDir, "profile.example", "preferences.yaml"), "utf8");
  resetMarketCache();
});
afterEach(() => {
  tmp.cleanup();
  resetMarketCache();
});

describe("a market change between two cycles", () => {
  it("switches the channel set, the remote filter and the base currency at the next cycle", async () => {
    webSavesMarket(US);
    expect(await cycleChannels()).toEqual(["greenhouse"]);
    expect(loadBaseCurrency()).toBe("USD");
    expect(filterVerdict().result).toBe("passed");

    webSavesMarket(DE); // no restart, and before the watcher's poll could notice
    expect(await cycleChannels()).toEqual(["arbeitsagentur", "stepstone", "greenhouse"]);
    expect(loadBaseCurrency()).toBe("EUR");
    expect(filterVerdict()).toMatchObject({ result: "filtered_out", reasons: ["remote_out_of_scope:US"] });

    webSavesMarket(US);
    expect(await cycleChannels()).toEqual(["greenhouse"]);
    expect(loadBaseCurrency()).toBe("USD");
  });

  it("a config that cannot be reloaded (a migration throws) keeps its last good value and the cycle goes on", async () => {
    webSavesMarket(US);
    expect(await cycleChannels()).toEqual(["greenhouse"]);
    webSavesMarket(DE);
    brokenMigration.on = true;
    try {
      expect(await cycleChannels()).toEqual(["greenhouse"]);
      expect(loadBaseCurrency()).toBe("USD");
    } finally {
      brokenMigration.on = false;
    }
    expect(await cycleChannels()).toEqual(["arbeitsagentur", "stepstone", "greenhouse"]); // fixed: picked up again
  });
});
