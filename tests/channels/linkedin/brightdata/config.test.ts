// @vitest-environment node
import { describe, expect, it } from "vitest";

import { brightDataSettingsSchema } from "@/lib/channels/linkedin/brightdata";
import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../../../config/helpers";
import { brightSettings } from "./helpers";

function edited(edit: (block: Record<string, unknown>) => void) {
  const raw = structuredClone(shippedYaml("sources.yaml"));
  edit((raw.linkedin as Record<string, Record<string, unknown>>).brightdata as Record<string, unknown>);
  return configRegistry.channels.schema.safeParse(raw);
}

describe("sources.yaml linkedin.brightdata", () => {
  it("ships the agreed defaults and they satisfy the channel's own settings schema", () => {
    const settings = brightSettings();
    expect(settings).toMatchObject({ enabled: true, monthlyBudgetUsd: 5, freeRecordsPerMonth: 5000 });
    const parsed = brightDataSettingsSchema.parse(settings.extra);
    expect(parsed).toMatchObject({ dataset_id: "gd_lpfll7v5hcqtkxl6l", cost_per_1k_usd: 1.5, country: "DE" });
  });

  it("rejects bad values with the field path", () => {
    const paths = (r: ReturnType<typeof edited>) => (r.success ? [] : r.error.issues.map((i) => i.path.join(".")));
    expect(paths(edited((b) => (b.cost_per_1k_usd = -1)))).toEqual(["linkedin.brightdata.cost_per_1k_usd"]);
    expect(paths(edited((b) => (b.dataset_id = "")))).toEqual(["linkedin.brightdata.dataset_id"]);
    expect(paths(edited((b) => (b.country = "de")))).toEqual(["linkedin.brightdata.country"]);
    expect(paths(edited((b) => (b.poll_interval_ms = 0)))).toEqual(["linkedin.brightdata.poll_interval_ms"]);
    expect(paths(edited((b) => (b.timeout_ms = 100)))).toEqual(["linkedin.brightdata.poll_interval_ms"]);
    // Without remote_locations the remote query follows the market
    expect(paths(edited((b) => delete b.remote_locations))).toEqual([]);
  });
});
