# Query performance checks

[English](query-performance.md) | [中文](query-performance.zh.md)

The hard filter stores the fingerprint of the job, company, override and configuration it actually evaluated in the
snapshot's score row. A cycle only reads candidates whose fingerprint differs or whose result is missing. Configuration
includes preferences, the resolved pipeline/market, the user's language and visa profile, and the watch list. Job content,
company edits and override changes invalidate the input fingerprint. A new snapshot gets its own results. Explicit
per-job refiltering still runs immediately, including dormant jobs; closed jobs remain excluded. Timed-out deal-breaker
judgements stay eligible for retry. `evaluated`, `passed`, `filteredOut` and `byReason` describe only jobs evaluated in that
run. AI score fields and score creation times are preserved.

Description, nonempty-description, salary and legacy payload fingerprints are generated stored columns, retaining the old
expressions and null payload-hash fallback without converting hashes to another algorithm. Signal, trap, ghost and visa
candidate queries use the compact columns. Trap sources are aggregated per candidate job; checking one job no longer
groups every source. Small composite/source-list hashes are still computed on reads. Ordinary job reads and insert results
omit the full-text vector and internal generated fingerprints. Unchanged raw upserts retain the stored payload reference
while refreshing metadata.

Source history uses a bounded lateral lookup per channel, with the old descending start-time/id tie breaker. Monthly
usage and run totals use inclusive local month start and exclusive next-month start, converted by Postgres in the requested
time zone. An indexable UTC envelope adds 24 elapsed hours around each boundary; exact local timestamp predicates
preserve skipped/repeated midnights and even non-contiguous months. Indexes match recent and successful channel runs, month times, notification
job ids, per-job control requests and pending raw ids. Existing indexes are retained: removal needs installation statistics.

## Migration and verification

`pnpm db:generate --name incremental_scan_inputs` generated `0040_incremental_scan_inputs`, after `0039_job_dormant`:
four generated columns, two score-cache columns and six indexes; no new config keys. Applying it rewrites jobs/raw tables
and takes table locks; it took 20.3 seconds on the fixture below. The first filter run fills missing fingerprints; steady
timings exclude that work.

[performance-baseline.ts](../tests/integration/performance-baseline.ts) freezes the old SQL from main `914dc3e`, already
including dormant and identity fixes. Complete result comparisons cover missing/current/stale scans, null/empty/Unicode
descriptions, legacy payloads, multiple/no sources, closed/dormant jobs, explicit scopes, pagination, timestamp ties and
calendar boundaries (including Havana, Asuncion and Goose_Bay midnight transitions). Separate regression checks cover repeated filter evaluation, unchanged TOAST chunk ids, omitted
search vectors, bounded run reads, indexable month predicates and index eligibility. The original nine regression tests
were run against the old runtime and all failed for the expected reasons.

Focused checks use the normal disposable Postgres 17 integration harness. Files under `tests/integration/`:
`performance-queries`, `performance-equivalence`, `filter-incremental`, `filter`, `signals`, `salary-signals`, `traps`,
`ghost`, `visa`, `sources`, `ai-usage`, `dormant-hot-paths`, `pipeline`, `pipeline-idempotence`, `notify`.
The handoff records executed counts, lint and typecheck. No full integration/e2e suite or production connection is used.

## One-year fixture (2026-10-28)

The supplied review seed used parameters `40000 410 45 0.25`, fixed Postgres randomness, its location generator and DE
profile, followed by `windows.sql`. Current-main dormancy rules were applied before both measurements. There are 40,000
jobs: 2,584 active, 27,990 possibly closed (25,319 dormant), 9,426 closed; 52,000 raw postings, 17,550 runs and 21,076 AI
calls. The original 191,448 scores become 196,703 when warming the current snapshot on both versions. Both versions use
the same database. Except where noted, timings are warm: one warm-up, then the median of five calls. These are local
synthetic results, not production latency guarantees.

| Operation | Current main | Updated | Result |
|---|---:|---:|---|
| Signal candidates | 358.8 ms | 28.1 ms | 0 stale jobs |
| Salary sync | 502.3 ms | 25.4 ms | 0 stale jobs |
| Trap candidates | 355.6 ms | 75.3 ms | 0 stale jobs |
| Ghost candidates | 159.4 ms | 84.6 ms | 0 stale jobs |
| Visa candidates | 92.0 ms | 23.7 ms | 0 stale jobs |
| Steady hard filter | 444.8 ms | 66.8 ms | Evaluated 5,255 → 0, same results |
| Latest 10 runs/channel | 15.9 ms | 3.2 ms | Same 15 channel groups |
| Monthly AI cost | 11.1 ms | 2.2 ms | Same total |
| Monthly AI usage | 11.1 ms | 2.2 ms | Same provider/task group |
| Monthly run totals | 9.3 ms | 2.0 ms | Same 15 channel groups |
| One job, JSON bytes | 7,368 B | 4,383 B | Same domain fields, 40.5% fewer bytes |
| Unchanged raw upsert, 1,000 rows, single run | 193.8 ms / 2,130,096 WAL B | 179.4 ms / 1,452,904 WAL B | Same payload/metadata semantics |

Index comparisons used rolled-back transactions removing/restoring the six new indexes on this fixture. For the pending
read, 514 raw rows were temporarily set pending and then restored.

| Indexed lookup | Without new indexes | With new indexes | Plan / shared hit blocks |
|---|---:|---:|---|
| Notification job ids | 2.98 ms | 0.43 ms | Sequential scan → expression index; 520 → 19 |
| Missing per-job request | 1.03 ms | 0.31 ms | Backward primary-key scan → job-id index; 95 → 2 |
| Next 50 pending raw ids | 2.18 ms | 1.84 ms | Sort → ordered partial-index scan; 215 → 26 |

Single-job read latency was 1.06 → 1.33 ms; this proves transfer reduction, not lower one-row latency. The refuted bulk
possibly-closed update and already-merged Today/dormant optimizations are unchanged.

Raw measurements: [query-performance.json](query-performance.json). Validation: 15 affected integration files / 205 tests, 25 control-request tests, then 6 directly affected files / 49 tests after the final boundary fixes; 245 unit tests; lint, typecheck, docs links and planning-id checks. The independent final review found no remaining major issues after the null/empty-description and unusual month-boundary regressions were fixed.
