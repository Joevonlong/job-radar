import { describe, expect, it } from "vitest";

import { AI_PROVIDER_IDS } from "@/lib/config/ai-options";
import { AI_VENDORS, accessOf, providerPath, vendorOf } from "@/lib/settings/ai-vendors";
import { ACTIONS_TAB, ADVANCED_TAB, CONFIG_PAGE_TABS, PAGE_TABS, SETTINGS_FILES } from "@/lib/settings/tabs";
import { SETTINGS_SECTIONS } from "@/lib/settings/fields";

describe("vendor grouping", () => {
  it("lists every provider exactly once, subscription CLI before API", () => {
    expect(AI_VENDORS.flatMap((v) => v.providers).toSorted()).toEqual([...AI_PROVIDER_IDS].toSorted());
    expect(AI_VENDORS.find((v) => v.id === "anthropic")?.providers).toEqual(["claude-cli", "anthropic"]);
    expect(vendorOf("codex-cli")).toBe("openai");
    expect(accessOf("claude-cli")).toBe("cli");
    expect(accessOf("anthropic")).toBe("api");
  });

  it("maps a provider to its draft keys", () => {
    expect(providerPath("claude-cli", "model")).toBe("providers.claude_cli.model");
    expect(providerPath("mimo", "enabled")).toBe("providers.mimo.enabled");
  });

  it("every AI section belongs to one of the four blocks", () => {
    for (const section of SETTINGS_SECTIONS.ai) expect(section.block, section.id).toBeDefined();
  });

  it("the operations tab follows the config tabs and edits no file", () => {
    expect(PAGE_TABS).toEqual([...CONFIG_PAGE_TABS, ACTIONS_TAB, ADVANCED_TAB]);
    expect(Object.keys(SETTINGS_FILES)).not.toContain(ACTIONS_TAB);
  });
});
