// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import type { GhostInputRow, GhostSourceRow } from "@/lib/db/repos/ghost";
import { buildGhostInput, ghostChannels, type GhostChannel } from "@/lib/ghost/inputs";
import { descriptionHash } from "@/lib/translation/hash";

import { daysAgo } from "./helpers";

const parsed = (postedAt: Date | null) => ({ postedAt }) as unknown as ReturnType<GhostChannel["parse"]>;

const ats: GhostChannel = {
  id: "ats",
  stableExternalIds: true,
  fullDescription: true,
  trustedPostedAt: true,
  parse: (payload) => {
    const at = (payload as { posted?: string }).posted;
    if (at === "broken") throw new Error("bad payload");
    return parsed(at ? new Date(at) : null);
  },
};
const board: GhostChannel = { id: "board", parse: () => parsed(daysAgo(999)) };
const session: GhostChannel = {
  id: "session",
  stableExternalIds: true,
  fullDescription: true,
  parse: () => parsed(null),
  repostLabel: (payload) => (payload as { label?: string }).label ?? null,
};
const channels = ghostChannels([board, session, ats]);

const source = (over: Partial<GhostSourceRow> = {}): GhostSourceRow => ({ channelId: "ats", externalId: "1", firstSeenAt: daysAgo(20), locationLabel: "Berlin", priority: 1, payload: null, ...over });
const row = (over: Partial<GhostInputRow> = {}): GhostInputRow => ({
  jobId: 7,
  status: "active",
  firstSeenAt: daysAgo(20),
  description: "Some text.",
  companyNameNorm: "acme",
  sources: [source()],
  breakdown: null,
  ...over,
});

describe("ghostChannels", () => {
  it("collects the declarations and the channels whose payloads are read", () => {
    expect([...channels.stableIds].sort()).toEqual(["ats", "session"]);
    expect([...channels.trustedPostedAt]).toEqual(["ats"]);
    expect(channels.payloadChannels).toEqual(["ats", "session"]);
  });

  it("the key changes when a declaration changes", () => {
    expect(ghostChannels([board, session, ats]).key).toBe(channels.key);
    expect(ghostChannels([{ ...board, fullDescription: true }, session, ats]).key).not.toBe(channels.key);
  });
});

describe("buildGhostInput", () => {
  it("the earliest posted date a trusted channel reads; unreadable payloads and untrusted channels give nothing", () => {
    const input = buildGhostInput(
      row({
        sources: [
          source({ externalId: "1", payload: { posted: "2026-05-01T00:00:00Z" } }),
          source({ externalId: "2", payload: { posted: "2026-03-01T00:00:00Z" } }),
          source({ externalId: "3", payload: { posted: "broken" } }),
          source({ channelId: "board", externalId: "4", payload: {} }),
        ],
      }),
      channels,
      new Set(),
    );
    expect(input.trustedPostedAt).toEqual({ at: new Date("2026-03-01T00:00:00Z"), channelId: "ats" });
    expect(input.postings.map((p) => [p.channelId, p.stableIds])).toEqual([
      ["ats", true],
      ["ats", true],
      ["ats", true],
      ["board", false],
    ]);
  });

  it("the repost label of a channel that reports one", () => {
    const input = buildGhostInput(row({ sources: [source({ channelId: "session", payload: { label: "Reposted 3 days ago" } })] }), channels, new Set());
    expect(input.postings[0]?.repostLabel).toBe("Reposted 3 days ago");
  });

  it("the description is judged only when every best-priority source keeps the full text", () => {
    expect(buildGhostInput(row(), channels, new Set()).descriptionSource).toEqual({ channelId: "ats" });
    expect(buildGhostInput(row({ sources: [source(), source({ channelId: "board", priority: 1 })] }), channels, new Set()).descriptionSource).toBeNull();
    expect(buildGhostInput(row({ sources: [source(), source({ channelId: "board", priority: 2 })] }), channels, new Set()).descriptionSource).toEqual({ channelId: "ats" });
    expect(buildGhostInput(row({ description: "  " }), channels, new Set()).descriptionSource).toBeNull();
  });

  it("trusted companies by normalized name", () => {
    expect(buildGhostInput(row(), channels, new Set(["acme"])).trustedCompany).toBe(true);
    expect(buildGhostInput(row({ companyNameNorm: null }), channels, new Set(["acme"])).trustedCompany).toBe(false);
  });

  it("the breakdown counts only for the current description", () => {
    const content = {
      responsibilities: [{ text: "Build", quote: "Some", offset: 0 }],
      tech_stack: [],
      experience: { years_min: null, years_quote: null, items: [] },
      projects: [],
      soft_skills: [],
      languages: [],
      other: [],
    };
    const current = { sourceHash: descriptionHash("Some text."), promptVersion: BREAKDOWN_PROMPT_VERSION, content };
    expect(buildGhostInput(row({ breakdown: current }), channels, new Set()).breakdownResponsibilities).toBe(1);
    expect(buildGhostInput(row({ breakdown: { ...current, sourceHash: descriptionHash("Older text.") } }), channels, new Set()).breakdownResponsibilities).toBeNull();
    expect(buildGhostInput(row({ breakdown: { ...current, promptVersion: "v0-unknown" } }), channels, new Set()).breakdownResponsibilities).toBeNull();
  });
});
