// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { rulesFingerprint } from "@/lib/traps/fingerprint";

import { trapSettings } from "../traps/helpers";
import { shippedYaml } from "./helpers";

const parse = (raw: unknown) => configRegistry.traps.schema.safeParse(raw);

describe("traps.yaml schema", () => {
  it("accepts the shipped file", () => {
    expect(parse(shippedYaml("traps.yaml")).success).toBe(true);
  });

  it("rejects a pattern that does not compile, naming its path", () => {
    const raw = structuredClone(shippedYaml("traps.yaml")) as { instructions: Array<{ pattern: string }> };
    raw.instructions[0]!.pattern = "(unclosed";
    const result = parse(raw);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["instructions", 0, "pattern"]);
  });

  it("rejects duplicate ids, unknown keys and another config_version", () => {
    const dup = structuredClone(shippedYaml("traps.yaml")) as { instructions: Array<{ id: string }> };
    dup.instructions[1]!.id = dup.instructions[0]!.id;
    expect(parse(dup).success).toBe(false);
    expect(parse({ ...(shippedYaml("traps.yaml") as object), extra: 1 }).success).toBe(false);
    expect(parse({ ...(shippedYaml("traps.yaml") as object), config_version: 2 }).success).toBe(false);
  });

  it("ai.yaml parses without tasks.traps (it defaults to the global order)", () => {
    const ai = structuredClone(shippedYaml("ai.yaml")) as { tasks: Record<string, unknown> };
    delete ai.tasks.traps;
    const result = configRegistry.ai.schema.safeParse(ai);
    expect(result.success).toBe(true);
    expect(result.data?.tasks.traps).toEqual({});
  });

  it("the rules fingerprint follows the rules, not the switches", () => {
    const a = trapSettings();
    expect(rulesFingerprint(trapSettings((raw) => (raw.enabled = false)))).toBe(rulesFingerprint(a));
    expect(rulesFingerprint(trapSettings((raw) => ((raw.ai_check as Record<string, unknown>).mode = "all")))).toBe(rulesFingerprint(a));
    expect(rulesFingerprint(trapSettings((raw) => ((raw.scan as Record<string, unknown>).min_hidden_chars = 20)))).not.toBe(rulesFingerprint(a));
  });
});

describe("traps.yaml and the layered loader", () => {
  it("validates with or without config_version (the layered loader strips the key first)", () => {
    const raw = structuredClone(shippedYaml("traps.yaml")) as Record<string, unknown>;
    delete raw.config_version;
    expect(configRegistry.traps.schema.safeParse(raw).success).toBe(true);
  });
});
