// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CAPABILITIES, visibleCapabilities } from "@/lib/capabilities/registry";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
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
