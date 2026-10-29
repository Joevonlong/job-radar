// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";

import { collectOf, config, pinnedSearch } from "./helpers";

afterEach(() => { resetCycleSteps(); });

describe("manual backfill dry run", () => {
  it.each([
    { backfillHours: 36, selected: false, supports: true, hours: 36 },
    { backfillHours: 36, selected: true, supports: false, hours: 36 },
    { backfillHours: 12, selected: true, supports: true, hours: 24 },
    { backfillHours: undefined, selected: false, supports: true, hours: 24 },
  ])("propagates backfillHours=$backfillHours with selection=$selected and catch-up support=$supports", async ({ backfillHours, selected, supports, hours }) => {
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [], supportsCatchUp: () => supports });
    const cfg = config({ search: {
      ...pinnedSearch(), keyword_groups: { engineering: ["Platform Engineer"] }, locations: ["Test City"],
      remote_scope: "none", window_hours: { morning: 24, evening: 24, weekend: 24 },
    } });
    cfg.channels.collect.max_catch_up_hours = 0;
    const logs: LogRecord[] = [];
    const result = await runCycle("manual", {
      dryRun: true, db: null, registry, cascades: [], config: cfg, now: () => new Date("2026-10-07T08:00:00Z"),
      logger: createLogger({ sink: (record) => logs.push(record) }), sleep: async () => {},
      ...(selected ? { channelIds: [fixture.id] } : {}),
      ...(backfillHours === undefined ? {} : { backfillHours }),
    });
    expect(result.cycleId).toBeNull();
    expect(result.status).toBe("succeeded");
    expect(fixture.seen.map((query) => query.windowHours)).toEqual([hours]);
    expect(collectOf(result).rotation[fixture.id]).toMatchObject({ stretched: hours > 24 ? 1 : 0, maxWindowHours: hours, capped: 0 });
    const backfillLogs = logs.filter((record) => record.message === "manual backfill");
    if (backfillHours === undefined) {
      expect(result.summary).not.toHaveProperty("backfillHours");
      expect(backfillLogs).toEqual([]);
    } else {
      expect(result.summary).toMatchObject({ version: 1, backfillHours });
      expect(backfillLogs).toEqual([expect.objectContaining({ level: "info", fields: expect.objectContaining({ hours: backfillHours, channels: selected ? fixture.id : "all" }) })]);
    }
  });
});
