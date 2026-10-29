// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "@/lib/channels/logger";
import * as fresh from "@/lib/config/fresh";
import * as handlers from "@/lib/control/handlers";
import { processNextControlRequest } from "@/lib/control/poller";
import type { ControlHandler } from "@/lib/control/types";
import type { Db } from "@/lib/db/client";
import * as requests from "@/lib/db/repos/control-requests";
import { fakeRecorder } from "./helpers";

const db = {} as Db;
const request = (kind: requests.ControlRequestKind = "translate_job", payload: unknown = { jobId: 7 }): requests.ControlRequest => ({
  id: 9, kind, payload, status: "running", result: null, requestedAt: new Date(), startedAt: new Date(), finishedAt: null,
});

beforeEach(() => {
  vi.spyOn(fresh, "freshenConfig").mockReturnValue([]);
  vi.spyOn(requests, "claimNextControlRequest").mockResolvedValue(request());
  vi.spyOn(requests, "finishControlRequest").mockImplementation(async (_db, _id, outcome) => ({ ...request(), ...outcome }));
  vi.spyOn(requests, "requeueInterruptedControlRequests").mockResolvedValue({ requeued: 1, failed: 0 });
  vi.spyOn(requests, "getControlRequest").mockResolvedValue({ ...request(), status: "pending" });
  vi.spyOn(handlers, "getControlHandler").mockReturnValue(async () => ({ status: "done", result: {} }));
});
afterEach(() => vi.restoreAllMocks());

function setup(signal = new AbortController().signal) {
  const fake = fakeRecorder();
  return { ...fake, run: () => processNextControlRequest({ db, signal, logger: silentLogger, activity: fake.recorder, maxRequeues: () => 2 }) };
}

describe("control attempt activity", () => {
  it("creates no span for an empty poll", async () => {
    vi.mocked(requests.claimNextControlRequest).mockResolvedValue(null);
    const test = setup();
    expect(await test.run()).toBeNull();
    expect(test.spans).toEqual([]);
  });
  it("passes the recorder and job-linked attempt to the handler", async () => {
    const test = setup();
    const handler = vi.fn<ControlHandler>(async (_request, ctx) => {
      expect(ctx.recorder).toBe(test.recorder);
      expect(ctx.activity?.id).toBe(test.spans[0]?.handle.id);
      return { status: "done", result: {} };
    });
    vi.mocked(handlers.getControlHandler).mockReturnValue(handler);
    await test.run();
    expect(test.spans[0]).toMatchObject({ name: "request.translate_job", links: { jobId: 7, controlRequestId: 9 }, finishes: [["ok", undefined]] });
  });
  it.each([true, false])("links delegated requests only with a valid cycle id: %s", async (valid) => {
    const payload = { cycleId: valid ? 13 : "private", extra: "private" };
    vi.mocked(requests.claimNextControlRequest).mockResolvedValue(request("run_ai", payload));
    const test = setup();
    await test.run();
    const attempt = test.spans.find((s) => s.name === "request.run_ai");
    expect(attempt?.parentId).toBe(valid ? test.spans[0]?.handle.id : undefined);
    expect(attempt?.finishes).toEqual([["ok", undefined]]);
    expect(payload).toEqual({ cycleId: valid ? 13 : "private", extra: "private" });
  });
  it("discards a deferred cycle attempt without also finishing it", async () => {
    vi.mocked(requests.claimNextControlRequest).mockResolvedValue(request("run_cycle", {}));
    vi.mocked(handlers.getControlHandler).mockReturnValue(async (_request, ctx) => { ctx.activity?.discard(); return { status: "done", result: {} }; });
    const test = setup();
    await test.run();
    expect(test.spans[0]).toMatchObject({ deferred: true, discards: 1, finishes: [] });
  });
  it.each(["no_handler", "handler_error", "invalid_payload", "private https://private.test"])("records only the safe outcome code for %s", async (error) => {
    vi.mocked(handlers.getControlHandler).mockReturnValue(error === "no_handler" ? undefined : async () => {
      if (error === "handler_error") throw new Error("private");
      return { status: "failed", result: { error } };
    });
    const test = setup();
    await test.run();
    expect(test.spans[0]?.finishes).toEqual([["failed", { reasonCode: error.startsWith("private") ? "other" : error }]]);
  });
  it("finishes a shutdown requeue as interrupted without writing a terminal request outcome", async () => {
    vi.mocked(handlers.getControlHandler).mockReturnValue(async () => ({ status: "failed", result: { error: "aborted" } }));
    const test = setup(AbortSignal.abort());
    expect((await test.run())?.status).toBe("pending");
    expect(requests.finishControlRequest).not.toHaveBeenCalled();
    expect(test.spans[0]?.finishes).toEqual([["interrupted", undefined]]);
  });
  it.each(["finish", "requeue"])("preserves a %s write failure and closes as not recorded", async (operation) => {
    const error = new Error("private");
    if (operation === "finish") vi.mocked(requests.finishControlRequest).mockRejectedValue(error);
    else {
      vi.mocked(handlers.getControlHandler).mockReturnValue(async () => ({ status: "failed", result: { error: "aborted" } }));
      vi.mocked(requests.requeueInterruptedControlRequests).mockRejectedValue(error);
    }
    const test = setup(operation === "requeue" ? AbortSignal.abort() : new AbortController().signal);
    await expect(test.run()).rejects.toBe(error);
    expect(test.spans[0]?.finishes).toEqual([["interrupted", { reasonCode: "not_recorded" }]]);
  });
});
