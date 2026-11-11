// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, visibleCapabilities } from "@/lib/capabilities/registry";

describe("capability registry", () => {
  it("contains exactly one definition for each tool, in tool-list order", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(ids).toEqual(["search_jobs", "get_job", "list_applications", "get_today", "list_companies", "get_company", "get_insights", "get_application", "list_favorites", "get_application_context", "save_application_answer", "set_application_status", "mark_applied", "set_next_action", "set_interview_rounds", "undo_change"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns each tool its data permission and operation kind", () => {
    expect(CAPABILITIES.map(({ id, permission, kind }) => ({ id, permission, kind }))).toEqual([
      { id: "search_jobs", permission: "jobs:read", kind: "read" },
      { id: "get_job", permission: "jobs:read", kind: "read" },
      { id: "list_applications", permission: "tracking:read", kind: "read" },
      { id: "get_today", permission: "jobs:read", kind: "read" },
      { id: "list_companies", permission: "jobs:read", kind: "read" },
      { id: "get_company", permission: "jobs:read", kind: "read" },
      { id: "get_insights", permission: "jobs:read", kind: "read" },
      { id: "get_application", permission: "tracking:read", kind: "read" },
      { id: "list_favorites", permission: "tracking:read", kind: "read" },
      { id: "get_application_context", permission: "writer:read", kind: "read" },
      { id: "save_application_answer", permission: "writer:write", kind: "write" },
      { id: "set_application_status", permission: "tracking:write", kind: "write" },
      { id: "mark_applied", permission: "tracking:write", kind: "write" },
      { id: "set_next_action", permission: "tracking:write", kind: "write" },
      { id: "set_interview_rounds", permission: "tracking:write", kind: "write" },
      { id: "undo_change", permission: "tracking:write", kind: "write" },
    ]);
  });

  it("keeps one capability per source line in the registry array", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/capabilities/registry.ts"), "utf8");
    const entries = source.match(/export const CAPABILITIES[^=]*= \[([\s\S]*?)\];/)?.[1].trim().split("\n").map((line) => line.trim());
    expect(entries).toEqual(CAPABILITIES.map((capability) => `${capability.id},`));
  });
});

it("new readers require their area permission, never raw, and presets still exclude raw", async () => {
  const { mcpSchema } = await import("@/lib/config/schemas/mcp");
  const { PERMISSION_PRESETS } = await import("@/lib/agent-access/permissions");
  const jobs = ["get_today", "list_companies", "get_company", "get_insights"];
  const tracking = ["get_application", "list_favorites"];
  for (const permission of ["jobs:read", "tracking:read", "notes:read", "raw:read"] as const) {
    const settings = mcpSchema.parse({ enabled: true, permissions: [permission], stdio: { permissions: [permission] } });
    const ids = visibleCapabilities(CAPABILITIES, { readSettings: () => settings }).map((item) => item.id);
    expect(ids.filter((id) => [...jobs, ...tracking].includes(id))).toEqual(permission === "jobs:read" ? jobs : permission === "tracking:read" ? tracking : []);
  }
  expect(PERMISSION_PRESETS.read_only).not.toContain("raw:read");
  expect(PERMISSION_PRESETS.assistant).not.toContain("raw:read");
  expect(CAPABILITIES.some((item) => item.permission === "raw:read")).toBe(false);
});
