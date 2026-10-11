// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readGhostSettings } from "@/lib/ghost/settings";

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
