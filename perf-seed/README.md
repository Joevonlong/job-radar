# Current display score measurements

Run from the product root with Node 22 and installed dependencies. Every argument is explicit: the PostgreSQL admin URL,
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
