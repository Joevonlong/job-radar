// @vitest-environment node
import { getEventListeners } from "node:events";

import { afterEach, expect, it, vi } from "vitest";

import { fetchBoardJson } from "@/lib/channels/ats/conditional";

import { atsContext } from "./helpers";

afterEach(() => vi.useRealTimers());

it.each([304, 404])("discards an ignored %i board response and releases its abort listener immediately", async (status) => {
  vi.useFakeTimers();
  const cycle = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
  const { ctx } = atsContext("greenhouse", async () => new Response(status === 304 ? null : stream, { status }), { signal: cycle.signal });

  expect(await fetchBoardJson(ctx, "https://boards.example.test/jobs", '"previous"')).toEqual({ kind: status === 304 ? "not_modified" : "not_found" });

  expect(getEventListeners(cycle.signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  if (status === 404) expect(cancelled).toBe(true);
});
