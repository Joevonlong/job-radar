// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChannelRegistry } from "@/lib/channels/registry";
import { createFixtureChannel, FIXTURE_SETTINGS } from "@/lib/channels/fixture";
import type { Channel } from "@/lib/channels/types";
import { runCycle } from "@/lib/cycle/run-cycle";

import { collectOf, config, quietLogger } from "./helpers";

/** `Channel.isDue`: a channel that is not due is left out of the cycle entirely: no run, no "skipped" noise. */
function registryWith(isDue: Channel["isDue"]) {
  const registry = new ChannelRegistry();
  const channel = createFixtureChannel({ id: "daily" });
  registry.register({ ...channel, ...(isDue ? { isDue } : {}) }, { settings: FIXTURE_SETTINGS });
  return registry;
}

const run = (registry: ChannelRegistry, kind: "manual" | "weekday_morning" = "weekday_morning") =>
  runCycle(kind, { dryRun: true, registry, config: config(), logger: quietLogger, sleep: async () => {}, now: () => new Date("2026-10-07T08:00:00Z") });

describe("channels that are not due", () => {
  it("is left out when isDue says no (no runs, status stays succeeded)", async () => {
    const result = await run(registryWith(() => false));
    expect(collectOf(result).channels.daily).toBeUndefined();
    expect(result.status).toBe("succeeded");
  });

  it("runs when isDue says yes, and when it has no isDue", async () => {
    expect(collectOf(await run(registryWith(() => true))).channels.daily?.runs).toBe(9);
    expect(collectOf(await run(registryWith(undefined))).channels.daily?.runs).toBe(9);
  });

  it("hands isDue the cycle kind, the clock and the dry-run flag; an async answer works", async () => {
    const seen: unknown[] = [];
    await run(
      registryWith(async (info) => {
        seen.push(info);
        return true;
      }),
    );
    expect(seen).toEqual([{ kind: "weekday_morning", now: new Date("2026-10-07T08:00:00Z"), dryRun: true }]);
  });

  it("a failing isDue counts as due (and the cycle goes on)", async () => {
    const result = await run(
      registryWith(() => {
        throw new Error("database unreachable");
      }),
    );
    expect(collectOf(result).channels.daily?.runs).toBe(9);
  });
});
