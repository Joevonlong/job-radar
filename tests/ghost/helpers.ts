import { ghostCheckDefaults, type GhostCheckConfig } from "@/lib/config/schemas/pipeline";
import { compileGhostRules, ghostRulesFor, type CompiledGhostRules } from "@/lib/ghost/rules";
import type { GhostInput, GhostPosting } from "@/lib/ghost/types";
import { emptyGhostPack, type GhostPack } from "@/lib/market/schema";

import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";

export const DAY_MS = 86_400_000;
export const NOW = new Date("2026-10-01T12:00:00Z");
export const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

/**
 * Rules built by the test: the schema's defaults for pipeline.yaml `job_checks.ghost` (edited) and a pack of the test's own
 * patterns (none by default). Nothing here reads the shipped config.
 */
export function rulesWith(edit: (settings: GhostCheckConfig) => void = () => {}, pack: Partial<GhostPack> = {}): CompiledGhostRules {
  const settings = ghostCheckDefaults();
  edit(settings);
  return compileGhostRules({ ghost: { ...emptyGhostPack(), ...pack }, job_checks: { ghost: settings } });
}

/** The fixture's effective rules (pipeline.yaml + the generic pack + the German pack). */
export const fixtureRules = (): CompiledGhostRules => ghostRulesFor(shippedPipeline(fixtureMarket()));

export function posting(over: Partial<GhostPosting> = {}): GhostPosting {
  return { channelId: "greenhouse", externalId: "1", firstSeenAt: daysAgo(10), locationLabel: "Berlin, Germany", stableIds: true, repostLabel: null, ...over };
}

/** A long JD with a duties heading: no thin_description. */
export const FULL_JD = ["About us", "We build software for logistics.", "Responsibilities", ...Array.from({ length: 30 }, (_, i) => `- Own piece number ${i} of the platform end to end.`)].join("\n");

export function input(over: Partial<GhostInput> = {}): GhostInput {
  return {
    jobId: 1,
    status: "active",
    firstSeenAt: daysAgo(10),
    trustedCompany: false,
    trustedPostedAt: null,
    description: FULL_JD,
    descriptionSource: { channelId: "greenhouse" },
    postings: [posting()],
    breakdownResponsibilities: null,
    ...over,
  };
}
