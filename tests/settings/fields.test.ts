import { describe, expect, it } from "vitest";

import { AI_API_PROVIDERS, AI_PROVIDER_IDS, AI_PROVIDER_KINDS, AI_TASK_NAMES, AI_TASK_PROVIDERS, CODEX_REASONING_EFFORTS } from "@/lib/config/ai-options";
import { configRegistry } from "@/lib/config/registry";
import { LINKEDIN_CHANNEL_IDS } from "@/lib/config/schemas/channels";
import { remoteScope } from "@/lib/config/schemas/common";
import { getAt } from "@/lib/settings/draft";
import { fieldPrefix, fieldsOf, HIDDEN_PATHS, LINKEDIN_CASCADE_OPTIONS, REMOTE_SCOPES, SETTINGS_SECTIONS } from "@/lib/settings/fields";
import { SETTINGS_FILES, SETTINGS_FORMS, type SettingsForm } from "@/lib/settings/tabs";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { shippedYaml } from "../config/helpers";
import { shippedConfig } from "./helpers";

/** Every path of the config tree that holds a value (arrays and scalars are leaves; so is an empty object such as `tasks.score: {}`, which its optional `order` field covers). */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [prefix];
    return entries.flatMap(([key, child]) => leafPaths(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return [prefix];
}

describe("the settings form covers the config files", () => {
  it("salary settings omit the removed benchmark lookup switch", () => {
    expect(fieldsOf("salary").map((field) => field.path)).not.toContain("benchmark.include_ai_lookups");
  });

  it.each(SETTINGS_FORMS)("%s: every key in the shipped YAML is a field or deliberately hidden", (tab) => {
    // Schema-only defaults need not be form fields; cover the keys actually written in the YAML.
    const config = shippedYaml(SETTINGS_FILES[tab]);
    const paths = fieldsOf(tab).map((def) => def.path);
    const hidden = HIDDEN_PATHS[tab];
    const uncovered = leafPaths(config).filter(
      (leaf) =>
        !paths.some((p) => leaf === p || leaf.startsWith(`${p}.`) || p.startsWith(`${leaf}.`)) &&
        !hidden.some((h) => leaf === h || leaf.startsWith(`${h}.`)),
    );
    expect(uncovered).toEqual([]);
  });

  it.each(SETTINGS_FORMS)("%s: every field points at a key that exists (or is optional)", (tab) => {
    const config = shippedConfig(tab);
    const missing = fieldsOf(tab).filter((def) => !def.optional && getAt(config, def.path) === undefined).map((def) => def.path);
    expect(missing).toEqual([]);
  });

  it.each(SETTINGS_FORMS)("%s: no field is listed twice", (tab) => {
    const paths = fieldsOf(tab).map((def) => def.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("the hidden paths exist in the shipped YAML", () => {
    for (const tab of SETTINGS_FORMS) {
      for (const hidden of HIDDEN_PATHS[tab]) expect(getAt(shippedConfig(tab), hidden), `${tab}:${hidden}`).toBeDefined();
    }
  });

  it("maps each tab to its config file", () => {
    for (const tab of SETTINGS_FORMS) expect(SETTINGS_FILES[tab]).toBe(configRegistry[tab].file);
  });

  it("option lists mirror the zod enums", () => {
    // The plain values of the remote scope (a region list is the other member of the union)
    expect([...REMOTE_SCOPES]).toEqual((remoteScope.options[0] as { options: readonly string[] }).options);
    expect([...LINKEDIN_CASCADE_OPTIONS]).toEqual([...LINKEDIN_CHANNEL_IDS]);
    const aiOrder = SETTINGS_SECTIONS.ai.flatMap((s) => s.fields).find((f) => f.path === "order");
    expect(aiOrder?.options).toEqual(configRegistry.ai.schema.shape.order.element.options);
    const apiOrder = SETTINGS_SECTIONS.ai.flatMap((s) => s.fields).find((f) => f.path === "api_order");
    expect(apiOrder?.options).toEqual(configRegistry.ai.schema.shape.api_order.element.options);
  });

  it("the AI choices come from config/ai-options.ts, the same lists the schema builds its enums from", () => {
    const aiFields = SETTINGS_SECTIONS.ai.flatMap((s) => s.fields);
    const byPath = (path: string) => aiFields.find((f) => f.path === path);
    expect(byPath("order")?.options).toBe(AI_PROVIDER_KINDS);
    expect(byPath("api_order")?.options).toBe(AI_API_PROVIDERS);
    for (const task of AI_TASK_NAMES) {
      expect(byPath(`tasks.${task}`)).toMatchObject({ kind: "route", optional: true, options: AI_TASK_PROVIDERS });
      expect(byPath(`providers.codex_cli.reasoning_effort_by_task.${task}`)).toMatchObject({ kind: "select", optional: true, options: CODEX_REASONING_EFFORTS });
    }
    expect(byPath("providers.codex_cli.reasoning_effort")).toMatchObject({ kind: "select", options: CODEX_REASONING_EFFORTS });
    const codex = configRegistry.ai.schema.shape.providers.shape.codex_cli.shape;
    expect(codex.reasoning_effort.options).toEqual([...CODEX_REASONING_EFFORTS]);
    expect(configRegistry.ai.schema.shape.tasks.shape.score.shape.order.unwrap().element.options).toEqual([...AI_TASK_PROVIDERS]);
  });

  it("the breakdown tab offers the modes of the schema (the head share has a field too)", () => {
    const mode = SETTINGS_SECTIONS.breakdown.flatMap((s) => s.fields).find((f) => f.path === "mode");
    expect(mode?.options).toEqual(configRegistry.breakdown.schema.shape.mode.options);
    expect(HIDDEN_PATHS.breakdown).toEqual([]);
    expect(SETTINGS_SECTIONS.breakdown.flatMap((s) => s.fields).some((f) => f.path === "jd_head_share")).toBe(true);
    expect(SETTINGS_FORMS.indexOf("breakdown")).toBe(SETTINGS_FORMS.indexOf("ai") + 1);
    expect(SETTINGS_SECTIONS.ai.flatMap((s) => s.fields).some((f) => f.path === "tasks.breakdown")).toBe(true);
  });

  it("every model field is a dropdown over its own provider's catalog; no tag box or price table is left", () => {
    const aiFields = SETTINGS_SECTIONS.ai.flatMap((s) => s.fields);
    const modelFields = aiFields.filter((f) => f.path.endsWith(".model") || f.path.endsWith(".strong_model"));
    expect(modelFields.length).toBe(9);
    const providerOf: Record<string, string> = { claude_cli: "claude-cli", codex_cli: "codex-cli", anthropic: "anthropic", openai: "openai", openrouter: "openrouter", deepseek: "deepseek", mimo: "mimo" };
    for (const field of modelFields) {
      expect(field.kind, field.path).toBe("model");
      expect(field.provider, field.path).toBe(providerOf[field.path.split(".")[1] ?? ""]);
    }
    expect(aiFields.some((f) => f.kind === "text" && /model/.test(f.path))).toBe(false);
    expect(aiFields.some((f) => (f.kind === "tags" && /model|price/.test(f.path)) || (f.kind as string) === "pricing")).toBe(false);
    expect(aiFields.some((f) => /\.models$|^pricing$/.test(f.path))).toBe(false);
  });

  it("each provider section shows its catalog, and codex efforts follow the codex model", () => {
    const sections = SETTINGS_SECTIONS.ai.filter((s) => s.catalogProvider !== undefined);
    expect(sections.map((s) => s.catalogProvider)).toEqual([...AI_PROVIDER_IDS]);
    for (const section of sections) expect(section.fields.some((f) => f.path === section.modelPath), section.id).toBe(true);
    const efforts = SETTINGS_SECTIONS.ai.flatMap((s) => s.fields).filter((f) => f.path.startsWith("providers.codex_cli.reasoning_effort"));
    expect(efforts.length).toBe(1 + AI_TASK_NAMES.length);
    for (const f of efforts) expect(f.effortModelPath).toBe("providers.codex_cli.model");
  });
});

describe("messages for the settings page", () => {
  const sections = zh.settings.sections as Record<string, string>;
  const fields = zh.settings.fields as Record<string, { label: string; hint?: string }>;

  it("has a title for every section and a label for every field", () => {
    for (const tab of SETTINGS_FORMS) {
      for (const section of SETTINGS_SECTIONS[tab]) {
        if ("section" in section.title) expect(sections[section.title.section], `${tab}:${section.id}`).toBeTruthy();
      }
      for (const def of fieldsOf(tab as SettingsForm)) expect(fields[def.label]?.label, `${tab}:${def.path}`).toBeTruthy();
    }
  });

  it("has no unused labels, hints for sections that do not exist, or one-language-only hints", () => {
    const used = new Set(SETTINGS_FORMS.flatMap((tab) => fieldsOf(tab).map((def) => def.label)));
    expect(Object.keys(fields).filter((id) => !used.has(id as never))).toEqual([]);
    for (const id of Object.keys(zh.settings.sectionHints)) expect(Object.keys(sections)).toContain(id);
    const enFields = en.settings.fields as Record<string, { hint?: string }>;
    for (const [id, entry] of Object.entries(fields)) expect(Boolean(enFields[id]?.hint), id).toBe(Boolean(entry.hint));
  });

  it("has an error message for every error key the form can produce", () => {
    for (const key of ["required", "number", "integer", "min", "atLeastOne", "greaterThan", "duplicates", "tooLong", "invalidChoice", "invalid", "url", "cron", "timezone", "clockTime", "country", "overBudgetCap", "delayOrder", "pollOrder", "axisOrder", "tickTooLarge", "warnOrder", "groupId", "modelNotInCatalog", "effortUnsupported", "taskModelsNeedOrder", "taskModelNotInOrder"]) {
      expect((zh.settings.errors as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

describe("fieldPrefix: the currency sign follows the field's currency", () => {
  it("dollar caps get $, euro fields get the euro sign, other numbers none", () => {
    expect(fieldPrefix("paid_total_monthly_budget_usd")).toBe("$");
    expect(fieldPrefix("linkedin.brightdata.monthly_budget_usd")).toBe("$");
    expect(fieldPrefix("sources.jsearch.overage_cost_per_request_usd")).toBe("$");
    expect(fieldPrefix("some.min_salary_eur")).toBe("€");
    expect(fieldPrefix("salary_floor_year")).toBeNull(); // in the base currency, which the key does not say
    expect(fieldPrefix("throttle.min_delay_ms")).toBeNull();
    expect(fieldPrefix("max_results")).toBeNull();
  });

  it("every shipped *_usd number field of the settings page has one", () => {
    const usd = Object.values(SETTINGS_SECTIONS).flatMap((sections) => sections.flatMap((section) => section.fields)).filter((field) => (field.kind === "number" || field.kind === "int") && /_usd$/.test(field.path));
    expect(usd.length).toBeGreaterThan(3);
    for (const field of usd) expect(fieldPrefix(field.path)).toBe("$");
  });
});
