import { describe, expect, it } from "vitest";

import { silentLogger } from "@/lib/channels/logger";
import { runPoller } from "@/lib/notify/poller";
import { TelegramError, type GetUpdatesResult, type TelegramClient, type TelegramUpdate } from "@/lib/notify/telegram-client";

import { notifyConfig } from "./helpers";

const update = (id: number): TelegramUpdate => ({ update_id: id, message: { message_id: id, chat: { id: 1 } } });
const enabled = () => notifyConfig((c) => (c.telegram.enabled = true));

/** A client whose getUpdates answers from a script; the loop is stopped (abort) when the script runs out. */
function scripted(steps: Array<GetUpdatesResult | Error>, controller: AbortController) {
  const offsets: Array<number | undefined> = [];
  const client = {
    async getUpdates(input: { offset?: number }): Promise<GetUpdatesResult> {
      offsets.push(input.offset);
      const next = steps.shift();
      if (steps.length === 0) queueMicrotask(() => controller.abort());
      if (next === undefined) throw new TelegramError("aborted", "getUpdates", "done");
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as TelegramClient;
  return { client, offsets };
}

const batch = (ids: number[], malformed = 0): GetUpdatesResult => ({
  updates: ids.map(update),
  lastUpdateId: ids.length > 0 ? Math.max(...ids) : null,
  malformed,
});

describe("runPoller", () => {
  it("hands every update to the handler and moves the offset past the batch", async () => {
    const controller = new AbortController();
    const { client, offsets } = scripted([batch([5, 6]), batch([]), batch([7])], controller);
    const seen: number[] = [];
    await runPoller({
      client,
      handler: { handle: async (u) => void seen.push(u.update_id) },
      logger: silentLogger,
      getConfig: enabled,
      signal: controller.signal,
      sleep: async () => {},
    });
    expect(seen).toEqual([5, 6, 7]);
    expect(offsets).toEqual([undefined, 7, 7]);
  });

  it("backs off after a failure, doubling up to the maximum, and recovers", async () => {
    const controller = new AbortController();
    const fail = new TelegramError("network", "getUpdates", "down");
    const { client } = scripted([fail, fail, fail, fail, batch([1])], controller);
    const waits: number[] = [];
    const seen: number[] = [];
    await runPoller({
      client,
      handler: { handle: async (u) => void seen.push(u.update_id) },
      logger: silentLogger,
      getConfig: () => notifyConfig((c) => Object.assign(c.telegram, { enabled: true, poll_backoff_seconds: 5, poll_backoff_max_seconds: 30 })),
      signal: controller.signal,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([5000, 10000, 20000, 30000]);
    expect(seen).toEqual([1]);
  });

  it("idles without calling the API while telegram is disabled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = { getUpdates: async () => void calls++ } as unknown as TelegramClient;
    let turns = 0;
    await runPoller({
      client,
      handler: { handle: async () => {} },
      logger: silentLogger,
      getConfig: () => ({ ...notifyConfig(), telegram: { ...notifyConfig().telegram, enabled: false } }),
      signal: controller.signal,
      sleep: async () => {
        if (++turns === 3) controller.abort();
      },
    });
    expect(calls).toBe(0);
  });

  it("runs the tick after each turn and survives a failing tick", async () => {
    const controller = new AbortController();
    const { client } = scripted([batch([]), batch([]), batch([])], controller);
    let ticks = 0;
    await runPoller({
      client,
      handler: { handle: async () => {} },
      logger: silentLogger,
      getConfig: enabled,
      signal: controller.signal,
      onTick: async () => {
        ticks += 1;
        throw new Error("tick failed");
      },
      sleep: async () => {},
    });
    expect(ticks).toBe(3);
  });

  it("stops promptly when aborted during a long poll", async () => {
    const controller = new AbortController();
    const client = {
      getUpdates: (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new TelegramError("aborted", "getUpdates", "cancelled")))),
    } as unknown as TelegramClient;
    const done = runPoller({ client, handler: { handle: async () => {} }, logger: silentLogger, getConfig: enabled, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await done;
  });
});
