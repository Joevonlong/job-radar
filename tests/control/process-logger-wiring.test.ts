// @vitest-environment node
/**
 * The web's module-level control logger follows the configured level, and the providers built for the AI test button and
 * for requests outside a cycle get a logger (their debug records need one to reach the output).
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { resetLogLevelResolver } from "@/lib/logging/process-logger";

import { pinnedAi, scriptedProvider } from "../ai/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";

const providerCalls: Array<{ deps: unknown }> = [];
vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/providers")>();
  return {
    ...actual,
    createDefaultProviders: (config: AiConfig, deps: unknown) => {
      providerCalls.push({ deps });
      return [scriptedProvider("claude-cli", ['{"answer":"ok"}']).provider];
    },
  };
});

vi.mock("@/lib/db/repos/breakdowns", () => ({
  getJobForBreakdown: async () => ({ id: 7, description: "A job description." }),
  getJobBreakdown: async () => null,
}));
vi.mock("@/lib/db/repos/control-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/repos/control-requests")>()),
  findOpenJobControlRequest: async () => null,
  insertControlRequest: async () => ({ id: 42, kind: "breakdown_job" }),
}));

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  providerCalls.length = 0;
  delete process.env.JOB_RADAR_LOG_LEVEL;
  resetLogLevelResolver();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLogLevelResolver();
  tmp.cleanup();
});

function writeLevel(level: string): void {
  const text = fs.readFileSync(path.join(tmp.defaultsDir, "schedule.yaml"), "utf8");
  fs.writeFileSync(path.join(tmp.configDir, "schedule.yaml"), `${text}\nlogging:\n  level: ${level}\n`);
}

const db = {} as Db;

describe("web control logger", () => {
  async function queueBreakdown(): Promise<string[]> {
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { requestBreakdownJob } = await import("@/lib/control/breakdown-request");
    const outcome = await requestBreakdownJob(db, { jobId: 7, force: false, settings: { state: "ok", config: { enabled: true } as never } });
    expect(outcome).toEqual({ state: "queued", requestId: 42, existing: false });
    return out.mock.calls.map(([line]) => String(line));
  }

  it("writes its info record at the default level", async () => {
    expect(await queueBreakdown()).toEqual([expect.stringContaining("INFO manual request queued")]);
  });

  it("suppresses it when the config says warn", async () => {
    writeLevel("warn");
    expect(await queueBreakdown()).toEqual([]);
  });

  it("suppresses it when JOB_RADAR_LOG_LEVEL says warn", async () => {
    process.env.JOB_RADAR_LOG_LEVEL = "warn";
    try {
      expect(await queueBreakdown()).toEqual([]);
    } finally {
      delete process.env.JOB_RADAR_LOG_LEVEL;
    }
  });

  it("reads no config when the module is imported", async () => {
    vi.resetModules();
    const read = vi.spyOn(fs, "readFileSync");
    await import("@/lib/control/breakdown-request");
    await import("@/lib/control/service");
    await import("@/lib/control/salary-request");
    expect(read.mock.calls.filter(([file]) => String(file).startsWith(tmp.root))).toEqual([]);
  });
});

describe("providers get a logger", () => {
  it("the AI test button passes the request's logger", async () => {
    const { createTestAiHandler } = await import("@/lib/control/test-ai");
    const { createMemoryHealthStore } = await import("@/lib/ai/health");
    const { createMemoryUsageStore } = await import("@/lib/ai/usage");
    const handler = createTestAiHandler({ config: pinnedAi(), timeZone: "UTC", usage: () => createMemoryUsageStore(), health: () => createMemoryHealthStore() });
    const outcome = await handler(
      { id: 1, kind: "test_ai", payload: { provider: "claude-cli" }, status: "running", result: null, requestedAt: new Date(), startedAt: new Date(), finishedAt: null },
      { db, signal: new AbortController().signal, logger: quietLogger },
    );
    expect(outcome.status).toBe("done");
    expect(providerCalls).toEqual([{ deps: { logger: quietLogger } }]);
  });

  it("the request router passes its logger", async () => {
    const { createRequestRouter } = await import("@/lib/translation/router");
    createRequestRouter(db, quietLogger, { config: pinnedAi(), timeZone: "UTC", quota: null });
    expect(providerCalls).toEqual([{ deps: { logger: quietLogger } }]);
  });
});
