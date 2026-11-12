// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { todayOutputFor } from "@/lib/mcp/dto/read-jobs";
import { getCompanyOutputFor, listCompaniesOutputFor } from "@/lib/mcp/dto/companies";
import { getApplicationOutputFor, listFavoritesOutputFor } from "@/lib/mcp/dto/read-tracking";
import { insightsOutputFor } from "@/lib/mcp/dto/insights";
import { listApplicationsOutputFor } from "@/lib/mcp/dto/tracking";
import { PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { mcpTranslator } from "@/lib/mcp/text";

const all = new Set(PERMISSIONS);
const schemas = { get_today: todayOutputFor(all), list_companies: listCompaniesOutputFor(all), get_company: getCompanyOutputFor(all), get_insights: insightsOutputFor(all), get_application: getApplicationOutputFor(all), list_favorites: listFavoritesOutputFor(all) };
function fields(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(fields);
  if (schema !== null && typeof schema === "object") {
    const value = schema as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["$schema", "description"].includes(key)).map(([key, entry]) => [key, fields(entry)]));
  }
  return schema;
}
describe("read DTO allow-lists", () => {
  for (const [name, schema] of Object.entries(schemas)) it(`${name} schema snapshot`, () => expect(fields(z.toJSONSchema(schema))).toMatchSnapshot());
  it.each([[], ["notes:read"], [...PERMISSIONS]] as const)("notes exist only with effective permission: %j", (...permissions) => {
    const grants = new Set(permissions);
    const application = z.toJSONSchema(getApplicationOutputFor(grants));
    const favorite = z.toJSONSchema(listFavoritesOutputFor(grants));
    const list = z.toJSONSchema(listApplicationsOutputFor(grants));
    expect(JSON.stringify(application).includes('"application_notes"')).toBe(grants.has("notes:read"));
    expect(JSON.stringify(favorite).includes('"favorite_note"')).toBe(grants.has("notes:read"));
    expect(JSON.stringify(list).includes('"application_notes"')).toBe(grants.has("notes:read"));
    expect(application.additionalProperties).toBe(false);
  });
  it.each([[["jobs:read"]], [["jobs:read", "tracking:read"]], [["jobs:read", "profile:read"]], [[...PERMISSIONS]]] as const)("tracking and profile fields follow effective permission: %j", (permissions) => {
    const grants = new Set<Permission>(permissions);
    const today = { notices: [], total: 0, returned: 0, truncated: false, view: null, quick: null, jobs: [] };
    const counts = { all: 1, high: 1, salary: 1 };
    expect(todayOutputFor(grants).safeParse({ ...today, quick_counts: counts }).success).toBe(!grants.has("tracking:read"));
    expect(todayOutputFor(grants).safeParse({ ...today, quick_counts: { ...counts, following: 1 } }).success).toBe(grants.has("tracking:read"));
    for (const schema of [listCompaniesOutputFor(grants), getCompanyOutputFor(grants)]) {
      const json = JSON.stringify(z.toJSONSchema(schema));
      expect(json.includes('"watched"')).toBe(grants.has("profile:read"));
      expect(json.includes('"blacklisted"')).toBe(grants.has("profile:read"));
    }
  });
  it("rejects additional and oversized parameters for every new tool", () => {
    const ctx = { text: mcpTranslator("en") };
    for (const [name] of Object.entries(schemas)) {
      const capability = CAPABILITIES.find((entry) => entry.id === name)!;
      const args = name === "get_company" ? { company_id: 1 } : name === "get_application" ? { job_id: 1 } : {};
      expect(capability.input(ctx).safeParse({ ...args, raw: true }).success).toBe(false);
      expect(capability.input(ctx).safeParse({ ...args, limit: 0 }).success).toBe(false);
    }
    expect(CAPABILITIES.find((entry) => entry.id === "get_today")!.input(ctx).safeParse({ view: "x".repeat(10000) }).success).toBe(false);
    expect(CAPABILITIES.find((entry) => entry.id === "list_companies")!.input(ctx).safeParse({ query: "x".repeat(10000) }).success).toBe(false);
  });
});
