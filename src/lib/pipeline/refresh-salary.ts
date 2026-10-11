import { createHash } from "node:crypto";

import type { PipelineConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { listJobsWithRawPostings } from "@/lib/db/repos/job-sources";
import { updateJob } from "@/lib/db/repos/jobs";
import { hashPayload, type RawPosting } from "@/lib/db/repos/raw-postings";
import { listRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";
import type { ChannelLogger } from "@/lib/channels/types";
import type { JobSalary } from "@/lib/domain/types";

import { salaryRank } from "./dedupe";
import { SALARY_PARSER_VERSION } from "./salary";

export interface SalaryRefreshResult {
  /** Jobs looked at. */
  jobs: number;
  /** Jobs whose stored salary was wrong or missing and now differs. */
  changed: number;
  /** Of those, jobs that now state no salary (a benefit number was read as one before). */
  cleared: number;
  /** Jobs whose raw postings could not be read again (their salary is left alone). */
  unreadable: number;
  aborted: boolean;
}

export interface SalaryRefreshOptions {
  config: PipelineConfig;
  /** A raw posting -> the salary the current code reads from it; `undefined` when the posting cannot be parsed. */
  salaryOf: (raw: RawPosting) => JobSalary | null | undefined;
  logger: ChannelLogger;
  signal?: AbortSignal;
}

/** Key of the state row that remembers which salary parsing the stored salaries were made with. */
export const SALARY_FINGERPRINT_KEY = "pipeline:salary_fingerprint";

/** Hash of everything the salary parsing depends on: this file's parser version, `pipeline.yaml` `salary` (with the packs' currency tokens) and the base currency. */
export function salaryFingerprint(config: PipelineConfig): string {
  return createHash("sha256").update(JSON.stringify({ version: SALARY_PARSER_VERSION, salary: config.salary, currency: config.market.currency })).digest("hex").slice(0, 32);
}

/**
 * Read every job's raw postings again with the current salary parsing and store the salary it gives:
 * the best of its sources (valid before needs-review before none; then the better apply-link priority),
 * exactly the order a merge would pick. Unlike a merge this may REPLACE a stored salary by "none": the
 * stored one came from older parsing (a relocation allowance read as a salary), the raw posting is the truth (C1).
 */
export async function refreshSalaries(db: Db, options: SalaryRefreshOptions): Promise<SalaryRefreshResult> {
  const result: SalaryRefreshResult = { jobs: 0, changed: 0, cleared: 0, unreadable: 0, aborted: false };
  let afterId = 0;
  for (;;) {
    const batch = await listJobsWithRawPostings(db, { afterId, limit: options.config.batch_size });
    if (batch.length === 0) break;
    for (const job of batch) {
      if (options.signal?.aborted) {
        result.aborted = true;
        return result;
      }
      afterId = job.jobId;
      result.jobs += 1;
      let best: JobSalary | null = null;
      let read = 0;
      for (const source of job.sources) {
        const salary = options.salaryOf(source.raw);
        if (salary === undefined) continue;
        read += 1;
        if (salary !== null && salaryRank(salary) > salaryRank(best)) best = salary;
      }
      if (read === 0) {
        if (job.sources.length > 0) result.unreadable += 1;
        continue; // nothing to read it from: leave what is stored
      }
      const stored = job.salaryJson ?? null;
      if (hashPayload(stored) === hashPayload(best)) continue;
      await updateJob(db, job.jobId, { salaryJson: best });
      result.changed += 1;
      if (best === null) result.cleared += 1;
    }
  }
  options.logger.info("salaries refreshed", { jobs: result.jobs, changed: result.changed, cleared: result.cleared, unreadable: result.unreadable });
  return result;
}

/** `refreshSalaries` once per salary parsing: when the fingerprint stored by the last run differs from today's (or `force`). */
export async function refreshSalariesIfStale(db: Db, options: SalaryRefreshOptions & { force?: boolean }): Promise<SalaryRefreshResult | null> {
  const fingerprint = salaryFingerprint(options.config);
  const [row] = await listRuntimeState(db, SALARY_FINGERPRINT_KEY);
  if (!options.force && row?.value === fingerprint) return null;
  const result = await refreshSalaries(db, options);
  if (!result.aborted) await setRuntimeState(db, SALARY_FINGERPRINT_KEY, fingerprint);
  return result;
}
