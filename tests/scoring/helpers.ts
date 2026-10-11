import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { configRegistry, type AiConfig, type MeConfig, type PreferencesConfig } from "@/lib/config";

import { pinnedAi } from "../ai/helpers";

const EXAMPLE = path.resolve(import.meta.dirname, "../fixtures/config/defaults/profile.example");

export const ME_SUMMARY = "AI engineer with 8 years of experience building LLM products.";

/** me.yaml of the shipped example (en C1, de B1, es native) with a summary and a skill filled in. */
export function exampleMe(edit: (raw: Record<string, unknown>) => void = () => {}): MeConfig {
  const raw = parse(fs.readFileSync(path.join(EXAMPLE, "me.yaml"), "utf8")) as Record<string, unknown>;
  raw.summary = ME_SUMMARY;
  raw.skills = [{ name: "Python", years: 6 }, { name: "RAG", years: null }];
  raw.years_experience = 8;
  edit(raw);
  return configRegistry.me.schema.parse(raw);
}

export function examplePreferences(edit: (raw: Record<string, unknown>) => void = () => {}): PreferencesConfig {
  const { config_version: _version, ...raw } = parse(fs.readFileSync(path.join(EXAMPLE, "preferences.yaml"), "utf8")) as Record<string, unknown>;
  void _version;
  edit(raw);
  return configRegistry.preferences.schema.parse(raw);
}

export const aiConfig = (edit?: (raw: Record<string, unknown>) => void): AiConfig => pinnedAi(edit);

/** A valid model answer; `edit` changes single fields. */
export function answer(edit: Record<string, unknown> = {}): string {
  return JSON.stringify({
    score: 80,
    fit_reasons: ["匹配理由一", "匹配理由二"],
    gaps: ["差距一"],
    german_level_required: "unknown",
    summary_zh: "一个 AI 工程师岗位。",
    summary_en: "An AI engineer role.",
    ...edit,
  });
}
