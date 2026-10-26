// @vitest-environment node
import { describe, expect, it } from "vitest";

import { watchedCompanyBoards } from "@/lib/companies/watched-boards";

import { pipelineWith } from "../pipeline/helpers";

const pipeline = pipelineWith(() => {});
const board = (name: string, enabled = true) => ({ name, enabled });

describe("watchedCompanyBoards", () => {
  it("marks a company with an enabled board of the same company key", () => {
    const result = watchedCompanyBoards(["Anthropic Inc", "Google", "OpenAI"], [board("Anthropic"), board("openai")], pipeline);
    expect(result).toEqual([
      { name: "Anthropic Inc", key: "anthropic", hasBoard: true },
      { name: "Google", key: "google", hasBoard: false },
      { name: "OpenAI", key: "openai", hasBoard: true },
    ]);
  });

  it("matches a legal form and a spelling difference on the key, like the push step", () => {
    const result = watchedCompanyBoards(["Acme GmbH", "BETA"], [board("Acme"), board("Beta Inc.")], pipeline);
    expect(result.map((entry) => [entry.key, entry.hasBoard])).toEqual([
      ["acme", true],
      ["beta", true],
    ]);
  });

  it("does not count a disabled board", () => {
    expect(watchedCompanyBoards(["Acme"], [board("Acme", false)], pipeline)[0]?.hasBoard).toBe(false);
    expect(watchedCompanyBoards(["Acme"], [board("Acme", false), board("Acme GmbH", true)], pipeline)[0]?.hasBoard).toBe(true);
  });

  it("lists one entry per key, spelled as the list first writes it", () => {
    const result = watchedCompanyBoards(["Google", "google", "Google LLC", "Acme"], [], pipeline);
    expect(result.map((entry) => entry.name)).toEqual(["Google", "Acme"]);
  });

  it("is empty for an empty list and has no board without boards", () => {
    expect(watchedCompanyBoards([], [board("Acme")], pipeline)).toEqual([]);
    expect(watchedCompanyBoards(["Acme"], [], pipeline)[0]?.hasBoard).toBe(false);
  });
});
