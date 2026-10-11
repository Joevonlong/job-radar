// @vitest-environment node
/**
 * interests.yaml 2 -> 3 renames the amount keys to base-currency names and the saved views' `hideGerman` to
 * `hideLang`; the rule fingerprint is the same before and after (no rescan), and `assume_currency: market` is the
 * market's currency. The URL keeps reading the old `hideGerman`.
 */
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { migrateConfigDocument, parseConfigDocument, validateConfigValue } from "@/lib/config";
import { withLegacyKeys } from "@/lib/jobs/search-params";
import { rulesFingerprint } from "@/lib/signals/fingerprint";

import { shippedPipeline } from "../pipeline/helpers";
import { rawAmount, shippedInterests } from "../signals/helpers";
import { shippedYaml } from "../config/helpers";

/** The fixture's interests.yaml written back in the v2 shape (old key names, a view with `hideGerman`). */
function v2Text(): string {
  const raw = structuredClone(shippedYaml("interests.yaml"));
  const amount = rawAmount(raw);
  const { min_annual: minAnnual, rough_fx: roughFx, ...rest } = amount;
  for (const key of Object.keys(amount)) delete amount[key];
  Object.assign(amount, { min_annual_eur: minAnnual, ...rest, rough_fx_to_eur: roughFx });
  raw.views = [{ id: "de", name: "No German", filters: { hideGerman: true, city: "Berlin" } }];
  return `config_version: 2\n${stringify(raw)}`;
}

function migrate(text: string): { text: string; steps: number } {
  const doc = parseConfigDocument("interests", text, "interests.yaml");
  const result = migrateConfigDocument("interests", doc, "interests.yaml");
  return { text: doc.toString(), steps: result.applied.length };
}

describe("interests.yaml 2 -> 3", () => {
  const migrated = migrate(v2Text());
  const value = validateConfigValue("interests", parse(migrated.text), "interests.yaml");

  it("renames the amount keys and the view filter, keeps the values, and a second run changes nothing", () => {
    expect(migrated.steps).toBe(1);
    const amount = value.signals.categories.find((c) => c.kind === "amount");
    expect(amount?.kind === "amount" ? amount.amount : null).toMatchObject({ min_annual: 20000, rough_fx: { USD: 0.9, GBP: 1.15, CHF: 1.05 } });
    expect(migrated.text).not.toContain("min_annual_eur");
    expect(value.views[0]?.filters).toEqual({ hideLang: true, city: "Berlin" });
    expect(migrated.text).toMatch(/^config_version: 3$/m);
    const again = migrate(migrated.text);
    expect(again.steps).toBe(0);
    expect(again.text).toBe(migrated.text);
  });

  it("keeps the rule fingerprint, and `market` hashes as the market's currency", () => {
    const pipeline = shippedPipeline();
    const shipped = shippedInterests();
    expect(rulesFingerprint(value, pipeline)).toBe(rulesFingerprint(shipped, pipeline));
    const market = shippedInterests((raw) => void (rawAmount(raw).assume_currency = "market"));
    expect(rulesFingerprint(market, pipeline)).toBe(rulesFingerprint(shipped, pipeline));
  });
});

describe("the local-language filter in the URL", () => {
  it("reads the old hideGerman as hideLang (an explicit hideLang wins) and never writes it back", () => {
    expect(withLegacyKeys({ hideGerman: true, hideLang: null, high: null, t12: null })).toMatchObject({ hideLang: true, hideGerman: null });
    expect(withLegacyKeys({ hideGerman: true, hideLang: false, high: null, t12: null })).toMatchObject({ hideLang: false, hideGerman: null });
  });
});
