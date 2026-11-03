import type { ChannelRegistry } from "@/lib/channels/registry";
import type { PipelineConfig } from "@/lib/config";
import { sameSourceExternalIds } from "@/lib/db/repos/jobs";
import type { DedupeSnapshot, SnapshotRaw } from "@/lib/db/queries/dedupe-snapshot";

import { resolveCompanyName } from "./company";
import { applyMerge, decideMatch, fieldsOf, fieldsOfJob, sourceWins, storedLocations, type JobFields, type MatchDetail, type MatchLoaders } from "./dedupe";
import type { NormalizedJob } from "./normalize";
import { parseAndNormalize } from "./prepare";
import { hammingDistance } from "./simhash";
import { classifyTitles, compileTitleGuard, type TitleRelation } from "./title-guard";

/**
 * Replays the pipeline's matching over stored postings, in memory: the same `parseAndNormalize`, `decideMatch`, `sourceWins`
 * and `applyMerge` production runs, in raw id order. Touches no database. An integration test holds its groups equal to
 * `runPipeline`'s.
 */

export interface ReplayPosting {
  id: number;
  channelId: string;
  family: string;
  externalId: string;
  normalized: NormalizedJob;
  company: string;
  companyKey: string;
}

export interface PreparedPostings {
  postings: ReplayPosting[];
  skipped: Array<{ id: number; channelId: string; reason: string }>;
  withoutSimhash: number;
}

/** Parse every snapshot posting once, in id order. */
export function preparePostings(raws: readonly Pick<SnapshotRaw, "id" | "channel_id" | "external_id" | "payload">[], options: { registry: ChannelRegistry; config: PipelineConfig }): PreparedPostings {
  const prepared: PreparedPostings = { postings: [], skipped: [], withoutSimhash: 0 };
  for (const raw of [...raws].sort((a, b) => a.id - b.id)) {
    const result = parseAndNormalize({ channelId: raw.channel_id, payloadJson: raw.payload }, options);
    if (!result.ok) {
      prepared.skipped.push({ id: raw.id, channelId: raw.channel_id, reason: result.reason });
      continue;
    }
    if (result.normalized.simhash === null) prepared.withoutSimhash += 1;
    const company = resolveCompanyName(result.normalized.companyName, options.config);
    prepared.postings.push({ id: raw.id, channelId: raw.channel_id, family: result.family, externalId: raw.external_id, normalized: result.normalized, company: company.name, companyKey: company.nameNorm });
  }
  return prepared;
}

interface MemoryJob extends JobFields {
  id: number;
  companyId: number;
  /** The apply-link priority of each linked posting. */
  priorities: number[];
}

export interface ReplayDecision {
  jobId: number;
  /** null: the posting created the job. */
  detail: MatchDetail | null;
  blockedByTitle: boolean;
}

export interface ReplayRun {
  /** Raw id -> the job it ended up in. */
  groups: Map<number, number>;
  decisions: Map<number, ReplayDecision>;
  created: number;
  merged: Record<MatchDetail["rule"], number>;
  /** SimHash merges by title relation ("none" while the guard is off). */
  simhashBy: Record<TitleRelation | "none", number>;
  blocked: number;
}

/** One replay under `config`; `postings` from `preparePostings`. Exclusions are never needed: a job in memory cannot vanish. */
export async function runReplay(postings: readonly ReplayPosting[], config: PipelineConfig): Promise<ReplayRun> {
  const run: ReplayRun = { groups: new Map(), decisions: new Map(), created: 0, merged: { same_source: 0, exact_key: 0, simhash: 0, related_company: 0 }, simhashBy: { same: 0, compatible: 0, different: 0, none: 0 }, blocked: 0 };
  const noExclusions: ReadonlySet<number> = new Set();
  const jobs = new Map<number, MemoryJob>();
  const companyIds = new Map<string, number>();
  const companyKeys = new Map<number, string>();
  const bySource = new Map<string, number[]>();
  const byCompany = new Map<number, Set<MemoryJob>>();
  const byTitle = new Map<string, Set<MemoryJob>>();
  const add = <K>(index: Map<K, Set<MemoryJob>>, key: K, job: MemoryJob): void => {
    const set = index.get(key);
    if (set) set.add(job);
    else index.set(key, new Set([job]));
  };
  const ascending = (set: Set<MemoryJob> | undefined): MemoryJob[] => [...(set ?? [])].sort((a, b) => a.id - b.id);
  const sourceKey = (family: string, externalId: string): string => `${family}\u0000${externalId}`;
  const candidate = (job: MemoryJob) => ({ id: job.id, simhash: job.simhash, title: job.title, titleNorm: job.titleNorm, locations: storedLocations(job) });

  for (const posting of postings) {
    let companyId = companyIds.get(posting.companyKey);
    if (companyId === undefined) {
      companyId = companyIds.size + 1;
      companyIds.set(posting.companyKey, companyId);
      companyKeys.set(companyId, posting.companyKey);
    }
    const ownCompany = companyId;
    const { normalized } = posting;
    const loaders: MatchLoaders = {
      sameSource: async () => {
        const found = sameSourceExternalIds(posting.family, posting.externalId).flatMap((id) => bySource.get(sourceKey(posting.family, id)) ?? []);
        return found.length === 0 ? null : { id: Math.min(...found) };
      },
      byCompanyTitle: async () => ascending(byCompany.get(ownCompany))
        .filter((job) => job.titleNorm === normalized.titleNorm)
        .map((job) => ({ id: job.id, locations: storedLocations(job) })),
      sameCompanyWithHash: async () => ascending(byCompany.get(ownCompany))
        .filter((job) => job.simhash !== null)
        .map(candidate),
      relatedCompanyByTitle: async () => ascending(byTitle.get(normalized.titleNorm))
        .filter((job) => job.simhash !== null && job.companyId !== ownCompany)
        .map((job) => ({ ...candidate(job), companyNameNorm: companyKeys.get(job.companyId) ?? "" })),
    };
    const { decision, blockedByTitle } = await decideMatch(
      { normalized, companyId: ownCompany, companyName: normalized.companyName, channelFamily: posting.family, externalId: posting.externalId, rawPostingId: posting.id },
      loaders,
      config,
      noExclusions,
    );

    const priority = config.apply_priority[posting.family as keyof PipelineConfig["apply_priority"]];
    const incoming = fieldsOf(normalized);
    let job: MemoryJob;
    const target = decision ? jobs.get(decision.jobId) : undefined;
    if (decision && target) {
      job = target;
      const merged = applyMerge(fieldsOfJob(job), incoming, sourceWins(priority, job.priorities.length === 0 ? null : Math.min(...job.priorities)), ownCompany);
      byCompany.get(job.companyId)?.delete(job);
      byTitle.get(job.titleNorm)?.delete(job);
      Object.assign(job, merged);
      run.merged[decision.rule] += 1;
      if (decision.rule === "simhash") run.simhashBy[decision.detail.title ?? "none"] += 1;
    } else {
      job = { ...incoming, id: jobs.size + 1, companyId: ownCompany, priorities: [] };
      jobs.set(job.id, job);
      run.created += 1;
      if (blockedByTitle) run.blocked += 1;
    }
    job.priorities.push(priority);
    add(byCompany, job.companyId, job);
    add(byTitle, job.titleNorm, job);
    const key = sourceKey(posting.family, posting.externalId);
    bySource.set(key, [...(bySource.get(key) ?? []), job.id]);
    run.groups.set(posting.id, job.id);
    run.decisions.set(posting.id, { jobId: job.id, detail: decision?.detail ?? null, blockedByTitle });
  }
  return run;
}

/** The config with the guard's switch or same-title limit replaced. */
export function withTitleGuard(config: PipelineConfig, change: { enabled?: boolean; sameTitleMax?: number }): PipelineConfig {
  const guard = config.dedupe.title_guard;
  return {
    ...config,
    dedupe: {
      ...config.dedupe,
      title_guard: { ...guard, enabled: change.enabled ?? guard.enabled, same_title_max_distance: change.sameTitleMax ?? guard.same_title_max_distance },
    },
  };
}

// ---------------------------------------------------------------- comparing two runs

export type RawPair = readonly [number, number];

export interface GroupingDiff {
  /** In one group before, apart now. */
  lost: RawPair[];
  /** Apart before, in one group now. */
  added: RawPair[];
  /** Postings that have both: they moved from one group to another. */
  moved: number[];
}

function pairsWithin(groups: ReadonlyMap<number, number>): Map<number, number[]> {
  const members = new Map<number, number[]>();
  for (const [raw, group] of groups) members.set(group, [...(members.get(group) ?? []), raw]);
  return members;
}

function pairsApart(from: ReadonlyMap<number, number>, to: ReadonlyMap<number, number>): RawPair[] {
  const pairs: RawPair[] = [];
  for (const members of pairsWithin(from).values()) {
    const sorted = [...members].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const [a, b] = [sorted[i] as number, sorted[j] as number];
        if (to.get(a) !== to.get(b)) pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

export function compareGroupings(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>): GroupingDiff {
  const lost = pairsApart(before, after);
  const added = pairsApart(after, before);
  const touched = (pairs: readonly RawPair[]): Set<number> => new Set(pairs.flat());
  const gained = touched(added);
  return { lost, added, moved: [...touched(lost)].filter((raw) => gained.has(raw)).sort((a, b) => a - b) };
}

// ---------------------------------------------------------------- audit of stored merges

export interface AuditPair {
  jobId: number;
  rawId: number;
  company: string;
  jobTitle: string;
  sourceTitle: string;
  jobCity: string;
  sourceCity: string;
  distance: number | null;
}

/** A small seeded generator, so that a report's sample can be drawn again. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const firstCity = (locations: ReadonlyArray<{ city: string | null; label: string }>): string => locations[0]?.city ?? locations[0]?.label ?? "-";

/** Stored jobs that hold a source whose title is `different` from the job's: every such pair, and a seeded sample of them. */
export function auditStoredMerges(snapshot: Pick<DedupeSnapshot, "jobs" | "sources">, postings: readonly ReplayPosting[], config: PipelineConfig, sample: { seed: number; size: number }): { total: number; jobs: number; sample: AuditPair[] } {
  const compiled = compileTitleGuard(config.dedupe.title_guard, config.market);
  const byId = new Map(postings.map((posting) => [posting.id, posting]));
  const jobsById = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const pairs: AuditPair[] = [];
  for (const source of [...snapshot.sources].sort((a, b) => a.job_id - b.job_id || a.raw_posting_id - b.raw_posting_id)) {
    const posting = byId.get(source.raw_posting_id);
    const job = jobsById.get(source.job_id);
    if (!posting || !job) continue;
    const locations = storedLocations({ locationsJson: job.locations_json });
    const relation = classifyTitles({ title: posting.normalized.title, titleNorm: posting.normalized.titleNorm, locations: posting.normalized.locations }, { title: job.title, titleNorm: job.title_norm, locations }, compiled);
    if (relation !== "different") continue;
    pairs.push({
      jobId: job.id,
      rawId: posting.id,
      company: job.company,
      jobTitle: job.title,
      sourceTitle: posting.normalized.title,
      jobCity: firstCity(locations),
      sourceCity: firstCity(posting.normalized.locations),
      distance: job.simhash !== null && posting.normalized.simhash !== null ? hammingDistance(job.simhash, posting.normalized.simhash) : null,
    });
  }
  const shuffled = [...pairs];
  const random = seededRandom(sample.seed);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as AuditPair, shuffled[i] as AuditPair];
  }
  return { total: pairs.length, jobs: new Set(pairs.map((pair) => pair.jobId)).size, sample: shuffled.slice(0, sample.size) };
}

// ---------------------------------------------------------------- report

export interface GuardReportInput {
  snapshot: DedupeSnapshot;
  sha256: string;
  productSha: string;
  config: PipelineConfig;
  seed: number;
  /** Same-title limits the sweep tries. */
  sweep?: readonly number[];
  registry: ChannelRegistry;
}

export interface GuardReport {
  text: string;
  before: ReplayRun;
  after: ReplayRun;
  diff: GroupingDiff;
}

function howJoined(decision: ReplayDecision | undefined): string {
  if (!decision?.detail) return "created";
  const { rule, title, distance } = decision.detail;
  return `${rule}${title ? `/${title}` : ""}${distance === null ? "" : `@${distance}`}`;
}

function pairLine(a: ReplayPosting, b: ReplayPosting, config: PipelineConfig, runs: { before: ReplayRun; after: ReplayRun }): string {
  const compiled = compileTitleGuard(config.dedupe.title_guard, config.market);
  const side = (p: ReplayPosting) => ({ title: p.normalized.title, titleNorm: p.normalized.titleNorm, locations: p.normalized.locations });
  const distance = a.normalized.simhash !== null && b.normalized.simhash !== null ? String(hammingDistance(a.normalized.simhash, b.normalized.simhash)) : "-";
  return `d=${distance} ${classifyTitles(side(a), side(b), compiled)} [${a.company}${a.companyKey === b.companyKey ? "" : ` / ${b.company}`}] "${a.normalized.title}" @${firstCity(a.normalized.locations)} | "${b.normalized.title}" @${firstCity(b.normalized.locations)} raw ${a.id}/${b.id} old ${howJoined(runs.before.decisions.get(a.id))},${howJoined(runs.before.decisions.get(b.id))} new ${howJoined(runs.after.decisions.get(a.id))},${howJoined(runs.after.decisions.get(b.id))}`;
}

/** The whole `--guard` report: header, sweep, the three lists under the current config, the audit. Only public job data. */
export async function buildGuardReport(input: GuardReportInput): Promise<GuardReport> {
  const { snapshot, config } = input;
  const prepared = preparePostings(snapshot.raws, { registry: input.registry, config });
  const byId = new Map(prepared.postings.map((posting) => [posting.id, posting]));
  const before = await runReplay(prepared.postings, withTitleGuard(config, { enabled: false }));
  const after = await runReplay(prepared.postings, withTitleGuard(config, { enabled: true }));
  const diff = compareGroupings(before.groups, after.groups);

  const out: string[] = [];
  const skipReasons = new Map<string, number>();
  for (const skip of prepared.skipped) skipReasons.set(skip.reason, (skipReasons.get(skip.reason) ?? 0) + 1);
  out.push(
    "== HEADER ==",
    `product commit: ${input.productSha}`,
    `dedupe config: ${JSON.stringify(config.dedupe)}`,
    `market: ${config.market.packId}, country ${config.market.country}`,
    `snapshot: exported ${snapshot.meta.exported_at} at ${snapshot.meta.product_sha}, rows raw=${snapshot.meta.counts.raw} source=${snapshot.meta.counts.source} job=${snapshot.meta.counts.job}, sha256 ${input.sha256}`,
    `replayed: ${prepared.postings.length} postings, without SimHash: ${prepared.withoutSimhash}, skipped: ${prepared.skipped.length}`,
    ...[...skipReasons].map(([reason, count]) => `  skipped ${count}: ${reason}`),
    "known approximation: production files postings cycle by cycle and re-parses changed payloads; the replay files each current payload once, in raw id order, and does not reproduce company renames.",
    "",
    "== SWEEP of same_title_max_distance ==",
    "run        jobs  same_source exact_key simhash(same/compatible/different/none) related blocked  lost added moved",
  );
  const row = (label: string, run: ReplayRun, change: GroupingDiff | null): string =>
    `${label.padEnd(10)} ${String(run.created).padStart(4)}  ${String(run.merged.same_source).padStart(11)} ${String(run.merged.exact_key).padStart(9)} ${`${run.merged.simhash}(${run.simhashBy.same}/${run.simhashBy.compatible}/${run.simhashBy.different}/${run.simhashBy.none})`.padEnd(38)} ${String(run.merged.related_company).padStart(7)} ${String(run.blocked).padStart(7)} ${change ? `${String(change.lost.length).padStart(5)} ${String(change.added.length).padStart(5)} ${String(change.moved.length).padStart(5)}` : "    -     -     -"}`;
  out.push(row("old rule", before, null));
  for (const limit of input.sweep ?? [3, 4, 5, 6, 7, 8]) {
    const swept = await runReplay(prepared.postings, withTitleGuard(config, { enabled: true, sameTitleMax: limit }));
    out.push(row(`same<=${limit}`, swept, compareGroupings(before.groups, swept.groups)));
  }
  out.push(row("current", after, diff), "");

  const pairs = (title: string, list: readonly RawPair[]): void => {
    out.push(`== ${title} (${list.length}) ==`);
    for (const [a, b] of list) {
      const left = byId.get(a);
      const right = byId.get(b);
      if (left && right) out.push(pairLine(left, right, config, { before, after }));
    }
    out.push("");
  };
  pairs("LOST merges: one group under the old rule, apart now", diff.lost);
  pairs("ADDED merges: apart under the old rule, one group now", diff.added);
  out.push(`== MOVED postings: from one group to another (${diff.moved.length}) ==`);
  for (const raw of diff.moved) {
    const posting = byId.get(raw);
    if (!posting) continue;
    const memberTitles = (groups: ReadonlyMap<number, number>): string =>
      [...groups]
        .filter(([other, group]) => group === groups.get(raw) && other !== raw)
        .map(([other]) => `#${other} "${byId.get(other)?.normalized.title ?? "?"}"`)
        .join(", ");
    out.push(`raw ${raw} [${posting.company}] "${posting.normalized.title}" @${firstCity(posting.normalized.locations)}\n   old with: ${memberTitles(before.groups)}\n   new with: ${memberTitles(after.groups)}`);
  }
  out.push("");

  const audit = auditStoredMerges(snapshot, prepared.postings, config, { seed: input.seed, size: 20 });
  out.push(`== AUDIT of stored merges: sources whose title is different from their job's ==`, `pairs: ${audit.total}, jobs: ${audit.jobs}, sample seed: ${input.seed}`);
  for (const pair of audit.sample) out.push(`job ${pair.jobId} raw ${pair.rawId} d=${pair.distance ?? "-"} [${pair.company}] job "${pair.jobTitle}" @${pair.jobCity} | source "${pair.sourceTitle}" @${pair.sourceCity}`);
  return { text: `${out.join("\n")}\n`, before, after, diff };
}
