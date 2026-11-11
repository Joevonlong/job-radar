// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, visibleCapabilities } from "@/lib/capabilities/registry";

describe("capability registry", () => {
  it("contains exactly one definition for each tool, in tool-list order", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(ids).toEqual(["search_jobs", "get_job", "get_job_raw", "list_applications", "get_profile", "get_interests", "preview_deal_breakers", "preview_interest_category", "get_today", "list_companies", "get_company", "get_insights", "get_application", "list_favorites", "get_application_context", "save_application_answer", "get_career_profile", "list_career_documents", "get_career_document", "check_career_document", "list_replies"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns each tool its data permission and operation kind", () => {
    expect(CAPABILITIES.map(({ id, permission, kind }) => ({ id, permission, kind }))).toEqual([
      { id: "search_jobs", permission: "jobs:read", kind: "read" },
      { id: "get_job", permission: "jobs:read", kind: "read" },
      { id: "get_job_raw", permission: "raw:read", kind: "read" },
      { id: "list_applications", permission: "tracking:read", kind: "read" },
      { id: "get_profile", permission: "profile:read", kind: "read" },
      { id: "get_interests", permission: "profile:read", kind: "read" },
      { id: "preview_deal_breakers", permission: "profile:read", kind: "read" },
      { id: "preview_interest_category", permission: "profile:read", kind: "read" },
      { id: "get_today", permission: "jobs:read", kind: "read" },
      { id: "list_companies", permission: "jobs:read", kind: "read" },
      { id: "get_company", permission: "jobs:read", kind: "read" },
      { id: "get_insights", permission: "jobs:read", kind: "read" },
      { id: "get_application", permission: "tracking:read", kind: "read" },
      { id: "list_favorites", permission: "tracking:read", kind: "read" },
      { id: "get_application_context", permission: "writer:read", kind: "read" },
      { id: "save_application_answer", permission: "writer:write", kind: "write" },
      { id: "get_career_profile", permission: "career:read", kind: "read" },
      { id: "list_career_documents", permission: "career:read", kind: "read" },
      { id: "get_career_document", permission: "career:read", kind: "read" },
      { id: "check_career_document", permission: "career:read", kind: "read" },
      { id: "list_replies", permission: "replies:read", kind: "read" },

    ]);
  });

  it("keeps one capability per source line in the registry array", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/capabilities/registry.ts"), "utf8");
    const entries = source.match(/export const CAPABILITIES[^=]*= \[([\s\S]*?)\];/)?.[1].trim().split("\n").map((line) => line.trim());
    expect(entries).toEqual(CAPABILITIES.map((capability) => `${capability.id},`));
  });
});

it("readers require their own permission and raw access stays separate", async () => {
  const { mcpSchema } = await import("@/lib/config/schemas/mcp");
  const { PERMISSION_PRESETS } = await import("@/lib/agent-access/permissions");
  const jobs = ["get_today", "list_companies", "get_company", "get_insights"];
  const tracking = ["get_application", "list_favorites"];
  for (const permission of ["jobs:read", "tracking:read", "notes:read", "raw:read"] as const) {
    const settings = mcpSchema.parse({ enabled: true, permissions: [permission], stdio: { permissions: [permission] } });
    const ids = visibleCapabilities(CAPABILITIES, { readSettings: () => settings }).map((item) => item.id);
    expect(ids.includes("get_job_raw")).toBe(permission === "raw:read");
    expect(ids.filter((id) => [...jobs, ...tracking].includes(id))).toEqual(permission === "jobs:read" ? jobs : permission === "tracking:read" ? tracking : []);
  }
  expect(PERMISSION_PRESETS.read_only).not.toContain("raw:read");
  expect(PERMISSION_PRESETS.assistant).not.toContain("raw:read");
  expect(CAPABILITIES.filter((item) => item.permission === "raw:read").map((item) => item.id)).toEqual(["get_job_raw"]);
});


it("offers raw only when explicitly granted, never through reader or assistant presets", async () => {
  const { mcpSchema } = await import("@/lib/config/schemas/mcp");
  const { PERMISSIONS, PERMISSION_PRESETS } = await import("@/lib/agent-access/permissions");
  for (const permissions of [PERMISSIONS.filter((p) => p !== "raw:read"), PERMISSION_PRESETS.read_only, PERMISSION_PRESETS.assistant]) {
    const settings = mcpSchema.parse({ enabled: true, permissions, stdio: { permissions } });
    expect(visibleCapabilities(CAPABILITIES, { readSettings: () => settings }).map((item) => item.id)).not.toContain("get_job_raw");
  }
  const settings = mcpSchema.parse({ enabled: true, permissions: ["raw:read"], stdio: { permissions: ["raw:read"] } });
  expect(visibleCapabilities(CAPABILITIES, { readSettings: () => settings }).map((item) => item.id)).toEqual(["get_job_raw"]);
  settings.stdio.permissions = ["jobs:read"];
  expect(visibleCapabilities(CAPABILITIES, { readSettings: () => settings })).toEqual([]);
});
