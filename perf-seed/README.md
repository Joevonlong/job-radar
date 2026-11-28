# Current display score measurements

Run from the product root with Node 26.13.1 or a later 26.x and installed dependencies. Every argument is explicit: the PostgreSQL admin URL,
throwaway database name (must start with `jobradar_test_scoreperf_`), code root and disposable container. Production port
5433 is rejected. Use the machine's heavy-task semaphore for the complete run. Supply a test config/profile directory
with a resolved DE market through `JOB_RADAR_DEFAULTS_DIR`, `JOB_RADAR_CONFIG_DIR`, and `JOB_RADAR_PROFILE_DIR`.

```text
node --import tsx perf-seed/run.mts ADMIN_URL BASELINE_ROOT PRODUCT_ROOT CONTAINER --out OUT_DIR
node --import tsx perf-seed/prepare.mts ADMIN_URL TEMPLATE_DB BASELINE_ROOT 40000 410 CONTAINER
node --import tsx perf-seed/equivalence.mts DATABASE_URL BASELINE_ROOT PRODUCT_ROOT LABEL --out OUT_DIR
node --import tsx perf-seed/current-scores-bench.mts DATABASE_URL CODE_ROOT LABEL --out OUT_DIR
node --import tsx perf-seed/current-scores-writes.mts ADMIN_URL TEMPLATE_DB CODE_ROOT LABEL [save] --out OUT_DIR
node --import tsx perf-seed/current-scores-migrate.mts ADMIN_URL OLD_TEMPLATE_DB PRODUCT_ROOT LABEL --out OUT_DIR
```

Use 3000 / 45 for the smaller seed. Keep a pre-migration template for baseline writes and migration contention; apply the
projection migration to another copy and use that same migrated database for both read versions. Labels containing
`projection` enable score-transaction writes and consistency/refresh-plan measurements. Write scenarios each copy their
own database from the template, run five batches with committed writes, and remove their copy afterwards. Single saves
use twenty samples per batch, changing score and summary on every commit. An optional trailing `save` reruns only that
scenario and replaces its entry in an existing result file. The other write scenarios use one committed bulk operation per batch. The all-bucket case
also samples concurrent saves and database wait events. Migration contention uses the new score transaction writer while the migration runs; before the table exists it skips
refresh, then discovers the table without a restart. `--out OUT_DIR` is required: the JSON results and EXPLAIN plans (`current-scores-{equivalence,bench,read-plans,plan,writes,migrate}-LABEL*.json`) are written there, and a `save` rerun reads the earlier writes file from it. The directory is created when missing; `run.mts` passes it to every step.

The seed has fictional employers, sources and descriptions, normalized location variation, early preference changes,
subsequent periodic snapshots, lifecycle closure, and populated recent cycle windows. The projection is rebuilt from
`scores`; there is no import of personal or production data.

## Change-log write overhead

```sh
node --import tsx perf-seed/agent-changes-writes.mts ADMIN_URL TEMPLATE_DB CODE_ROOT LABEL --out OUT_DIR [--runs N]
```

Use a 40,000-job `prepare.mts` template migrated to `CODE_ROOT`, with no sessions connected to the template. Use an idle
disposable PostgreSQL instance and an admin role that can clone databases, alter triggers and run `CHECKPOINT`. The harness
uses the checkout's shipped config and the seed's DE market. Each trial starts from its own copy, with the change-log
triggers disabled for `off` or left enabled for `on`. `--runs` defaults to three trials per mode.

The timed writes are the 10,000-job stale-score update and fresh filter results, a fixture ingest of 250 new and 250 changed
postings plus 5,000 sightings, and a separate 10,000-job heartbeat. The merge and undo each move the same seeded cohort,
with 500 jobs added to each employer during setup. The forced trap rescan runs the rule layer for every job and rewrites
findings on a 1% fixture sample. The salary benchmark compares an identical rebuild and a rebuild with changed salary
figures for one city. It reports changed groups and estimates their read-side reach from matching job keys.

`agent-changes-writes-LABEL.json` records every run and the medians for elapsed time, WAL bytes and change rows, including
the separate phases of multi-step scenarios. The script prints a summary table and exits with status 1 when any comparison
shows more than 10% time growth or 20% WAL growth, or when a heartbeat or identical rebuild emits a change row.
`agent-changes-writes.mts` reports an elapsed-time change of about +13% for `rescore/ten_thousand` against the +10% threshold,
so a non-zero exit from that result alone is expected given the accepted cost of writing one change row per changed job.
