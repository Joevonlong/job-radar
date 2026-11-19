/** A field added to an exported block must update this matrix, the triggers and SYNC_DTO_VERSION in the same PR. */
import type { Permission } from "@/lib/agent-access/permissions";

export const SYNC_DTO_VERSION = 1;

export const SYNC_REMOVED_BITS = { job: 0, application: 1, favorite: 2 } as const;
export type SyncEntityKind = keyof typeof SYNC_REMOVED_BITS;

export const SYNC_BLOCKS = {
  job: { bit: 0, permission: "jobs:read", entity: "job" },
  translation: { bit: 1, permission: "jobs:read", entity: "job" },
  breakdown: { bit: 2, permission: "jobs:read", entity: "job" },
  salary: { bit: 3, permission: "jobs:read", entity: "job" },
  company: { bit: 4, permission: "jobs:read", entity: "job" },
  ghost: { bit: 5, permission: "jobs:read", entity: "job" },
  lifecycle: { bit: 6, permission: "jobs:read", entity: "job" },
  match: { bit: 7, permission: "match:read", entity: "job" },
  tracking: { bit: 8, permission: "tracking:read", entity: "job" },
  notes: { bit: 9, permission: "notes:read", entity: "job" },
  app: { bit: 10, permission: "tracking:read", entity: "application" },
  "app.notes": { bit: 11, permission: "notes:read", entity: "application" },
  fav: { bit: 12, permission: "tracking:read", entity: "favorite" },
  "fav.notes": { bit: 13, permission: "notes:read", entity: "favorite" },
} as const satisfies Record<string, { bit: number; permission: Permission; entity: SyncEntityKind }>;

export type SyncBlock = keyof typeof SYNC_BLOCKS;
export const SYNC_KEY_KINDS = ["job", "company", "salary_key", "benchmark", "raw_posting"] as const;
export type SyncKeyKind = (typeof SYNC_KEY_KINDS)[number];

/** A benchmark group key is a JSON array of values in this order. */
export const SYNC_BENCHMARK_GROUP_COLUMNS = ["role_family", "seniority", "geo_level", "geo_key", "currency"] as const;

type SyncKey =
  | { kind: "job"; column: "id" | "job_id" }
  | { kind: "job"; via: "application_id" }
  | { kind: "company"; column: "id" | "company_id" }
  | { kind: "salary_key"; column: "lookup_key" }
  | { kind: "benchmark"; columns: typeof SYNC_BENCHMARK_GROUP_COLUMNS }
  | { kind: "benchmark"; literal: "*" }
  | { kind: "raw_posting"; column: "id" };

export type SyncOperation = "insert" | "update" | "delete";

interface SyncSource {
  table: string;
  columns: readonly string[];
  operations: readonly SyncOperation[];
  key: SyncKey;
  blocks: readonly SyncBlock[];
  condition?: "description_fingerprint" | "dormant" | "link_outcome" | "phrase_outcome" | "relist_count" |
    "raw_fingerprint" | "in_description" | "with_note" | "ai_presence" | "completed_result";
}

const writes = ["insert", "update", "delete"] as const;
const presence = ["insert", "delete"] as const;
const update = ["update"] as const;
const job = { kind: "job", column: "id" } as const;
const jobId = { kind: "job", column: "job_id" } as const;
const eventJob = { kind: "job", via: "application_id" } as const;
const company = { kind: "company", column: "id" } as const;
const jdFreshness = ["job", "translation", "breakdown", "salary", "company", "match", "ghost"] as const;
const jdSpans = ["job", "breakdown", "match", "ghost"] as const;
const jobBlocks = ["job", "translation", "breakdown", "salary", "company", "ghost", "lifecycle", "match", "tracking", "notes"] as const;

export const SYNC_SOURCES: readonly SyncSource[] = [
  { table: "jobs", columns: [], operations: presence, key: job, blocks: jobBlocks },
  { table: "jobs", columns: ["title"], operations: update, key: job, blocks: ["job", "salary", "match", "app", "fav"] },
  { table: "jobs", columns: ["company_id"], operations: update, key: job, blocks: ["job", "salary", "company", "ghost", "match", "app", "fav"] },
  { table: "jobs", columns: ["locations_json"], operations: update, key: job, blocks: ["job", "salary", "fav"] },
  { table: "jobs", columns: ["workplace", "contract", "is_agency", "language"], operations: update, key: job, blocks: ["job"] },
  { table: "jobs", columns: ["german_level_required", "skills"], operations: update, key: job, blocks: ["job", "match"] },
  { table: "jobs", columns: ["posted_at", "first_seen_at"], operations: update, key: job, blocks: ["job", "fav"] },
  { table: "jobs", columns: ["salary_json"], operations: update, key: job, blocks: ["job", "salary", "match"] },
  { table: "jobs", columns: ["seniority"], operations: update, key: job, blocks: ["job", "salary"] },
  { table: "jobs", columns: ["title_norm"], operations: update, key: job, blocks: ["salary"] },
  { table: "jobs", columns: ["description"], operations: update, key: job, blocks: ["job", "translation", "breakdown", "match", "ghost"] },
  { table: "jobs", columns: ["description", "description_md5"], operations: update, key: job, blocks: jdFreshness, condition: "description_fingerprint" },
  { table: "jobs", columns: ["status"], operations: update, key: job, blocks: ["job", "lifecycle", "tracking", "app", "fav"] },
  { table: "jobs", columns: ["status", "dormant_at", "last_seen_at"], operations: update, key: job, blocks: ["lifecycle", "tracking", "app"], condition: "dormant" },
  { table: "jobs", columns: ["link_check_json"], operations: update, key: job, blocks: ["tracking", "app"], condition: "link_outcome" },
  { table: "jobs", columns: ["link_check_json"], operations: update, key: job, blocks: ["lifecycle"], condition: "phrase_outcome" },
  { table: "jobs", columns: ["relisted_at"], operations: update, key: job, blocks: ["lifecycle"] },
  { table: "jobs", columns: ["relist_count"], operations: update, key: job, blocks: ["lifecycle"], condition: "relist_count" },
  { table: "job_sources", columns: ["job_id", "id", "channel_id", "url", "apply_url", "priority", "first_seen_at"], operations: writes, key: jobId, blocks: ["job", "fav"] },
  { table: "job_sources", columns: ["job_id", "raw_posting_id"], operations: writes, key: jobId, blocks: jdFreshness },
  { table: "raw_postings", columns: ["payload_fingerprint", "payload_hash", "payload_json"], operations: update, key: { kind: "raw_posting", column: "id" }, blocks: jdFreshness, condition: "raw_fingerprint" },
  { table: "signals", columns: ["job_id", "id", "tier", "kind", "value_json", "quote", "quote_offset", "quote_source", "extractor"], operations: writes, key: jobId, blocks: ["job"] },
  { table: "trap_scans", columns: ["job_id", "description_hash", "sources_hash", "rules_hash"], operations: writes, key: jobId, blocks: jdFreshness },
  { table: "trap_scans", columns: ["trap_count", "suspicious_count"], operations: update, key: jobId, blocks: ["job"] },
  { table: "job_traps", columns: ["job_id", "id", "in_description", "quote", "quote_offset", "technique", "method"], operations: writes, key: jobId, blocks: jdSpans, condition: "in_description" },
  { table: "translations", columns: ["job_id", "lang", "content", "source_hash", "created_at"], operations: writes, key: jobId, blocks: ["translation"] },
  { table: "job_breakdowns", columns: ["job_id", "content", "prompt_version", "analyzed_at"], operations: writes, key: jobId, blocks: ["breakdown"] },
  { table: "job_ghost", columns: ["job_id", "level", "score", "evidence", "dismissed_at", "dismissed_codes"], operations: writes, key: jobId, blocks: ["ghost"] },
  { table: "scores", columns: ["job_id", "id", "score", "stale", "german_level", "filter_result", "created_at"], operations: writes, key: jobId, blocks: ["job", "match"] },
  { table: "scores", columns: ["rank_value"], operations: update, key: jobId, blocks: ["job"] },
  { table: "scores", columns: ["ai_score", "german_penalty", "filter_reasons", "fit_reasons", "gaps", "reason_evidence", "summaries", "summary_zh", "summary_en", "output_lang", "scored_at"], operations: update, key: jobId, blocks: ["match"] },
  { table: "job_current_scores", columns: ["job_id", "rank_value"], operations: writes, key: jobId, blocks: ["fav"] },
  { table: "job_visa", columns: ["job_id", "status", "evidence"], operations: writes, key: jobId, blocks: ["match"] },
  { table: "applications", columns: ["job_id", "status", "status_changed_at", "next_action", "next_action_at", "interview_rounds", "created_at"], operations: writes, key: jobId, blocks: ["tracking", "app"] },
  { table: "applications", columns: ["notes_md", "job_id"], operations: writes, key: jobId, blocks: ["notes", "app.notes"], condition: "with_note" },
  { table: "application_events", columns: ["application_id", "id", "from_status", "to_status", "at", "occurred_at", "reference"], operations: writes, key: eventJob, blocks: ["tracking", "app"] },
  { table: "application_events", columns: ["note"], operations: writes, key: eventJob, blocks: ["notes", "app.notes"], condition: "with_note" },
  { table: "application_events", columns: ["application_id", "id", "at"], operations: update, key: eventJob, blocks: ["notes", "app.notes"], condition: "with_note" },
  { table: "application_events", columns: ["from_status", "to_status"], operations: update, key: eventJob, blocks: ["app.notes"], condition: "with_note" },
  { table: "job_favorites", columns: ["job_id", "created_at"], operations: writes, key: jobId, blocks: ["tracking", "app", "fav"] },
  { table: "job_favorites", columns: ["note", "job_id"], operations: writes, key: jobId, blocks: ["notes", "fav.notes"], condition: "with_note" },
  { table: "job_seen", columns: ["job_id"], operations: writes, key: jobId, blocks: ["tracking", "app"] },
  { table: "job_filter_overrides", columns: ["job_id", "action"], operations: writes, key: jobId, blocks: ["tracking", "app"] },
  { table: "job_closure_overrides", columns: ["job_id", "action"], operations: writes, key: jobId, blocks: ["job", "lifecycle", "tracking", "app", "fav"] },
  { table: "job_closure_overrides", columns: ["created_at"], operations: update, key: jobId, blocks: ["tracking", "app"] },
  { table: "companies", columns: ["name"], operations: update, key: company, blocks: ["job", "app", "fav"] },
  { table: "companies", columns: ["name_norm"], operations: update, key: company, blocks: ["salary", "ghost", "match"] },
  { table: "salary_lookups", columns: ["lookup_key", "id", "status", "result_json", "fetched_at", "expires_at", "prompt_version"], operations: writes, key: { kind: "salary_key", column: "lookup_key" }, blocks: ["salary"], condition: "completed_result" },
  { table: "salary_benchmarks", columns: [...SYNC_BENCHMARK_GROUP_COLUMNS, "n", "median", "quantiles"], operations: writes, key: { kind: "benchmark", columns: SYNC_BENCHMARK_GROUP_COLUMNS }, blocks: ["salary"] },
  { table: "salary_benchmarks", columns: ["n_ai"], operations: writes, key: { kind: "benchmark", literal: "*" }, blocks: ["salary"], condition: "ai_presence" },
  { table: "company_research", columns: ["company_id", "id", "status", "result_json", "fetched_at", "expires_at"], operations: writes, key: { kind: "company", column: "company_id" }, blocks: ["company"], condition: "completed_result" },
];
