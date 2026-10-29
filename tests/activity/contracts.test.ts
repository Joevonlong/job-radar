// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { activityErrorCode, AI_ERROR_CODES, BACKUP_ERROR_CODES, CONTROL_ERROR_CODES, SAFE_ERROR_CODES, safeErrorCode } from "@/lib/activity/error-codes";
import { newId, rootIdForCycle } from "@/lib/activity/ids";
import { SPAN_NAMES, REASON_CODES, reasonCodeSchema } from "@/lib/activity/names";
import { activityParamsSchema } from "@/lib/activity/params";
import { AiProviderError, AiUnavailableError, type AiProviderErrorKind } from "@/lib/ai/errors";
import { ChannelError } from "@/lib/channels/errors";
import { CHANNEL_ERROR_CODES } from "@/lib/channels/types";
import type { UnavailableReason } from "@/lib/channels/cascade";
import { CYCLE_STEP_NAMES } from "@/lib/cycle/steps";
import { registerBuiltinAiSubtasks } from "@/lib/cycle/builtin-steps";
import { listAiSubtasks, resetAiSubtasks } from "@/lib/ai/step";
import { controlRequestKindEnum } from "@/lib/db/schema";
import { BackupError, type BackupErrorCode } from "@/lib/ops/backup";
import { TimeoutError } from "@/lib/ops/timeout";
import { TranslationIncompleteError } from "@/lib/translation/errors";
import { SCORE_SUBTASK_NAME } from "@/lib/scoring/score-task";
import { TRAPS_SUBTASK_NAME } from "@/lib/traps/ai-check";
import { TRANSLATE_SUBTASK_NAME } from "@/lib/translation/subtask";
import { BREAKDOWN_SUBTASK_NAME } from "@/lib/breakdown/subtask";

describe("activity contracts", () => {
  it("accepts the backfill limit reason through the reason-code contract", () => {
    expect(reasonCodeSchema.parse("backfill_over_limit")).toBe("backfill_over_limit");
    expect(safeErrorCode("backfill_over_limit")).toBe("backfill_over_limit");
    expect(CONTROL_ERROR_CODES).not.toContain("backfill_over_limit");
    expect(CONTROL_ERROR_CODES).toEqual(expect.arrayContaining(["backfillOverLimit", "cycleBusy"]));
  });
  it("keeps literal span names in sync with their owners", () => {
    expect(SPAN_NAMES.filter((name) => name.startsWith("step.") && name !== "step.ai_late")).toEqual(CYCLE_STEP_NAMES.map((name) => `step.${name}`));
    expect(SPAN_NAMES.filter((name) => name.startsWith("request."))).toEqual(controlRequestKindEnum.enumValues.map((name) => `request.${name}`));
    // Signals registers its literal inline; the other four subtasks expose constants.
    expect(SPAN_NAMES.filter((name) => name.startsWith("ai."))).toEqual([SCORE_SUBTASK_NAME, "signals", TRAPS_SUBTASK_NAME, TRANSLATE_SUBTASK_NAME, BREAKDOWN_SUBTASK_NAME].map((name) => `ai.${name}`));
    resetAiSubtasks();
    try {
      registerBuiltinAiSubtasks();
      expect(SPAN_NAMES.filter((name) => name.startsWith("ai.")).sort()).toEqual(listAiSubtasks().map((task) => `ai.${task.name}`).sort());
    } finally { resetAiSubtasks(); }
    const availability: Record<UnavailableReason, true> = { not_registered: true, disabled: true, not_configured: true, budget_exceeded: true, circuit_open: true };
    expect(REASON_CODES).toEqual(expect.arrayContaining(Object.keys(availability)));
  });
  it("covers every provider/backup kind and control error literal", () => {
    const ai: Record<AiProviderErrorKind, true> = { not_configured: true, auth: true, rate_limited: true, timeout: true, network: true, provider_error: true, invalid_output: true, budget: true, aborted: true };
    const backup: Record<BackupErrorCode, true> = { invalid_url: true, start_failed: true, pg_dump_failed: true, timeout: true, aborted: true, invalid_output: true, io: true };
    expect([...AI_ERROR_CODES].sort()).toEqual(Object.keys(ai).sort());
    expect([...BACKUP_ERROR_CODES].sort()).toEqual(Object.keys(backup).sort());
    for (const file of fs.readdirSync("src/lib/control").filter((file) => file.endsWith(".ts"))) {
      for (const match of fs.readFileSync(`src/lib/control/${file}`, "utf8").matchAll(/error: "([A-Za-z_]+)"/g)) expect(SAFE_ERROR_CODES).toContain(match[1]);
    }
    expect(SAFE_ERROR_CODES).toEqual(expect.arrayContaining([...CHANNEL_ERROR_CODES, ...REASON_CODES]));
  });
  it("has stable cycle UUIDs, correct version/variant and random event UUIDs", () => {
    expect(rootIdForCycle(42)).toBe(rootIdForCycle(42));
    expect(rootIdForCycle(42)).not.toBe(rootIdForCycle(43));
    expect(rootIdForCycle(42)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newId()).not.toBe(newId());
  });
  it.each([
    { url: "https://example.test/?secret=1" }, { spaced: "two words" }, { long: "a".repeat(65) },
    { nested: { count: 1 } }, { fractional: 1.1 }, { unsafe: Number.MAX_SAFE_INTEGER + 1 },
    { "bad key": true }, Object.fromEntries(Array.from({ length: 13 }, (_, n) => [`key${n}`, n])),
  ])("rejects the entire unsafe parameter object %j", (params) => {
    expect(activityParamsSchema.safeParse(params).success).toBe(false);
  });
  it("accepts only short ids, safe integers and booleans", () => {
    expect(activityParamsSchema.parse({ "query.id": "abc-1:def_2", count: -3, skipped: true })).toEqual({ "query.id": "abc-1:def_2", count: -3, skipped: true });
  });
  it("classifies errors without ever reading their messages", () => {
    const errors: [Error, string][] = [
      [new AiProviderError("codex-cli", "auth", "private"), "auth"], [new AiUnavailableError("score", []), "ai_unavailable"],
      [new TranslationIncompleteError({ code: "failed", message: "private", providerWide: false }, 1, 2), "translation_incomplete"],
      [new TimeoutError("private", 1), "timeout"], [new ChannelError("blocked", "private"), "blocked"], [new BackupError("private", "io"), "io"], [new Error("private"), "error"],
    ];
    for (const [error, expected] of errors) {
      Object.defineProperty(error, "message", { get() { throw new Error("message was read"); } });
      expect(activityErrorCode(error)).toBe(expected);
    }
    expect(activityErrorCode(null)).toBe("error");
    expect(safeErrorCode("private https://example.test")).toBe("other");
    expect(safeErrorCode({})).toBe("other");
    expect(safeErrorCode("not_recorded")).toBe("not_recorded");
  });
});
