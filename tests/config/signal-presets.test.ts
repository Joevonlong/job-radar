/** config/signal-presets.yaml — the schema, the shipped file, and that an expanded preset is a valid category. */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { configRegistry, interestsSchema, parseConfigText, type InterestsConfig } from "@/lib/config";
import { SIGNAL_PROBE_DEFAULTS } from "@/lib/config/schemas/interests";
import { signalPresetsSchema, type SignalPreset } from "@/lib/config/schemas/signal-presets";
import { presetToDraft } from "@/lib/interests/presets";
import { configToDraft, draftToCandidate, newCategoryDraft } from "@/lib/interests/vocabulary-draft";
import { signalPatternIsFast } from "@/lib/signals/pattern-guard";

import { FIXTURE_DEFAULTS_DIR, REPO_DEFAULTS_DIR, shippedYaml } from "./helpers";
import { candidatesOf, shippedInterests } from "../signals/helpers";

const fixturePresets = (): SignalPreset[] => signalPresetsSchema.parse(shippedYaml("signal-presets.yaml")).presets;
const preset = (id: string): SignalPreset => {
  const found = fixturePresets().find((entry) => entry.id === id);
  if (!found) throw new Error(`no preset ${id} in the fixture`);
  return found;
};

/** The fixture's interests.yaml with `p` added as the dialog adds it (English + German words). */
function withPreset(p: SignalPreset, current: InterestsConfig = shippedInterests()): InterestsConfig {
  const draft = configToDraft(current);
  const expanded = presetToDraft(p, { languages: ["en", "de"] });
  const added = newCategoryDraft({ id: expanded.id, kind: "keyword", labelZh: expanded.labelZh, labelEn: expanded.labelEn, color: expanded.color }, expanded);
  const merged = draftToCandidate({ ...draft, categories: [...draft.categories, added] }, current);
  if (typeof merged === "string") throw new Error(merged);
  expect(merged.fieldErrors).toEqual([]);
  return interestsSchema.parse(merged.candidate);
}

describe("signal-presets.yaml", () => {
  it("the repository's shipped file and the fixture copy pass the schema", () => {
    for (const dir of [REPO_DEFAULTS_DIR, FIXTURE_DEFAULTS_DIR]) {
      const file = path.join(dir, "signal-presets.yaml");
      expect(() => parseConfigText("signalPresets", fs.readFileSync(file, "utf8"), file)).not.toThrow();
    }
    expect(configRegistry.signalPresets.kind).toBe("shipped");
  });

  it("every shipped and fixture preset pattern and exclusion passes the interest probe in every language", () => {
    const isFast = signalPatternIsFast({ ...SIGNAL_PROBE_DEFAULTS });
    for (const dir of [REPO_DEFAULTS_DIR, FIXTURE_DEFAULTS_DIR]) {
      const file = path.join(dir, "signal-presets.yaml");
      const { presets } = parseConfigText("signalPresets", fs.readFileSync(file, "utf8"), file);
      for (const preset of presets) {
        for (const field of ["patterns", "exclude"] as const) {
          for (const [language, patterns] of Object.entries(preset[field])) {
            for (const pattern of patterns) expect(isFast(pattern), `${preset.id}.${field}.${language}: ${pattern}`).toBe(true);
          }
        }
      }
    }
  });

  it("rejects duplicate ids, a bad language code, a broken pattern and a preset without a name", () => {
    const base = { id: "a1", label: { en: "A" }, color: "violet", ai_definition: "something" };
    expect(signalPresetsSchema.safeParse({ presets: [base, { ...base, id: "A1" }] }).success).toBe(false);
    expect(signalPresetsSchema.safeParse({ presets: [{ ...base, keywords: { eng: ["x"] } }] }).success).toBe(false);
    expect(signalPresetsSchema.safeParse({ presets: [{ ...base, patterns: { en: ["(unclosed"] } }] }).success).toBe(false);
    expect(signalPresetsSchema.safeParse({ presets: [{ ...base, label: {} }] }).success).toBe(false);
    expect(signalPresetsSchema.safeParse({ presets: [base] }).success).toBe(true);
  });

  it("every fixture preset, expanded, is a valid interests.yaml category", () => {
    for (const p of fixturePresets()) {
      const config = withPreset(p);
      const category = config.signals.categories.find((entry) => entry.id === p.id);
      expect(category?.kind).toBe("keyword");
      expect(category?.ai_definition).toBe(p.ai_definition);
    }
  });
});

describe("the ai_tools_budget preset on job descriptions", () => {
  const config = withPreset(preset("ai_tools_budget"));
  const hits = (text: string) => candidatesOf(text, config).filter((candidate) => candidate.tier === "ai_tools_budget");

  it.each([
    "Benefits: unlimited tokens for Claude and ChatGPT, plus a learning budget.",
    "Every engineer gets seats for GitHub Copilot and Cursor paid by us.",
    "We offer a generous AI usage budget for your daily work.",
    "Wir bieten Zugang zu GitHub Copilot und Claude für alle Entwickler.",
    "Ein KI-Budget von 200 € im Monat steht dir zur Verfügung.",
    "Unbegrenzte Tokens für deine KI-Tools.",
  ])("finds: %s", (text) => {
    expect(hits(text)).not.toHaveLength(0);
  });

  it.each([
    "You have experience with GitHub Copilot or Cursor.",
    "We build AI products for the insurance market.",
    "Our research team publishes on large language models.",
    "Du hast Erfahrung mit GitHub Copilot und anderen KI-Tools.",
    "Wir entwickeln KI-Lösungen für den Mittelstand.",
    "Kenntnisse in ChatGPT-Prompting sind ein Plus.",
  ])("does not find: %s", (text) => {
    expect(hits(text)).toHaveLength(0);
  });
});
