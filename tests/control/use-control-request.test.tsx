import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useControlRequest, type ControlRequestRead, type UseControlRequestOptions } from "@/components/control/use-control-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { STATUS_POLL_MS } from "@/lib/settings/constants";

type Read = ControlRequestRead<{ n: number }, string, string>;

const queue = (over: Partial<ControlQueueView> = {}, online = true): ControlQueueView => ({
  ahead: 0,
  running: null,
  startedAt: null,
  now: "2026-10-28T12:00:00.000Z",
  worker: { process: "ai-worker", online, heartbeatAgeSeconds: online ? 3 : 900 },
  ...over,
});
const waiting = (n: number, over: Partial<ControlQueueView> = {}, online = true, stage: "pending" | "running" = "pending"): Read => ({ state: "waiting", stage, queue: queue(over, online), waiting: { n } });

/** Let the pending read promise settle and React render. */
const flush = () => act(async () => {});
const tick = (ms: number = STATUS_POLL_MS) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function setup(read: (id: number) => Promise<Read>, initial: Partial<UseControlRequestOptions<{ n: number }, string, string>> = {}) {
  const onDone = vi.fn();
  const onFailed = vi.fn();
  const readMock = vi.fn(read);
  const hook = renderHook((props: { requestId: number | null }) => useControlRequest({ requestId: props.requestId, read: readMock, onDone, onFailed, ...initial }), {
    initialProps: { requestId: 7 as number | null },
  });
  return { ...hook, read: readMock, onDone, onFailed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useControlRequest", () => {
  it("reads once at mount, then every poll interval; the initial state shows until the first answer", async () => {
    let resolve: (value: Read) => void = () => {};
    const { result, read } = setup(() => new Promise<Read>((r) => (resolve = r)), { initialStage: "running", initialQueue: queue({ ahead: 4 }) });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(7);
    expect(result.current).toMatchObject({ stage: "running", queue: { ahead: 4 }, waiting: null, offline: false });
    await act(async () => resolve(waiting(1, { ahead: 2 })));
    expect(result.current).toMatchObject({ stage: "pending", queue: { ahead: 2 }, waiting: { n: 1 } });
    read.mockResolvedValue(waiting(2));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps polling a request that is pending for 90 minutes while the worker is online, and never reports a failure", async () => {
    const { result, read, onFailed, onDone } = setup(async () => waiting(1, { ahead: 3 }));
    await flush();
    await tick(90 * 60 * 1000);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual((90 * 60 * 1000) / STATUS_POLL_MS);
    expect(onFailed).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ stage: "pending", offline: false, queue: { ahead: 3 } });
  });

  it("a request running for 90 minutes still shows its start, and is not offline", async () => {
    const startedAt = "2026-10-28T10:30:00.000Z";
    const { result, onFailed } = setup(async () => waiting(1, { startedAt, now: "2026-10-28T12:00:00.000Z" }, true, "running"));
    await flush();
    await tick(90 * 60 * 1000);
    expect(result.current).toMatchObject({ stage: "running", offline: false, queue: { startedAt } });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("is offline while the worker has no fresh heartbeat, keeps polling, and recovers when it is back", async () => {
    const { result, read } = setup(async () => waiting(1, {}, false));
    await flush();
    expect(result.current.offline).toBe(true);
    await tick();
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    read.mockResolvedValue(waiting(2, {}, true));
    await tick();
    expect(result.current.offline).toBe(false);
  });

  it("returns the newest waiting payload", async () => {
    const answers = [waiting(1), waiting(2), waiting(3)];
    const { result } = setup(async () => answers.shift() ?? waiting(3));
    await flush();
    expect(result.current.waiting).toEqual({ n: 1 });
    await tick();
    await tick();
    expect(result.current.waiting).toEqual({ n: 3 });
  });

  it.each([
    ["done", { state: "done", done: "ok" } as Read, "onDone", ["ok"]],
    ["failed", { state: "failed", failed: "boom" } as Read, "onFailed", ["boom", { n: 1 }]],
    ["missing", { state: "missing" } as Read, "onFailed", [null, { n: 1 }]],
  ] as const)("%s: one callback, then no more reads", async (_name, end, callback, args) => {
    const answers: Read[] = [waiting(1), end];
    const hook = setup(async () => answers.shift() ?? end);
    await flush();
    await tick();
    expect(hook[callback]).toHaveBeenCalledTimes(1);
    expect(hook[callback]).toHaveBeenCalledWith(...args);
    await tick(10 * STATUS_POLL_MS);
    expect(hook.read).toHaveBeenCalledTimes(2);
    expect(hook[callback]).toHaveBeenCalledTimes(1);
  });

  it("a read that gives nothing (or throws) is tried again on the next tick", async () => {
    const answers: Array<Read | Error> = [null, new Error("network"), waiting(1)];
    const { result, read, onFailed } = setup(async () => {
      const next = answers.length > 0 ? answers.shift() : waiting(1);
      if (next instanceof Error) throw next;
      return next ?? null;
    });
    await flush();
    expect(result.current.waiting).toBeNull();
    await tick();
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.waiting).toEqual({ n: 1 });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("stops reading when the request id becomes null, and after unmount", async () => {
    const { rerender, read, unmount, result } = setup(async () => waiting(1));
    await flush();
    rerender({ requestId: null });
    expect(result.current).toEqual({ stage: null, queue: null, waiting: null, offline: false });
    await tick(10 * STATUS_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);

    rerender({ requestId: 8 });
    await flush();
    expect(read).toHaveBeenLastCalledWith(8);
    const calls = read.mock.calls.length;
    unmount();
    await tick(10 * STATUS_POLL_MS);
    expect(read).toHaveBeenCalledTimes(calls);
  });
});
