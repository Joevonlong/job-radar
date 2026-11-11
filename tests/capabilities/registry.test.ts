// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "@/lib/capabilities/registry";

describe("capability registry", () => {
  it("contains exactly one definition for each tool, in tool-list order", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(ids).toEqual(["search_jobs", "get_job", "list_applications", "get_profile", "get_interests", "preview_deal_breakers", "preview_interest_category", "get_application_context", "save_application_answer"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns each tool its data permission and operation kind", () => {
    expect(CAPABILITIES.map(({ id, permission, kind }) => ({ id, permission, kind }))).toEqual([
      { id: "search_jobs", permission: "jobs:read", kind: "read" },
      { id: "get_job", permission: "jobs:read", kind: "read" },
      { id: "list_applications", permission: "tracking:read", kind: "read" },
      { id: "get_profile", permission: "profile:read", kind: "read" },
      { id: "get_interests", permission: "profile:read", kind: "read" },
      { id: "preview_deal_breakers", permission: "profile:read", kind: "read" },
      { id: "preview_interest_category", permission: "profile:read", kind: "read" },
      { id: "get_application_context", permission: "writer:read", kind: "read" },
      { id: "save_application_answer", permission: "writer:write", kind: "write" },
    ]);
  });

  it("keeps one capability per source line in the registry array", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/capabilities/registry.ts"), "utf8");
    const entries = source.match(/export const CAPABILITIES[^=]*= \[([\s\S]*?)\];/)?.[1].trim().split("\n").map((line) => line.trim());
    expect(entries).toEqual(CAPABILITIES.map((capability) => `${capability.id},`));
  });
});
