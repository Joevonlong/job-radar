// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfigText } from "@/lib/config";
import { buildEffectivePipeline, buildMarket, readPackDir, type Pack } from "@/lib/market";
import { parseSalaryText } from "@/lib/pipeline/salary";

import { REPO_DEFAULTS_DIR } from "../config/helpers";

/**
 * The currency tokens that SHIP (config/packs/generic/rules.yaml, config/pipeline.yaml), not the frozen fixture: a token that
 * reads inside another word or inside another symbol only shows with the real list.
 */
const realPack = (id: string): Pack => readPackDir(id, path.join(REPO_DEFAULTS_DIR, "packs", id), "shipped");
const generic = realPack("generic");
const pipelineText = fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "pipeline.yaml"), "utf8");
const config = buildEffectivePipeline(parseConfigText("pipeline", pipelineText, "pipeline.yaml"), buildMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" }, generic, generic), realPack);
const read = (text: string) => parseSalaryText(text, config, { requireCurrency: false });

describe("shipped currency tokens", () => {
  it.each([
    ["US$100,000", "USD", 100000],
    ["$100,000", "USD", 100000],
    ["C$120,000", "CAD", 120000],
    ["A$150,000", "AUD", 150000],
    ["CA$120,000", "CAD", 120000],
    ["S$90,000", "SGD", 90000],
    ["CAD 120,000 per year", "CAD", 120000],
    ["120,000 CAD", "CAD", 120000],
    ["€75,000", "EUR", 75000],
    ["100k€", "EUR", 100000],
  ])("%s -> %s", (text, currency, min) => {
    const parsed = read(text);
    expect(parsed?.currency).toBe(currency);
    expect(parsed?.min).toBe(min);
  });

  it("a currency word inside another word is no currency", () => {
    const parsed = read("Dein Gehalt: 70.000 - 80.000 pro Jahr (Details im Gespraech)");
    expect(parsed?.currency ?? null).toBeNull();
    for (const text of ["Skills 70.000 - 80.000 pro Jahr", "Radical 70.000 per year", "Zarathustra 70.000 per year", "Incarnation 70.000 per year", "Broadcast 70.000 per year"]) {
      expect(read(text)?.currency ?? null).toBeNull();
    }
  });

  it("every shipped currency has an exchange rate in pipeline.yaml", () => {
    const rates = Object.keys(config.salary.fx_rates);
    const missing = config.salary.currencies.map((entry) => entry.code).filter((code) => code !== config.salary.fx_pivot && !rates.includes(code));
    expect(missing).toEqual([]);
  });
});
