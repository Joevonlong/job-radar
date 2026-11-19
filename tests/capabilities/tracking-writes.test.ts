// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { CAPABILITIES, visibleCapabilities } from "@/lib/capabilities/registry";
import { mark_applied } from "@/lib/capabilities/tracking/mark-applied";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import * as days from "@/lib/insights/range";
import { defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

const names = ["set_application_status", "mark_applied", "set_next_action", "set_interview_rounds", "undo_change"];
const writes = CAPABILITIES.filter((cap) => names.includes(cap.id));
const db = {} as Db;
function context(granted: boolean, global: boolean, connected: boolean) {
  const settings = mcpSchema.parse({ enabled: true, permissions: global ? ["tracking:write"] : [], stdio: { permissions: granted ? ["tracking:write"] : [] } });
  return defaultContext(db, settings, { trackingWriteDb: connected ? db : null, text: mcpTranslator("en"), readSettings: () => settings });
}

describe("tracking write tool boundary", () => {
  it.each([[false, true, true], [true, false, true], [true, true, false]])("hides tools with grant %s, global permission %s and connection %s", async (granted, global, connected) => {
    expect(await visibleCapabilities(writes, context(granted, global, connected))).toEqual([]);
  });
  it("offers all writes with effective permission and a connection, independently of the writer", async () => {
    expect((await visibleCapabilities(writes, context(true, true, true))).map((cap) => cap.id)).toEqual(names);
    for (const cap of writes) expect(cap.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });
  it("rejects caller spoofing, invalid ids, invalid dates, statuses and rounds", () => {
    const ctx = context(true, true, true);
    const inputs: Record<string, unknown> = {
      set_application_status: { job_id: 1, status: "applied" }, mark_applied: { job_id: 1 },
      set_next_action: { job_id: 1, next_action: "Send", next_action_date: null }, set_interview_rounds: { job_id: 1, rounds: 3 }, undo_change: { audit_id: 1 },
    };
    for (const cap of writes) {
      expect(cap.input(ctx).safeParse(inputs[cap.id]).success).toBe(true);
      expect(cap.input(ctx).safeParse({ ...inputs[cap.id] as object, caller: "stdio" }).success).toBe(false);
    }
    const bad: Record<string, unknown> = {
      set_application_status: { job_id: 1, status: "invented" }, mark_applied: { job_id: 0 },
      set_next_action: { job_id: 1, next_action: "Send", next_action_date: "2026-02-30" }, set_interview_rounds: { job_id: 1, rounds: -1 }, undo_change: { audit_id: 1.5 },
    };
    for (const cap of writes) expect(cap.input(ctx).safeParse(bad[cap.id]).success).toBe(false);
  });
});

describe("mark_applied input", () => {
  const now = () => new Date("2026-11-18T16:30:00Z");
  const text = mcpTranslator("en");
  const input = (zone = "Asia/Tokyo") => mark_applied.input({ ...context(true, true, true), now, timezone: () => zone });

  it.each([
    ["2026-11-12", "2026-11-11T15:00:00Z"],
    ["2026-11-19", "2026-11-18T15:00:00Z"],
    ["2026-11-12T09:30:00+01:00", "2026-11-12T08:30:00Z"],
    ["2026-11-18T16:30:00Z", "2026-11-18T16:30:00Z"],
  ])("resolves %s to the application instant", (applied_at, expected) => {
    expect(input().parse({ job_id: 1, applied_at }).applied_at).toEqual(new Date(expected));
  });

  it.each(["2026-11-12T09:30:00", "2026-11-12T09:30+01:00", "2026-02-30"])("reports the expected format for %s", (applied_at) => {
    expect(input().safeParse({ job_id: 1, applied_at })).toMatchObject({
      success: false, error: { issues: [{ path: ["applied_at"], message: text("errors.appliedAtFormat") }] },
    });
  });

  it.each(["2026-11-20", "2026-11-18T17:30:00.001+01:00"])("rejects the future value %s", (applied_at) => {
    expect(input().safeParse({ job_id: 1, applied_at })).toMatchObject({
      success: false, error: { issues: [{ path: ["applied_at"], message: text("errors.appliedAtFuture") }] },
    });
  });

  it.each([
    ["0000-01-01", "UTC"],
    ["0000-01-01T00:00:00+01:00", "UTC"],
    ["1969-12-31", "UTC"],
    ["1970-01-01", "Asia/Tokyo"],
    ["1970-01-01T00:59:59.999+01:00", "UTC"],
  ])("rejects %s in %s when its instant precedes the minimum", (applied_at, zone) => {
    expect(input(zone).safeParse({ job_id: 1, applied_at })).toMatchObject({
      success: false, error: { issues: [{ path: ["applied_at"], message: expect.stringContaining("1970-01-01T00:00:00Z") }] },
    });
  });

  it.each(["1970-01-01", "1969-12-31T19:00:00-05:00"])("accepts %s at the minimum UTC instant", (applied_at) => {
    expect(input("UTC").parse({ job_id: 1, applied_at }).applied_at).toEqual(new Date("1970-01-01T00:00:00Z"));
  });

  it("reports the expected format when the schedule zone skipped the date", () => {
    expect(input("Pacific/Apia").safeParse({ job_id: 1, applied_at: "2011-12-30" })).toMatchObject({
      success: false, error: { issues: [{ path: ["applied_at"], message: text("errors.appliedAtFormat") }] },
    });
  });

  it("reports a calendar conversion error as a format error", () => {
    const startOfDay = vi.spyOn(days, "startOfDayInZone").mockImplementationOnce(() => { throw new RangeError("invalid calendar day"); });
    try {
      expect(input().safeParse({ job_id: 1, applied_at: "2026-11-12" })).toMatchObject({
        success: false, error: { issues: [{ path: ["applied_at"], message: text("errors.appliedAtFormat") }] },
      });
    } finally {
      startOfDay.mockRestore();
    }
  });

  it("reports an unreadable schedule zone without exposing the loader error", () => {
    const schema = mark_applied.input({
      ...context(true, true, true), now, timezone: () => { throw new Error("private schedule path"); },
    });
    expect(schema.safeParse({ job_id: 1, applied_at: "2026-11-12" })).toMatchObject({
      success: false, error: { issues: [{ path: ["applied_at"], message: text("errors.appliedAtTimezone") }] },
    });
    expect(schema.parse({ job_id: 1, applied_at: "2026-11-12T00:00:00Z" }).applied_at).toEqual(new Date("2026-11-12T00:00:00Z"));
  });

  it("trims a reference before checking its length and leaves omitted values absent", () => {
    const schema = input();
    const reference = "x".repeat(200);
    expect(schema.parse({ job_id: 1, reference: `  ${reference}\n` })).toEqual({ job_id: 1, reference });
    const unicode = "📩".repeat(200);
    expect(schema.parse({ job_id: 1, reference: unicode }).reference).toBe(unicode);
    expect(schema.parse({ job_id: 1 })).toEqual({ job_id: 1 });
    for (const invalid of [" \t ", "x".repeat(201), `${unicode}📩`]) {
      expect(schema.safeParse({ job_id: 1, reference: invalid })).toMatchObject({
        success: false, error: { issues: [{ path: ["reference"], message: text("errors.appliedReferenceLength", { max: 200 }) }] },
      });
    }
  });

  it("rejects null characters before the value can reach Postgres", () => {
    expect(input().safeParse({ job_id: 1, reference: "receipt\0number" })).toMatchObject({
      success: false, error: { issues: [{ path: ["reference"], message: text("errors.appliedReferenceNul") }] },
    });
  });
});
