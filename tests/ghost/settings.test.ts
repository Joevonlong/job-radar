// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ghostTrustedKeys, readGhostSettings } from "@/lib/ghost/settings";
import { resolveCompanyName } from "@/lib/pipeline/company";

import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";

describe("readGhostSettings", () => {
  it("reads ui.yaml job_checks.ghost", () => {
    expect(readGhostSettings(() => ({ job_checks: { ghost: { enabled: true, trusted_companies: ["Acme"] } } }))).toEqual({ enabled: true, trusted_companies: ["Acme"] });
  });

  it("is off when ui.yaml cannot be read", () => {
    expect(
      readGhostSettings(() => {
        throw new Error("broken ui.yaml");
      }),
    ).toEqual({ enabled: false, trusted_companies: [] });
  });
});

describe("ghostTrustedKeys", () => {
  const pipeline = () => shippedPipeline(fixtureMarket());
  const trusted = (...names: string[]) => () => ({ enabled: true, trusted_companies: names });

  it("turns raw names into the companies.name_norm keys the pipeline stores (legal suffix and case dropped, one key each)", () => {
    const key = resolveCompanyName("Acme", pipeline()).nameNorm;
    expect(key).not.toBe("");
    expect(ghostTrustedKeys(pipeline, trusted("ACME GmbH", "Acme", "  acme  "))).toEqual([key]);
  });

  it("is empty with no trusted companies, or when the pipeline config cannot be read", () => {
    expect(ghostTrustedKeys(pipeline, trusted())).toEqual([]);
    expect(
      ghostTrustedKeys(() => {
        throw new Error("no market");
      }, trusted("ACME GmbH")),
    ).toEqual([]);
  });
});
