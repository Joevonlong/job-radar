// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authorize } from "@/lib/agent-access/authorize";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { budgetRefusalText } from "@/lib/capabilities/actions/run-action";
import { mcpSchema, AGENT_ACTIONS } from "@/lib/config/schemas/mcp";
import { writerSchema } from "@/lib/config";
import { SCORE_JOBS_MAX_IDS } from "@/lib/control/types";
import { auditFailure, ToolFailure } from "@/lib/mcp/context";
import { actionOutput, requestStatusOutput, toRequestSummary } from "@/lib/mcp/dto/actions";
import { mcpTranslator } from "@/lib/mcp/text";

const text = mcpTranslator("en");
const input = (name: string) => CAPABILITIES.find((cap) => cap.id === name)!.input({ text });

describe("action input boundaries", () => {
  it.each([{}, { job_ids: [], backlog: true }, { job_ids: [1], backlog: true }, { backlog: false }, { job_ids: [0] }, { job_ids: Array.from({ length: SCORE_JOBS_MAX_IDS + 1 }, (_, i) => i + 1) }, { job_ids: [1], caller: "stdio" }])("rejects invalid scoring selection %j", (args) => {
    expect(input("score_jobs").safeParse(args).success).toBe(false);
  });
  it.each([{ job_ids: [1] }, { backlog: true }, { job_ids: Array.from({ length: SCORE_JOBS_MAX_IDS }, (_, i) => i + 1) }])("accepts a bounded exclusive scoring selection %j", (args) => {
    expect(input("score_jobs").safeParse(args).success).toBe(true);
  });
  it("bounds collection channels and reuses their trimming and backfill bounds", () => {
    expect(input("run_collection").parse({ channel_ids: [" fixture "] })).toEqual({ channel_ids: ["fixture"] });
    for (const args of [{ channel_ids: [] }, { channel_ids: Array(51).fill("fixture") }, { channel_ids: ["x".repeat(65)] }, { backfill_hours: 0 }]) expect(input("run_collection").safeParse(args).success).toBe(false);
  });
  it("bounds ids, defaults force and rejects caller injection on job tools", () => {
    for (const name of ["translate_job", "breakdown_job", "research_salary", "research_company"]) {
      expect(input(name).parse({ job_id: 1 })).toEqual({ job_id: 1, force: false });
      for (const args of [{ job_id: 0 }, { job_id: -1 }, { job_id: 1.2 }, { job_id: 1, caller: 5 }]) expect(input(name).safeParse(args).success).toBe(false);
    }
  });
  it("requires polish text and option and reads the configured text bound", () => {
    const schema = CAPABILITIES.find((cap) => cap.id === "draft_answer")!.input({ text, writer: { writeDb: null, inputs: () => ({ writer: writerSchema.parse({ draft_max_chars: 500 }), me: null, stories: [], storiesUnreadable: false, breakdownEnabled: false }) } });
    const args = { job_id: 1, question_id: 2, mode: "polish", option: "language_only", text: "A draft" };
    expect(schema.safeParse(args).success).toBe(true);
    for (const bad of [{ ...args, text: undefined }, { ...args, option: undefined }, { ...args, option: "other" }, { ...args, text: "x".repeat(501) }, { ...args, mode: "draft" }]) expect(schema.safeParse(bad).success).toBe(false);
    expect(schema.safeParse({ job_id: 1, question_id: 2, mode: "draft" }).success).toBe(true);
  });
  it("offers descriptions for every action input in both languages", () => {
    for (const locale of ["en", "zh"] as const) for (const cap of CAPABILITIES.filter((item) => item.permission === "actions:run")) {
      const schema = cap.input({ text: mcpTranslator(locale) });
      for (const field of Object.values(schema.shape)) expect(field.description).toBeTruthy();
    }
  });
});

it("names each missing additional permission in the effective intersection", () => {
  for (const [tool, permission] of [["draft_answer", "writer:write"], ["tailor_resume", "career:write"]] as const) {
    const cap = CAPABILITIES.find((item) => item.id === tool)!;
    for (const settings of [
      mcpSchema.parse({ enabled: true, permissions: ["actions:run"], stdio: { permissions: ["actions:run", permission] } }),
      mcpSchema.parse({ enabled: true, permissions: ["actions:run", permission], stdio: { permissions: ["actions:run"] } }),
    ]) expect(authorize(cap, () => settings)).toEqual({ allowed: false, reason: "missing_permission", permission });
    const settings = mcpSchema.parse({ enabled: true, permissions: ["actions:run", permission], stdio: { permissions: ["actions:run", permission] } });
    expect(authorize(cap, () => settings).allowed).toBe(true);
  }
});

it("reports the action, cap, remaining jobs and local reset, including the shared total", () => {
  for (const locale of ["en", "zh"] as const) {
    const ctx = { text: mcpTranslator(locale), timezone: () => "Europe/Berlin" };
    const refusal = { action: "score_jobs" as const, cap: 300, used: 290, remaining: 10, requested: 20, resetsAt: new Date("2026-11-11T23:00:00Z") };
    const message = budgetRefusalText(ctx, { ...refusal, reason: "caller_cap" });
    for (const value of ["score_jobs", "300", "10", "20", "2026-11-12 00:00", "Europe/Berlin"]) expect(message).toContain(value);
    const total = budgetRefusalText(ctx, { ...refusal, reason: "total_cap", cap: 200, remaining: 0, requested: 1 });
    expect(total).toContain("200");
    expect(total).toContain(locale === "en" ? "requests across all agents" : "所有 agent");
  }
});

it("audits over budget separately with no error category", () => {
  expect(auditFailure(new ToolFailure("over_budget", "private"))).toEqual({ outcome: "over_budget", error_category: null });
  expect(auditFailure(new ToolFailure("busy", "private"))).toEqual({ outcome: "error", error_category: "busy" });
});

it("allows only action metadata and strips text even from result.error", () => {
  const result = toRequestSummary({ error: "SECRET-TEXT", detail: "SECRET-TEXT", payload: { text: "SECRET-TEXT" }, scored: 2, failed: 1, remaining: 4, resumeAt: "2026-11-12T00:00:00Z", stopped: "time_budget", provider: "SECRET-TEXT" });
  expect(result).toMatchObject({ error: "other", scored: 2, failed: 1, remaining: 4, resume_at: "2026-11-12T00:00:00Z", stopped: "time_budget" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(toRequestSummary({ error: "quota_guard", scored: -1, resumeAt: "PRIVATE" })).toEqual({ error: "quota_guard" });
  const status = { request_id: 1, status: "done", ahead: null, worker_online: null, requested_at: "2026-11-11T00:00:00Z", started_at: null, finished_at: null, result, cycle: null, notices: [] };
  expect(requestStatusOutput.safeParse(status).success).toBe(true);
  expect(requestStatusOutput.safeParse({ ...status, payload: "SECRET" }).success).toBe(false);
  for (const action of AGENT_ACTIONS) {
    const response = { request_id: null, state: "cached", existing: false, budget: { action, remaining: 2, resets_at: "2026-11-12T00:00:00Z" }, notices: [] };
    expect(actionOutput.safeParse(response).success).toBe(true);
    expect(actionOutput.safeParse({ ...response, translation: "SECRET" }).success).toBe(false);
  }
});
