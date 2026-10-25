import type { ChannelsConfig, ScheduleConfig, SearchConfig } from "@/lib/config";
import type { CascadeSpec } from "@/lib/channels/cascade";
import type { CircuitBreaker } from "@/lib/channels/circuit";
import type { BudgetTracker } from "@/lib/channels/budget";
import type { FetchLike, SleepFn } from "@/lib/channels/http";
import type { HostResolver } from "@/lib/net/public-url";
import type { ChannelRegistry } from "@/lib/channels/registry";
import type { ChannelLogger, KnownPostings } from "@/lib/channels/types";
import type { ChannelStateStore } from "@/lib/channels/store";
import type { Db } from "@/lib/db/client";
import type { CycleKind } from "@/lib/db/repos/cycles";
import type { ScheduledCycleKind } from "@/lib/channels/query";

import { aiStep } from "@/lib/ai/step";

import { collectStep } from "./collect";

/** Processing-cycle steps in execution order. */
export const CYCLE_STEP_NAMES = ["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"] as const;
export type CycleStepName = (typeof CYCLE_STEP_NAMES)[number];

/** Framework services the steps share for one cycle. */
export interface ChannelServices {
  registry: ChannelRegistry;
  cascades: readonly CascadeSpec[];
  store: ChannelStateStore;
  /** A channel's stored postings (detail reuse). Read-only; in a dry run backed by the database given to runCycle, or empty without one. */
  known: (channelId: string) => KnownPostings;
  breaker: CircuitBreaker;
  budget: BudgetTracker;
  /** `--channel` filter: when set, only these channels run. */
  selected: readonly string[] | null;
  runtime: { fetch?: FetchLike; sleep?: SleepFn; random?: () => number; resolveHost?: HostResolver };
}

export interface CycleStepContext {
  /** `id` is null in dry runs, which write nothing. */
  cycle: { id: number | null; kind: CycleKind };
  /** The scheduled kind a catch-up replaces (decides the look-back window). */
  windowKind: ScheduledCycleKind | null;
  dryRun: boolean;
  /** null in every dry run (a dry run writes nothing; it reads persisted state only through channels.store and channels.known). */
  db: Db | null;
  signal: AbortSignal;
  logger: ChannelLogger;
  now: () => Date;
  config: { channels: ChannelsConfig; search: SearchConfig; schedule: ScheduleConfig };
  channels: ChannelServices;
  /** Results of the steps that already ran. */
  results: Readonly<Partial<Record<CycleStepName, unknown>>>;
}

export interface StepResult {
  /** `ok` when omitted. `partial` / `failed` lower the cycle's status. */
  status?: "ok" | "partial" | "failed";
  /** JSON-serializable; stored in `cycles.summary_json`. */
  result?: unknown;
}

export type CycleStepFn = (ctx: CycleStepContext) => Promise<StepResult | void>;

const noop: CycleStepFn = async () => {};

const DEFAULT_STEPS: Record<CycleStepName, CycleStepFn> = {
  collect: collectStep,
  pipeline: noop,
  filter: noop,
  signals: noop,
  ai: aiStep,
  notify: noop,
  maintenance: noop,
};

const steps = new Map<CycleStepName, CycleStepFn>(Object.entries(DEFAULT_STEPS) as Array<[CycleStepName, CycleStepFn]>);

/** Later features plug their step in here (`pipeline`, `signals`/`ai`, `notify`, ...). Replaces the previous handler. */
export function registerCycleStep(name: CycleStepName, fn: CycleStepFn): void {
  steps.set(name, fn);
}

/** The registered steps in execution order. */
export function listCycleSteps(): Array<[CycleStepName, CycleStepFn]> {
  return CYCLE_STEP_NAMES.map((name) => [name, steps.get(name) ?? noop]);
}

/** Restore the default (no-op / built-in collect) steps. For tests. */
export function resetCycleSteps(): void {
  for (const name of CYCLE_STEP_NAMES) steps.set(name, DEFAULT_STEPS[name]);
}
