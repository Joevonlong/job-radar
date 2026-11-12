import { afterEach, describe, expect, it } from "vitest";

import { agentActivityRowSchema, parseAgentActivityQuery, rangeStart, registerUndoLoader, toActivityRow } from "@/lib/agent-access/activity";
import type { AgentCallListRow } from "@/lib/db/repos/agent-calls";
import { agentCalls } from "@/lib/db/schema";
import { AGENT_ACTIVITY_DEFAULTS, uiSchema } from "@/lib/config/schemas/ui";

afterEach(() => registerUndoLoader(null));

const row: AgentCallListRow = {
  id: 7,
  calledAt: new Date("2026-11-11T10:00:00Z"),
  cursorAt: "2026-11-11T10:00:00.000000Z",
  caller: "token:3",
  tokenId: 3,
  tokenName: "Laptop",
  tokenRevoked: true,
  transport: "http",
  capability: "get_job",
  targetType: "application",
  targetId: 5,
  jobId: 12,
  jobTitle: "Backend Engineer",
  company: "Example GmbH",
  outcome: "error",
  errorCategory: "timeout",
  returnedCount: 0,
  durationMs: 31,
};

describe("the activity URL query", () => {
  it("keeps valid filters and drops anything else", () => {
    expect(parseAgentActivityQuery({ connection: "stdio", tool: "get_job", result: "error", range: "30d", before: "2026-11-11T10:00:00.123456Z~9" })).toEqual({
      connection: "stdio",
      tool: "get_job",
      result: "error",
      range: "30d",
      before: "2026-11-11T10:00:00.123456Z~9",
    });
    expect(parseAgentActivityQuery({ connection: "12" }).connection).toBe(12);
    expect(parseAgentActivityQuery({ connection: "12; drop", tool: "A B", result: "nope", range: "year", before: "yesterday" })).toEqual({});
    expect(parseAgentActivityQuery({ before: "2026-13-45T99:00:00.000000Z~1" }).before).toBeUndefined();
    expect(parseAgentActivityQuery({ before: "2026-02-31T10:00:00.000000Z~1" }).before).toBeUndefined();
    expect(parseAgentActivityQuery({ tool: ["get_job", "x"] }).tool).toBe("get_job");
  });

  it("offers exactly the results the audit table allows", () => {
    for (const outcome of agentCalls.outcome.enumValues) expect(parseAgentActivityQuery({ result: outcome }).result).toBe(outcome);
  });
});

describe("the activity view model", () => {
  it("has a fixed field set with no arguments or content", () => {
    const model = toActivityRow(row, undefined, new Map([["get_job", "read"]]));
    expect(Object.keys(model).sort()).toEqual(["calledAt", "connection", "durationMs", "errorCategory", "id", "outcome", "returnedCount", "target", "tool", "toolKind", "undo"]);
    expect(Object.keys(model.connection).sort()).toEqual(["kind", "name", "revoked", "tokenId"]);
    expect(Object.keys(model.target ?? {}).sort()).toEqual(["company", "id", "jobId", "title", "type"]);
    expect(model.undo).toBeNull();
    expect(model.connection).toEqual({ kind: "token", tokenId: 3, name: "Laptop", revoked: true });
  });

  it("rejects an extra field", () => {
    expect(() => agentActivityRowSchema.parse({ ...toActivityRow(row, undefined), arguments: { q: "x" } })).toThrow();
  });

  it("fills undo only from a loader's answer", () => {
    expect(toActivityRow(row, "undoable").undo).toEqual({ state: "undoable" });
    expect(toActivityRow({ ...row, caller: "stdio", tokenId: null, tokenName: null, tokenRevoked: false }, undefined).connection.kind).toBe("stdio");
  });
});

describe("rangeStart", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  it("counts today from local midnight and the other ranges back from now", () => {
    expect(rangeStart("today", now, "Europe/Berlin")?.toISOString()).toBe("2026-11-10T23:00:00.000Z");
    expect(rangeStart("7d", now, "UTC")?.toISOString()).toBe("2026-11-04T12:00:00.000Z");
    expect(rangeStart("30d", now, "UTC")?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(rangeStart("all", now, "UTC")).toBeUndefined();
  });
});

describe("ui.yaml agent_activity", () => {
  it("has defaults and bounds", () => {
    expect(AGENT_ACTIVITY_DEFAULTS).toEqual({ page_size: 50, default_range: "7d" });
    const base = uiSchema.shape.agent_activity;
    expect(base.parse(undefined)).toEqual(AGENT_ACTIVITY_DEFAULTS);
    expect(base.parse({ page_size: 500 }).default_range).toBe("7d");
    expect(base.safeParse({ page_size: 0 }).success).toBe(false);
    expect(base.safeParse({ page_size: 501 }).success).toBe(false);
    expect(base.safeParse({ default_range: "year" }).success).toBe(false);
  });
});
