import { describe, expect, it } from "vitest";

import { aiDisclosure } from "@/lib/ai/disclosure";

import { pinnedAi } from "./helpers";

const rowOf = (rows: ReturnType<typeof aiDisclosure>, task: string) => rows.find((r) => r.task === task);

describe("aiDisclosure (which providers may receive job text, per task)", () => {
  it("lists every AI task once, in the effective order, with the api layer expanded", () => {
    const rows = aiDisclosure(pinnedAi());
    expect(rows.map((r) => r.task)).toEqual(["score", "signals", "translate", "summarize", "suggest", "breakdown", "traps", "salary_lookup", "write"]);
    expect(rowOf(rows, "score")?.providers).toEqual(["codex-cli", "claude-cli", "anthropic", "deepseek", "mimo"]);
  });

  it("follows a task's own order and api_order, not a fixed list", () => {
    const config = pinnedAi((raw) => {
      raw.api_order = ["mimo", "anthropic", "deepseek"];
      (raw.tasks as Record<string, unknown>).translate = { order: ["deepseek", "api", "codex-cli"] };
    });
    const rows = aiDisclosure(config);
    expect(rowOf(rows, "translate")?.providers).toEqual(["deepseek", "mimo", "anthropic", "codex-cli"]);
    expect(rowOf(rows, "suggest")?.providers).toEqual(["codex-cli", "claude-cli", "mimo", "anthropic", "deepseek"]);
  });

  it("leaves out providers that are switched off", () => {
    const config = pinnedAi((raw) => {
      const providers = raw.providers as Record<string, { enabled?: boolean }>;
      for (const key of ["deepseek", "mimo", "claude_cli"]) providers[key] = { ...providers[key], enabled: false };
    });
    expect(rowOf(aiDisclosure(config), "score")?.providers).toEqual(["codex-cli", "anthropic"]);
  });

  it("reports a task with no enabled provider as empty", () => {
    const config = pinnedAi((raw) => {
      const providers = raw.providers as Record<string, { enabled?: boolean }>;
      for (const key of ["claude_cli", "codex_cli", "anthropic", "deepseek", "mimo"]) providers[key] = { ...providers[key], enabled: false };
    });
    for (const row of aiDisclosure(config)) expect(row.providers).toEqual([]);
  });

  it("lists only providers that can search the web for the web task", () => {
    const config = pinnedAi((raw) => {
      (raw.tasks as Record<string, unknown>).salary_lookup = { order: ["deepseek", "claude-cli", "mimo", "anthropic", "codex-cli"] };
    });
    const row = rowOf(aiDisclosure(config), "salary_lookup");
    expect(row?.web).toBe(true);
    expect(row?.providers).toEqual(["claude-cli", "anthropic", "codex-cli"]);
    expect(rowOf(aiDisclosure(config), "score")?.web).toBe(false);
  });
});
