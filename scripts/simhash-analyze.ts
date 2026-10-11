/**
 * Calibrate the SimHash dedupe threshold on real data (left over from the pipeline work). READ-ONLY.
 *
 *   pnpm simhash:analyze [--container job-radar-db-1] [--max 10] [--input postings.ndjson]
 *
 * Reads every parsed raw posting and its job link (`job_sources`) through `docker exec <container> psql` in a
 * read-only session (or from an NDJSON file with {id, channel_id, job_id, payload_json} per line), normalizes each
 * with the production code (channel `parse`, `normalizeDraft`, `simhash`), then prints all pairs of postings whose
 * Hamming distance is 0..max, with company / title / city so a human can judge duplicate vs different job:
 *
 *   - same-company pairs (what `dedupe.simhash_max_distance` decides), split into "already one job" and "two jobs";
 *   - pairs of different companies (what `cross_company_simhash_max_distance` decides) are only counted.
 *
 * "already one job" pairs are merged postings: they show how far real duplicates are apart. "two jobs" pairs at a
 * distance <= the threshold would merge: judge each one by hand. A second section does the same for the stored jobs
 * (`jobs.simhash`, what a NEW posting is compared with): pairs of same-company jobs that were NOT merged. Only public
 * job titles, company names and cities are printed.
 */
import { execFileSync } from "node:child_process";
import { loadPipeline } from "../src/lib/market";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { registerBuiltinChannels } from "../src/lib/channels/builtin";
import { defaultRegistry } from "../src/lib/channels/registry";
import { normalizedPostingDraftSchema } from "../src/lib/channels/types";
import type { JobLocation } from "../src/lib/domain/types";
import { resolveCompanyName } from "../src/lib/pipeline/company";
import { sameCity } from "../src/lib/pipeline/dedupe";
import { normalizeDraft } from "../src/lib/pipeline/normalize";
import { hammingDistance } from "../src/lib/pipeline/simhash";

interface Row {
  id: number;
  channel_id: string;
  job_id: number | null;
  payload_json: unknown;
}

interface Posting {
  id: number;
  channel: string;
  jobId: number | null;
  company: string;
  companyKey: string;
  title: string;
  titleNorm: string;
  city: string;
  locations: JobLocation[];
  words: number;
  hash: string;
}

interface Pair {
  d: number;
  a: Posting;
  b: Posting;
}

const QUERY = `select row_to_json(t) from (
  select r.id, r.channel_id, (select min(s.job_id) from job_sources s where s.raw_posting_id = r.id) as job_id, r.payload_json
  from raw_postings r where r.parse_status = 'parsed' order by r.id) t`;

const JOBS_QUERY = `select row_to_json(t) from (
  select j.id, c.name_norm as company_key, c.name as company, j.title, j.title_norm, j.simhash,
    j.locations_json->0->>'city' as city, (select count(*) from job_sources s where s.job_id = j.id) as sources
  from jobs j join companies c on c.id = j.company_id where j.simhash is not null order by j.id) t`;

function psql(container: string, query: string): string {
  return execFileSync("docker", ["exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on", container, "psql", "-U", "jobradar", "-d", "jobradar", "-At", "-c", query], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
}

interface JobRow {
  id: number;
  company_key: string;
  company: string;
  title: string;
  title_norm: string;
  simhash: string;
  city: string | null;
  sources: number;
}

function lines<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function loadRows(input: string | undefined, container: string): Row[] {
  const text = input ? readFileSync(input, "utf8") : psql(container, QUERY);
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
}

/**
 * Replay the pipeline's matching over the postings in id order (exact key = same company + same normalized title +
 * same city, then SimHash within `threshold` bits of an existing job of the same company; a job keeps the SimHash of
 * the posting that created it) and count the SimHash merges per threshold, split by "same normalized title" (the
 * same role seen in another city or source: a true merge) and "different title" (usually a different job: a false
 * merge unless the titles only differ by a city suffix / "Sr." prefix). Approximation: the real pipeline also swaps
 * a job's description when a better source arrives.
 */
function replay(postings: Posting[], current: number, max: number): void {
  console.log(`== REPLAY of the matching (current threshold ${current}) ==\n  T  jobs  exact  simhash(same-title / diff-title)`);
  let detail: { p: Posting; to: Posting; d: number }[] = [];
  for (let t = 0; t <= max; t += 1) {
    const jobs: Posting[] = [];
    let exact = 0;
    let sameTitle = 0;
    let diffTitle = 0;
    const merges: { p: Posting; to: Posting; d: number }[] = [];
    for (const p of postings) {
      const peers = jobs.filter((j) => j.companyKey === p.companyKey);
      if (peers.some((j) => j.titleNorm === p.titleNorm && sameCity(j.locations, p.locations))) {
        exact += 1;
        continue;
      }
      const hit = peers.find((j) => hammingDistance(j.hash, p.hash) <= t);
      if (!hit) {
        jobs.push(p);
        continue;
      }
      if (hit.titleNorm === p.titleNorm) sameTitle += 1;
      else diffTitle += 1;
      merges.push({ p, to: hit, d: hammingDistance(hit.hash, p.hash) });
    }
    console.log(`  ${t}  ${String(jobs.length).padStart(4)}  ${String(exact).padStart(5)}  ${sameTitle} / ${diffTitle}`);
    if (t === max) detail = merges;
  }
  detail.sort((x, y) => x.d - y.d);
  console.log(`\nSimHash merges at T=${max}, by the distance they were made at:`);
  for (const m of detail) {
    console.log(`d=${m.d} ${m.p.titleNorm === m.to.titleNorm ? "same-title" : "diff-title"}\n   to  #${m.to.id} [${m.to.company}] "${m.to.title}" @${m.to.city}\n   new #${m.p.id} [${m.p.company}] "${m.p.title}" @${m.p.city}`);
  }
  console.log("");
}

function main(): number {
  const { values } = parseArgs({
    options: { container: { type: "string", default: "job-radar-db-1" }, max: { type: "string", default: "10" }, input: { type: "string" } },
    strict: true,
  });
  const max = Number(values.max);
  const config = loadPipeline();
  registerBuiltinChannels(defaultRegistry);

  const postings: Posting[] = [];
  let skipped = 0;
  for (const row of loadRows(values.input, values.container as string)) {
    try {
      const channel = defaultRegistry.get(row.channel_id);
      if (!channel) throw new Error("unknown channel");
      const draft = normalizedPostingDraftSchema.parse(channel.parse(row.payload_json));
      const n = normalizeDraft(draft, config);
      if (n.simhash === null) {
        skipped += 1;
        continue;
      }
      postings.push({
        id: row.id,
        channel: row.channel_id,
        jobId: row.job_id,
        company: n.companyName,
        companyKey: resolveCompanyName(n.companyName, config).nameNorm,
        title: n.title,
        titleNorm: n.titleNorm,
        city: n.locations[0]?.city ?? n.locations[0]?.label ?? "-",
        locations: n.locations,
        words: n.description.split(/\s+/).length,
        hash: n.simhash,
      });
    } catch {
      skipped += 1;
    }
  }
  console.log(
    `postings with a SimHash: ${postings.length} (skipped: ${skipped}); current thresholds: same company <= ${config.dedupe.simhash_max_distance}, related company <= ${config.dedupe.cross_company_simhash_max_distance}\n`,
  );

  const sameCompany: Pair[] = [];
  let crossCompany = 0;
  for (let i = 0; i < postings.length; i += 1) {
    for (let j = i + 1; j < postings.length; j += 1) {
      const a = postings[i] as Posting;
      const b = postings[j] as Posting;
      const d = hammingDistance(a.hash, b.hash);
      if (d > max) continue;
      if (a.companyKey === b.companyKey) sameCompany.push({ d, a, b });
      else crossCompany += 1;
    }
  }
  sameCompany.sort((x, y) => x.d - y.d);

  const histogram = (pairs: Pair[]): string => {
    const counts = new Array<number>(max + 1).fill(0);
    for (const p of pairs) counts[p.d] = (counts[p.d] ?? 0) + 1;
    return counts.map((c, d) => `d${d}:${c}`).join("  ");
  };
  const oneJob = sameCompany.filter((p) => p.a.jobId !== null && p.a.jobId === p.b.jobId);
  const twoJobs = sameCompany.filter((p) => p.a.jobId === null || p.a.jobId !== p.b.jobId);
  console.log(`same company, already one job: ${oneJob.length}\n  ${histogram(oneJob)}`);
  console.log(`same company, two jobs:        ${twoJobs.length}\n  ${histogram(twoJobs)}`);
  console.log(`different companies (not listed): ${crossCompany}\n`);

  const show = (p: Posting): string => `#${p.id} ${p.channel} job=${p.jobId ?? "-"} [${p.company}] "${p.title}" @${p.city} (${p.words}w)`;
  const groups: [string, Pair[]][] = [
    ["TWO JOBS (judge by hand)", twoJobs],
    ["ALREADY ONE JOB", oneJob],
  ];
  for (const [label, pairs] of groups) {
    console.log(`== ${label} ==`);
    for (const p of pairs) {
      const sameTitle = p.a.titleNorm === p.b.titleNorm ? "same-title" : "diff-title";
      const sameCity = p.a.city.toLowerCase() === p.b.city.toLowerCase() ? "same-city" : "diff-city";
      console.log(`d=${p.d} ${sameTitle} ${sameCity}\n   ${show(p.a)}\n   ${show(p.b)}`);
    }
    console.log("");
  }

  replay(postings, config.dedupe.simhash_max_distance, max);
  if (values.input) return 0;
  const jobs = lines<JobRow>(psql(values.container as string, JOBS_QUERY));
  const jobPairs: { d: number; a: JobRow; b: JobRow }[] = [];
  for (let i = 0; i < jobs.length; i += 1) {
    for (let j = i + 1; j < jobs.length; j += 1) {
      const a = jobs[i] as JobRow;
      const b = jobs[j] as JobRow;
      if (a.company_key !== b.company_key) continue;
      const d = hammingDistance(a.simhash, b.simhash);
      if (d <= max) jobPairs.push({ d, a, b });
    }
  }
  jobPairs.sort((x, y) => x.d - y.d);
  const counts = new Array<number>(max + 1).fill(0);
  for (const p of jobPairs) counts[p.d] = (counts[p.d] ?? 0) + 1;
  console.log(`== STORED JOBS, same company, NOT merged (${jobs.length} jobs) ==\n  ${counts.map((c, d) => `d${d}:${c}`).join("  ")}`);
  const showJob = (x: JobRow): string => `job ${x.id} [${x.company}] "${x.title}" @${x.city ?? "-"} (${x.sources} src)`;
  for (const p of jobPairs) {
    console.log(`d=${p.d} ${p.a.title_norm === p.b.title_norm ? "same-title" : "diff-title"}\n   ${showJob(p.a)}\n   ${showJob(p.b)}`);
  }
  return 0;
}

process.exitCode = main();
