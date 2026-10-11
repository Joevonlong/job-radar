/**
 * The rule scan of the cycle and of `pnpm traps:scan`: jobs whose JD, source payloads or rules changed since their last
 * scan (never-scanned first, newest first) are scanned, at most `limit` per run. Each job is stored in its own transaction, so one
 * failure costs that job only (it is retried next time).
 */
import { createHash } from "node:crypto";

import type { ChannelLogger, DescriptionHtmlFragment } from "@/lib/channels/types";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { Executor } from "@/lib/db/executor";
import { listJobsToTrapScan, listRuleTrapKeys, loadTrapScanInputs, saveTrapScan, trapRuleKey, trapTablesReady, type TrapScanCandidate } from "@/lib/db/repos/traps";

import { spanKindOf } from "./ai-input";
import { rulesFingerprint } from "./fingerprint";
import { scanJob } from "./scan";
import type { TrapFinding } from "./types";

/** Jobs per database round trip. */
const BATCH = 25;

/** What the scan needs of the channel registry: the channel of a source posting (only its `descriptionHtml` is used). */
export interface ChannelLookup {
  get(id: string): { descriptionHtml?(payload: unknown): DescriptionHtmlFragment[] } | undefined;
}

export interface TrapScanOptions {
  settings: TrapsConfig;
  channels: ChannelLookup;
  logger: Pick<ChannelLogger, "info" | "warn" | "error">;
  limit: number;
  signal?: AbortSignal;
  /** Only these jobs. */
  jobIds?: readonly number[];
  /** Scan the listed jobs even when their scan is current. */
  force?: boolean;
  /** false: compute and compare only (the preview of `pnpm traps:scan`), nothing is written. Default true. */
  write?: boolean;
  /** Keep every job's findings in the result (`--json`, `--job`). */
  collect?: boolean;
}

export interface ScannedJob {
  jobId: number;
  changed: boolean;
  traps: number;
  suspicious: number;
  findings?: TrapFinding[];
}

export interface TrapScanResult {
  /** Why nothing ran: off, or the tables are not migrated yet. */
  skipped?: "disabled" | "no_tables";
  scanned: number;
  /** Jobs whose stored findings changed (or would change, in a preview). */
  changed: number;
  withTraps: number;
  withSuspicious: number;
  /** Jobs whose rule signals are scanned again because the removed pieces of their JD changed. */
  signalRescans: number;
  failed: number;
  aborted: boolean;
  jobs: ScannedJob[];
}

/** Hash of the JD pieces the findings take out of the AI input (null = none): a change rescans the job's rule signals. */
export function spansHashOf(findings: readonly TrapFinding[]): string | null {
  const keys = findings
    .filter((f) => f.inDescription && f.quoteOffset !== null)
    .map((f) => `${f.quoteOffset}:${f.quote.length}:${spanKindOf(f)}`)
    .sort();
  return keys.length === 0 ? null : createHash("md5").update(keys.join("|")).digest("hex");
}

function fragmentsOf(channels: ChannelLookup, channelId: string, payload: unknown): DescriptionHtmlFragment[] {
  const channel = channels.get(channelId);
  if (!channel?.descriptionHtml) return [];
  try {
    return channel.descriptionHtml(payload);
  } catch {
    return []; // a payload the channel cannot read has no HTML for the scan; the text scan still runs
  }
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown error");

export async function runTrapScan(db: Executor, options: TrapScanOptions): Promise<TrapScanResult> {
  const result: TrapScanResult = { scanned: 0, changed: 0, withTraps: 0, withSuspicious: 0, signalRescans: 0, failed: 0, aborted: false, jobs: [] };
  const { settings } = options;
  if (!settings.enabled) return { ...result, skipped: "disabled" };
  if (!(await trapTablesReady(db))) return { ...result, skipped: "no_tables" };
  const write = options.write ?? true;
  const rulesHash = rulesFingerprint(settings);
  const candidates = await listJobsToTrapScan(db, { rulesHash, limit: options.limit, ...(options.jobIds ? { jobIds: options.jobIds } : {}), force: options.force === true });

  for (let at = 0; at < candidates.length; at += BATCH) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const batch = candidates.slice(at, at + BATCH);
    const byId = new Map<number, TrapScanCandidate>(batch.map((c) => [c.jobId, c]));
    const inputs = await loadTrapScanInputs(db, batch.map((c) => c.jobId));
    for (const input of inputs) {
      if (options.signal?.aborted) {
        result.aborted = true;
        break;
      }
      const candidate = byId.get(input.jobId);
      if (!candidate) continue;
      try {
        const { findings, trigger } = scanJob(
          { description: input.description, sources: input.sources.map((s) => ({ rawPostingId: s.rawPostingId, fragments: fragmentsOf(options.channels, s.channelId, s.payload) })) },
          settings,
        );
        const needsAi = findings.length > 0 || trigger !== null;
        const spansHash = spansHashOf(findings);
        let changed: boolean;
        if (write) {
          const saved = await saveTrapScan(db, { jobId: input.jobId, descriptionHash: candidate.descriptionHash, sourcesHash: candidate.sourcesHash, rulesHash, findings, needsAi, spansHash });
          changed = saved.changed;
          if (saved.spansChanged) result.signalRescans += 1;
        } else {
          const stored = await listRuleTrapKeys(db, input.jobId);
          const fresh = findings.map(trapRuleKey);
          changed = candidate.fresh || stored.length !== fresh.length || stored.some((key, index) => key !== fresh[index]);
        }
        const traps = findings.filter((f) => f.severity === "trap").length;
        const suspicious = findings.length - traps;
        result.scanned += 1;
        if (changed) result.changed += 1;
        if (traps > 0) result.withTraps += 1;
        else if (suspicious > 0) result.withSuspicious += 1;
        if (options.collect || traps > 0) result.jobs.push({ jobId: input.jobId, changed, traps, suspicious, ...(options.collect ? { findings } : {}) });
      } catch (error) {
        result.failed += 1;
        options.logger.error("ai trap scan failed for a job", { jobId: input.jobId, error: describe(error) });
      }
    }
  }
  return result;
}
