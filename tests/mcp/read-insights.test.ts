// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/insights/load", () => ({ loadInsightsView: vi.fn() }));
import { PERMISSIONS } from "@/lib/agent-access/permissions";
import { insightsSchema } from "@/lib/config/schemas/insights";
import { loadInsightsView } from "@/lib/insights/load";
import { buildInsightsView } from "@/lib/insights/view";
import { insightsOutputFor } from "@/lib/mcp/dto/insights";
import { getInsights } from "@/lib/mcp/tools/get-insights";
import { emptyData } from "../insights/helpers";
import { shippedYaml } from "../config/helpers";
import { readContext } from "./read-fixtures";

function insightView() {
  const config = insightsSchema.parse({ ...shippedYaml("insights.yaml"), ranges_days: [30], default_range_days: 30, score_bucket_width: 5, score_bucket_cap: 100 });
  const data = emptyData();
  data.cities.cities = [{ city: "Preference City", count: 0 }];
  data.signals.tiers = [{ tier: "InterestCategory", jobs: 1, avgRank: 80 }, { tier: "ZeroMatch", jobs: 0, avgRank: null }];
  data.sources = [{ family: "small", total: 1, passed: 1 }, { family: "large", total: 3, passed: 3 }];
  data.salary.buckets = [{ index: 1, count: 1 }, { index: 3, count: 1 }];
  const view = buildInsightsView({ data, config, rangeDays: 30, window: { from: "2026-09-12", to: "2026-10-11" }, pushLine: 70 });
  view.signals.tiers[0]!.label = "Private Interest Name";
  view.signals.tiers[1]!.label = "Private Zero Match";
  return view;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadInsightsView).mockResolvedValue(insightView()); });

it("omits configured city and category rows without profile permission, in values and schema", async () => {
  const basic = await getInsights(readContext(["jobs:read"]), {});
  expect(insightsOutputFor(new Set()).safeParse(basic).success).toBe(true);
  expect(basic.cities).toBeUndefined();
  expect(basic.signals.categories).toBeUndefined();
  expect(insightsOutputFor(new Set()).safeParse({ ...basic, cities: [] }).success).toBe(false);
  expect(insightsOutputFor(new Set()).safeParse({ ...basic, signals: { ...basic.signals, categories: [] } }).success).toBe(false);
  const granted = await getInsights(readContext(PERMISSIONS), {});
  for (const sentinel of ["Preference City", "InterestCategory", "Private Interest Name", "ZeroMatch", "Private Zero Match"]) {
    expect(JSON.stringify(basic)).not.toContain(sentinel);
    expect(JSON.stringify(granted)).toContain(sentinel);
  }
});

it("preserves full daily and histogram series with the default-sized range and result cap", async () => {
  const ctx = readContext(PERMISSIONS, 20);
  const value = await getInsights(ctx, {});
  const view = await loadInsightsView(null, ctx.now(), "en", ctx.db);
  expect(value.daily).toHaveLength(30);
  expect(value.daily.at(-1)?.day).toBe(view.window.to);
  expect(value.scores.bars).toHaveLength(21);
  expect(value.scores.bars).toHaveLength(view.scores.bars.length);
  expect(value.truncated).toBe(false);
  const tiny = await getInsights(ctx, { limit: 1 });
  expect(tiny.daily).toEqual(value.daily);
  expect(tiny.salary.bars).toEqual(value.salary.bars);
  expect(tiny.scores.bars).toEqual(value.scores.bars);
  expect(tiny.tracking?.funnel).toEqual(value.tracking?.funnel);
  expect(tiny.sources.map((row) => row.family)).toEqual(["large"]);
  expect(tiny.truncated).toBe(true);
});
