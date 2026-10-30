// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { channelsSchema, parseConfigTextWithVersion, searchSchema } from "@/lib/config";
import { CHANNEL_CONFIG_TABLE, channelSupportsCompanyQueries, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { fieldsOf } from "@/lib/settings/fields";
import { REPO_DEFAULTS_DIR, shippedYaml } from "./helpers";

const ids = Object.keys(CHANNEL_CONFIG_TABLE).filter(channelSupportsCompanyQueries) as ConfiguredChannelId[];
const defaults = searchSchema.parse(shippedYaml("search.yaml")).watched_company_queries;

describe("company-query configuration contract", () => {
  it("new installation YAML declares the schema defaults and has editable fields", () => {
    const raw = parse(fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "search.yaml"), "utf8"));
    expect(raw.watched_company_queries).toEqual(defaults);
    const channels = parseConfigTextWithVersion("channels", fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "sources.yaml"), "utf8")).value;
    const rawChannels = parse(fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "sources.yaml"), "utf8"));
    for (const id of ids) {
      const ref = CHANNEL_CONFIG_TABLE[id];
      const prefix = `${ref.section}.${ref.key}`;
      expect(rawChannels[ref.section][ref.key].company_queries).toBe(settingsFromConfig(id, channelsSchema.parse(shippedYaml("sources.yaml"))).companyQueries);
      expect(fieldsOf("channels").some((field) => field.path === `${prefix}.company_queries`)).toBe(true);
      expect(settingsFromConfig(id, channels).companyQueries).toBe(true);
    }
    for (const key of Object.keys(defaults)) expect(fieldsOf("search").some((field) => field.path === `watched_company_queries.${key}`)).toBe(true);
  });

  it.each([undefined, {}])("an old file or empty block receives nested defaults (%j)", (block) => {
    const raw = shippedYaml("search.yaml");
    if (block === undefined) delete raw.watched_company_queries;
    else raw.watched_company_queries = block;
    expect(searchSchema.parse(raw).watched_company_queries).toEqual(defaults);
    const channels = channelsSchema.parse(shippedYaml("sources.yaml"));
    for (const id of ids) expect(settingsFromConfig(id, channels).companyQueries).toBe(true);
  });

  it("honors explicit global and per-channel opt-outs", () => {
    expect(searchSchema.parse({ ...shippedYaml("search.yaml"), watched_company_queries: { enabled: false } }).watched_company_queries).toEqual({ ...defaults, enabled: false });
    const raw = shippedYaml("sources.yaml");
    const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
    linkedin.guest!.company_queries = false;
    expect(settingsFromConfig("linkedin-guest", channelsSchema.parse(raw)).companyQueries).toBe(false);
  });

  it.each([{ max_per_cycle: -1 }, { min_interval_hours: 0 }, { max_results: 101 }, { enabled: "yes" }])("rejects invalid controls (%j)", (block) => {
    expect(() => searchSchema.parse({ ...shippedYaml("search.yaml"), watched_company_queries: block })).toThrow();
  });
});
