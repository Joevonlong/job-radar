import type { ActivityRecorder, RequestSpanHandle } from "./types";

const ignore = (): void => {};
export const noopSpan: RequestSpanHandle = Object.freeze({
  id: "", rootId: "", child: () => noopSpan,
  progress: ignore, item: ignore, note: ignore, finish: ignore, discard: ignore,
});
export const noopRecorder: ActivityRecorder = Object.freeze({
  enabled: false,
  cycleRoot: () => noopSpan, attachCycle: () => noopSpan, requestRoot: () => noopSpan, systemRoot: () => noopSpan,
  flush: async () => {}, close: async () => {},
});
