import type { z } from "zod";
import type { ControlRequestKind } from "@/lib/db/repos/control-requests";
import type { activityProcessSchema, spanScopeSchema, spanStatusSchema, spanNameSchema, eventLevelSchema, eventCodeSchema } from "./names";
import type { ActivityParams, spanLinksSchema } from "./params";

export type { ActivityParams } from "./params";
export type ActivityProcess = z.infer<typeof activityProcessSchema>;
export type SpanScope = z.infer<typeof spanScopeSchema>;
export type SpanStatus = z.infer<typeof spanStatusSchema>;
export type TerminalStatus = Exclude<SpanStatus, "running">;
export type SpanName = z.infer<typeof spanNameSchema>;
export type SystemSpanName = Extract<SpanName, `system.${string}`>;
export type EventLevel = z.infer<typeof eventLevelSchema>;
export type EventCode = z.infer<typeof eventCodeSchema>;
export type ItemEventCode = Extract<EventCode, `item.${string}` | "parse_failed">;
export type SpanLinks = z.infer<typeof spanLinksSchema>;

export interface SpanHandle {
  readonly id: string;
  readonly rootId: string;
  child(name: SpanName, links?: SpanLinks): SpanHandle;
  progress(done: number, total?: number): void;
  /** Events belong before finish; a terminal handle no longer accepts events. */
  item(code: ItemEventCode, fields?: { jobId?: number; rawPostingId?: number; errorCode?: string; params?: ActivityParams }): void;
  note(level: EventLevel, code: EventCode, params?: ActivityParams): void;
  finish(status: TerminalStatus, options?: { reasonCode?: string }): void;
}
export interface RequestSpanHandle extends SpanHandle { discard(): void }

export interface ActivityRecorder {
  cycleRoot(cycleId: number, links?: { requestId?: number }): SpanHandle;
  attachCycle(cycleId: number): SpanHandle;
  requestRoot(request: { id: number; kind: ControlRequestKind }, options?: { jobId?: number; deferred?: boolean }): RequestSpanHandle;
  systemRoot(name: SystemSpanName, links?: SpanLinks): SpanHandle;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly enabled: boolean;
}

/** Complete state, including start information, travels with every progress/finish write. */
export interface ActivitySpanWrite {
  id: string; rootId: string; parentId: string | null;
  scope: SpanScope; name: SpanName; process: ActivityProcess; status: SpanStatus;
  reasonCode: string | null;
  startedAt: Date; finishedAt: Date | null; lastActivityAt: Date;
  progressDone: number | null; progressTotal: number | null; eventsDropped: number;
  cycleId: number | null; controlRequestId: number | null; runId: number | null; jobId: number | null;
  channelId: string | null; queryId: string | null;
}
export interface ActivityEventWrite {
  id: string; rootId: string; spanId: string; at: Date;
  level: EventLevel; code: EventCode;
  jobId: number | null; rawPostingId: number | null; params: ActivityParams;
}
export interface ActivityBatch {
  roots: ActivitySpanWrite[];
  spans: ActivitySpanWrite[];
  events: ActivityEventWrite[];
  batchSize: number;
}
