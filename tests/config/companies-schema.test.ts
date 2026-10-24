import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { parseConfigText } from "@/lib/config";
import { COMPANIES_PAGE_DEFAULTS, uiSchema } from "@/lib/config/schemas/ui";

const ui = {
  salary_axis: { min_k: 20, max_k: 100, tick_step_k: 10 },
  freshness: { decay_hours: 48, warn_hours: 12 },
  trend_cycles: 3,
  health_cycles: 5,
  ticker_max_items: 4,
};

describe("company overview configuration", () => {
  it("reads an older user ui.yaml without companies, or with an empty block", () => {
    const loaded = parseConfigText("ui", stringify({ config_version: 2, ...ui }), "ui.yaml");
    expect(loaded.companies).toEqual(COMPANIES_PAGE_DEFAULTS);
    expect(loaded.companies.page_size).toBe(50);
    expect(uiSchema.parse({ ...ui, companies: {} }).companies).toEqual(COMPANIES_PAGE_DEFAULTS);
  });

  it.each([0, -1, 1.5, 501])("rejects page_size %s", (page_size) => {
    expect(uiSchema.safeParse({ ...ui, companies: { page_size } }).success).toBe(false);
  });

  it.each([1, 27, 500])("accepts page_size %s", (page_size) => {
    expect(uiSchema.parse({ ...ui, companies: { page_size } }).companies.page_size).toBe(page_size);
  });
});
