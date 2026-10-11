// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";

const parse = (edit: (raw: Record<string, unknown>) => void) => {
  const raw = structuredClone(shippedYaml("ai.yaml"));
  edit(raw);
  return configRegistry.ai.schema.safeParse(raw);
};
const paths = (edit: (raw: Record<string, unknown>) => void): string[] => {
  const result = parse(edit);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("ai.yaml schema", () => {
  it("accepts the shipped file with CLI settings and timeouts", () => {
    const result = parse(() => {});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.providers.claude_cli.command).toBe("claude");
  });

  it("the old model lists and the pricing table are optional (accepted, never read)", () => {
    type Providers = Record<string, Record<string, unknown>>;
    expect(paths((raw) => {
      delete raw.pricing;
      for (const p of Object.values(raw.providers as Providers)) delete p.models;
    })).toEqual([]);
    expect(paths(() => {})).toEqual([]);
    // an unlisted model is no longer a schema problem: the check against models.yaml does that
    expect(paths((raw) => { (raw.providers as Providers).anthropic!.strong_model = "unlisted"; })).toEqual([]);
  });

  it("tasks.<t>.models needs the task's own order and only names providers listed in it", () => {
    const tasks = (raw: Record<string, unknown>) => raw.tasks as Record<string, Record<string, unknown>>;
    expect(paths((raw) => { tasks(raw).score = { models: { "claude-cli": "claude-haiku-4-5" } }; })).toEqual(["tasks.score.models"]);
    expect(paths((raw) => { tasks(raw).translate = { order: ["codex-cli", "api"], models: { "claude-cli": "claude-haiku-4-5" } }; })).toEqual(["tasks.translate.models.claude-cli"]);
    // the api layer expands to providers, but those cannot be named individually
    expect(paths((raw) => { tasks(raw).translate = { order: ["codex-cli", "api"], models: { deepseek: "deepseek-v4-pro" } }; })).toEqual(["tasks.translate.models.deepseek"]);
    expect(paths((raw) => { tasks(raw).translate = { order: ["codex-cli", "claude-cli", "api"], models: { "claude-cli": "claude-sonnet-5-5" } }; })).toEqual([]);
    expect(paths((raw) => { tasks(raw).translate = { order: ["deepseek"], models: { deepseek: "deepseek-v4-pro" } }; })).toEqual([]);
  });

  it("tasks.breakdown is optional (parsed as {}), may carry an order, and has its own codex effort", () => {
    const tasks = (raw: Record<string, unknown>) => raw.tasks as Record<string, Record<string, unknown>>;
    const withoutBreakdown = parse((raw) => { delete tasks(raw).breakdown; });
    expect(withoutBreakdown.success).toBe(true);
    if (withoutBreakdown.success) expect(withoutBreakdown.data.tasks.breakdown).toEqual({});
    expect(paths((raw) => { tasks(raw).breakdown = { order: ["claude-cli"] }; })).toEqual([]);
    expect(paths((raw) => { (raw.providers as Record<string, Record<string, unknown>>).codex_cli!.reasoning_effort_by_task = { breakdown: "low" }; })).toEqual([]);
  });

  it("rejects zero timeouts and unknown keys in a CLI block", () => {
    expect(paths((raw) => { (raw.providers as { codex_cli: { timeout_seconds: number } }).codex_cli.timeout_seconds = 0; })).toContain("providers.codex_cli.timeout_seconds");
    expect(paths((raw) => { (raw.providers as { claude_cli: Record<string, unknown> }).claude_cli.typo = 1; })).toContain("providers.claude_cli");
  });
});
