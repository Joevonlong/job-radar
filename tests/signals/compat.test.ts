/**
 * Compatibility: with the five default categories (what interests.yaml v1 becomes), the rule fingerprint and the
 * AI prompt are exactly what the code before the signal categories produced, so an upgrade rescans nothing and sends nothing to the AI
 * again. The constants below were computed with the pre-category code (main 74d9500) from the v1 fixture.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildSignalsSystem, LEGACY_SIGNALS_PROMPT_VERSION, LEGACY_SYSTEM } from "@/lib/ai/prompts/signals";
import { parseConfigText } from "@/lib/config";
import { DEFAULT_SIGNAL_CATEGORIES } from "@/lib/signals/defaults";
import { promptCategories, rulesFingerprint, signalsPrompt } from "@/lib/signals/fingerprint";

import { rawCategories, rawCategory, shippedInterests, shippedPipeline } from "./helpers";

/** `rulesFingerprint` of tests/fixtures/config/interests.v1.yaml + the pipeline fixture, computed by the code before the signal categories. */
const V1_RULES_FINGERPRINT = "08524588cac609820854be1fd76175b8";
/** sha256 of the system prompt the code before the signal categories sent (`SYSTEM` of src/lib/ai/prompts/signals.ts at 74d9500). */
const V1_SYSTEM_SHA256 = "0bf0500928ca77c43bf7f2cf748462aac0d51eca0fd78fee60a63d00e9390b08";

const V1_FILE = path.resolve(import.meta.dirname, "../fixtures/config/interests.v1.yaml");
const v1 = () => parseConfigText("interests", fs.readFileSync(V1_FILE, "utf8"), V1_FILE);
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("rules fingerprint", () => {
  it("is the pre-category value for a v1 file migrated in memory and for the migrated v2 fixture", () => {
    expect(rulesFingerprint(v1(), shippedPipeline())).toBe(V1_RULES_FINGERPRINT);
    expect(rulesFingerprint(shippedInterests(), shippedPipeline())).toBe(V1_RULES_FINGERPRINT);
  });

  it("ignores names, icons, colours, weights, high value and AI definitions", () => {
    const edited = shippedInterests((raw) => {
      const t2 = rawCategory(raw, "T2");
      Object.assign(t2, { label: { zh: "期权", en: "Options" }, icon: "🪙", color: "pink", weight: 1, high_value: false, ai_definition: "stock options" });
      raw.bonus_cap = 3;
    });
    expect(rulesFingerprint(edited, shippedPipeline())).toBe(V1_RULES_FINGERPRINT);
  });

  it("changes with the vocabulary, the order, ai_confirm_only, a new and a deleted category", () => {
    const changes: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => (rawCategory(raw, "T3").keywords as string[]).push("good pay"),
      (raw) => rawCategories(raw).reverse(),
      (raw) => (rawCategory(raw, "T3").ai_confirm_only = true),
      (raw) => rawCategories(raw).push({ id: "visa", kind: "keyword", label: { en: "Visa" }, color: "violet", ai_definition: "visa", keywords: ["visa sponsorship"] }),
      (raw) => {
        const categories = rawCategories(raw);
        const [t4] = categories.splice(3, 1);
        (raw.signals as { retired_categories: unknown[] }).retired_categories = [t4];
      },
    ];
    const seen = new Set([V1_RULES_FINGERPRINT]);
    for (const change of changes) {
      const value = rulesFingerprint(shippedInterests(change), shippedPipeline());
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
  });
});

describe("signals prompt", () => {
  it("keeps the pre-category text and version for the default categories", () => {
    expect(sha256(LEGACY_SYSTEM)).toBe(V1_SYSTEM_SHA256);
    for (const interests of [v1(), shippedInterests()]) {
      const spec = signalsPrompt(interests);
      expect(spec?.version).toBe(LEGACY_SIGNALS_PROMPT_VERSION);
      expect(spec?.system).toBe(LEGACY_SYSTEM);
    }
  });

  it("the default AI definitions are the ones the legacy text lists", () => {
    for (const meta of DEFAULT_SIGNAL_CATEGORIES.filter((c) => c.kind !== "tag")) expect(LEGACY_SYSTEM).toContain(`- ${meta.id}: ${meta.ai_definition}`);
  });

  it("does not change with names, colours, weights or high value", () => {
    const edited = shippedInterests((raw) => {
      Object.assign(rawCategory(raw, "T1"), { label: { en: "Money" }, color: "slate", weight: 3, high_value: false });
    });
    expect(signalsPrompt(edited)?.version).toBe(LEGACY_SIGNALS_PROMPT_VERSION);
  });

  it("gets a new version when an AI definition, an AI category or ai_confirm_only changes", () => {
    const definition = signalsPrompt(shippedInterests((raw) => (rawCategory(raw, "T3").ai_definition = "the JD praises its pay")));
    const added = signalsPrompt(shippedInterests((raw) => rawCategories(raw).push({ id: "visa", kind: "keyword", label: { en: "Visa" }, color: "violet", ai_definition: "the employer sponsors a work visa", keywords: ["visa"] })));
    const confirm = signalsPrompt(shippedInterests((raw) => (rawCategory(raw, "T3").ai_confirm_only = true)));
    const versions = [definition?.version, added?.version, confirm?.version];
    for (const version of versions) expect(version).toMatch(/^signals-v2-[0-9a-f]{12}$/);
    expect(new Set(versions).size).toBe(3);
    expect(added?.system).toContain("- visa: the employer sponsors a work visa");
  });

  it("names the amount category in the amount rules and accepts only the AI categories", () => {
    const custom = shippedInterests((raw) => {
      rawCategories(raw).push({ id: "visa", kind: "keyword", label: { en: "Visa" }, color: "violet", ai_definition: "the employer sponsors a work visa", keywords: ["visa"] });
    });
    const spec = signalsPrompt(custom);
    expect(spec?.system).toContain('- T1 only: fill "amount"');
    const answer = (tier: string) => ({ signals: [{ tier, kind: "x", quote: "x", candidate: null, amount: null }], rejected: [] });
    expect(spec?.schema.safeParse(answer("visa")).success).toBe(true);
    expect(spec?.schema.safeParse(answer("tag")).success).toBe(false);
    expect(spec?.schema.safeParse(answer("T9")).success).toBe(false);
  });

  it("has no amount rules without an amount category, and no prompt without AI categories", () => {
    const keywordsOnly = promptCategories(shippedInterests()).filter((category) => category.kind === "keyword");
    expect(buildSignalsSystem(keywordsOnly)).toContain('- Set "amount" to null.');
    const tagsOnly = shippedInterests((raw) => {
      const categories = rawCategories(raw).filter((c) => c.kind === "tag");
      (raw.signals as { categories: unknown[] }).categories = categories;
    });
    expect(signalsPrompt(tagsOnly)).toBeNull();
  });
});
