// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiProviderError, AiUnavailableError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import { createBreakdownJobHandler } from "@/lib/control/breakdown-job";
import { BREAKDOWN_ERROR_CODES } from "@/lib/control/breakdown-request";
import type { ControlHandlerContext } from "@/lib/control/types";
import { ConfigError, type BreakdownConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { ControlRequest } from "@/lib/db/repos/control-requests";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";

import { quietLogger } from "../cycle/helpers";

const runBreakdown = vi.hoisted(() => vi.fn());
vi.mock("@/lib/breakdown/service", () => ({ runBreakdown }));

const settings = (over: Partial<BreakdownConfig> = {}): BreakdownConfig => ({ enabled: true, mode: "manual", auto: { min_rank: 80, per_cycle_limit: 5 }, jd_max_chars: 12000, jd_head_share: 0.7, timeout_seconds: 240, ...over });
const context: ControlHandlerContext = { db: {} as Db, signal: new AbortController().signal, logger: quietLogger };
const request = (payload: unknown): ControlRequest => ({ id: 1, kind: "breakdown_job", payload, status: "running", result: null, requestedAt: new Date(), startedAt: new Date(), finishedAt: null });
const router = {} as AiRouter;
const handler = (loadSettings: () => BreakdownConfig = () => settings()) => createBreakdownJobHandler({ createRouter: () => router, loadSettings });

beforeEach(() => {
  runBreakdown.mockReset();
});

describe("breakdown_job handler", () => {
  it("fails an invalid payload", async () => {
    expect(await handler()(request({ jobId: "x" }), context)).toEqual({ status: "failed", result: { error: "invalid_payload" } });
    expect(await handler()(request({ jobId: 3, extra: 1 }), context)).toEqual({ status: "failed", result: { error: "invalid_payload" } });
  });

  it("fails with config_error when breakdown.yaml cannot be read, and with disabled when it was turned off after queueing", async () => {
    const broken = handler(() => {
      throw new ConfigError({ configName: "breakdown", filePath: "breakdown.yaml", kind: "schema" });
    });
    expect(await broken(request({ jobId: 3 }), context)).toEqual({ status: "failed", result: { jobId: 3, error: "config_error" } });
    expect(await handler(() => settings({ enabled: false }))(request({ jobId: 3 }), context)).toEqual({ status: "failed", result: { jobId: 3, error: "disabled" } });
    expect(runBreakdown).not.toHaveBeenCalled();
  });

  it("reports what the run did", async () => {
    runBreakdown.mockResolvedValue({ status: "done", cached: false, provider: "codex-cli", model: "gpt-5.5", items: 9, dropped: 1 });
    const outcome = await handler()(request({ jobId: 3, force: true }), context);
    expect(outcome).toEqual({ status: "done", result: { jobId: 3, cached: false, provider: "codex-cli", model: "gpt-5.5", items: 9, dropped: 1 } });
    expect(runBreakdown).toHaveBeenCalledWith(context.db, router, 3, expect.objectContaining({ force: true, settings: settings() }));
    runBreakdown.mockResolvedValue({ status: "failed", error: "no_verified_quotes" });
    expect(await handler()(request({ jobId: 3 }), context)).toEqual({ status: "failed", result: { jobId: 3, error: "no_verified_quotes" } });
  });

  it("maps an abort and AI failures to codes the card has labels for, with a sanitized detail", async () => {
    runBreakdown.mockRejectedValue(new AiProviderError("codex-cli", "aborted", "stopped"));
    expect(await handler()(request({ jobId: 3 }), context)).toEqual({ status: "failed", result: { jobId: 3, error: "aborted" } });
    runBreakdown.mockRejectedValue(new AiUnavailableError("breakdown", [{ provider: "codex-cli", outcome: "failed", kind: "timeout", message: "sk-ant-abcdefghijklmnopqrstuvwx leaked" }]));
    const outcome = await handler()(request({ jobId: 3 }), context);
    expect(outcome.status).toBe("failed");
    expect(outcome.result.error).toBe("timeout");
    expect(TRANSLATION_FAILURE_CODES).toContain(outcome.result.error);
    expect(BREAKDOWN_ERROR_CODES).toContain(outcome.result.error);
    expect(outcome.result.detail).toBe("codex-cli: timeout");
    runBreakdown.mockImplementation(async () => {
      throw new Error("weird");
    });
    const weird = await handler()(request({ jobId: 3 }), context);
    expect(weird.result.error).toBe("failed");
  });
});
