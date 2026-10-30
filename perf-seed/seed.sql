-- Realistic-model seed. psql vars: njobs, span (days), snapgap (days between preference changes after the first 30 days), pclosed
\timing on
set synchronous_commit = off;
create temp table vocab as select w, row_number() over () as n from unnest(string_to_array(
'engineer software senior team platform cloud kubernetes python typescript react data pipeline machine learning model product design customer experience we are looking for you will build maintain scale distributed systems backend frontend api services infrastructure security compliance agile scrum collaboration communication english german fluent required preferred bonus benefits remote hybrid onsite office berlin munich hamburg frankfurt amsterdam london paris vienna zurich salary equity vacation days learning budget mentoring growth career opportunity responsibilities requirements qualifications years experience degree computer science mathematics statistics analytics insights dashboards sql postgres kafka spark airflow terraform aws gcp azure docker ci cd testing quality ownership impact mission startup scaleup enterprise fintech healthtech mobility energy climate ai llm research production deployment monitoring observability performance reliability on call support stakeholders roadmap strategy leadership hiring', ' ')) as w;
create temp table base_desc as
select g as i, string_agg((array(select w from vocab))[1 + floor(random()*180)::int % 180], ' ') as d
from generate_series(1, 400) g, generate_series(1, 700) k where k <= 300 + (g * 7) % 700 group by g;
create temp table locpool (i int primary key, j jsonb);
\copy locpool from pstdin

insert into channels (id, family, kind) select 'ch_' || g, (array['linkedin','ats','board','aggregator','jsearch'])[1 + g % 5], 'api' from generate_series(1, 15) g;
insert into companies (name, name_norm) select 'Company ' || g, 'company ' || g from generate_series(1, greatest(500, :njobs / 8)) g;

-- 1.7 cycles per day (weekday 2, weekend 1)
insert into cycles (kind, started_at, finished_at, status)
select 'weekday_morning', now() - (g * interval '14 hours'), now() - (g * interval '14 hours') + interval '20 min', 'succeeded'
from generate_series(1, (:span * 24 / 14)::int) g;
-- ~25 runs per cycle
insert into runs (cycle_id, channel_id, query_hash, started_at, finished_at, status, fetched, new_count)
select c.id, 'ch_' || (1 + k % 15), md5((k % 40)::text), c.started_at + k * interval '20 s', c.started_at + k * interval '20 s' + interval '1 min',
  (array['succeeded','succeeded','succeeded','succeeded','failed']::run_status[])[1 + (c.id + k) % 5], 50, 3
from cycles c, generate_series(1, 25) k;

-- jobs: uniform arrival over span; lifetime ~ exponential mean 20 days; dead jobs closed with prob pclosed (link check), else possibly_closed
create temp table jgen as
select g, now() - (random() * :span) * interval '1 day' as fs, (-20 * ln(1 - random() * 0.999)) as life, random() as rc from generate_series(1, :njobs) g;
insert into jobs (company_id, title, title_norm, locations_json, workplace, seniority, contract, salary_json, description, language, german_level_required, posted_at, first_seen_at, last_seen_at, status, simhash, skills)
select 1 + (g * 7919) % greatest(500, :njobs / 8), 'Senior Engineer ' || (g % 300), 'senior engineer ' || (g % 300),
  (select j from locpool where i = 1 + (jg.g - 1) % 120000),
  (array['onsite','hybrid','remote','unknown']::workplace[])[1 + g % 4], 'senior', (array['permanent','contract','unknown'])[1 + g % 3],
  case when g % 3 = 0 then jsonb_build_object('min', 60000 + (g % 50) * 1000, 'max', 80000 + (g % 50) * 1000, 'currency', 'EUR', 'period', 'year', 'qualityStatus', 'ok', 'base', jsonb_build_object('EUR', jsonb_build_object('min', 60000 + (g % 50)*1000, 'max', 80000 + (g%50)*1000))) end,
  (select d from base_desc where i = 1 + jg.g % 400) || ' ref ' || g, 'en', 'unknown',
  fs - interval '2 days', fs, least(now(), fs + life * interval '1 day'),
  case when fs + life * interval '1 day' > now() - interval '7 days' then 'active' when rc < :pclosed then 'closed' else 'possibly_closed' end::job_status,
  lpad(to_hex((g * 2654435761) % 4294967296), 8, '0') || lpad(to_hex((g * 40503) % 4294967296), 8, '0'), array['python','sql']
from jgen jg order by fs;
-- closed_at for the score model: 7..30 days after last seen
create temp table jclosed as select id, last_seen_at + interval '7 days' + random() * interval '23 days' as closed_at from jobs where status = 'closed';

-- raw postings / sources: 1.3 per job (production ratio 1526/1184 at the 10-10 dump)
insert into raw_postings (channel_id, external_id, url, payload_json, payload_hash, fetched_at, parse_status, run_id)
select 'ch_' || (1 + j.id % 15) , 'ext-' || j.id || '-' || k, 'https://example.test/' || j.id || '/' || k,
  jsonb_build_object('title', j.title, 'company', 'Company ' || j.company_id, 'description', j.description, 'location', 'Berlin', 'meta', jsonb_build_object('n', j.id)),
  md5(j.id || '-' || k), j.last_seen_at, 'parsed', 1 + j.id % (select count(*) from runs)
from jobs j, generate_series(1, 2) k where k = 1 or j.id % 10 < 3;
insert into job_sources (job_id, raw_posting_id, channel_id, url, priority, first_seen_at)
select split_part(r.external_id, '-', 2)::bigint, r.id, r.channel_id, r.url, 100, r.fetched_at from raw_postings r;

-- preference snapshots: 6 in the first 30 days (tuning), then one every :snapgap days
insert into profile_snapshots (kind, content_yaml, hash, saved_at)
select 'preferences', 'v' || t, md5('v' || t), t from (
  select now() - :span * interval '1 day' + g * interval '5 days' as t from generate_series(0, 5) g
  union all select now() - :span * interval '1 day' + interval '30 days' + g * :snapgap * interval '1 day' from generate_series(1, greatest(0, ((:span - 30) / :snapgap)::int)) g
) s where t < now() order by t;
create temp table snaps as select id, saved_at, coalesce(lead(saved_at) over (order by saved_at), 'infinity'::timestamptz) as until, id = (select max(id) from profile_snapshots) as latest from profile_snapshots;

-- a row per (job, snapshot) while the job existed and was not closed; passed ~35%; AI score only when passed and the job was active then
insert into scores (job_id, profile_snapshot_id, provider, model, filter_result, filter_reasons, score, ai_score, prompt_version, scored_at, signal_bonus, rank_value, fit_reasons, gaps, summaries, output_lang, stale, created_at)
select j.id, s.id, 'claude', 'm', case when (j.id * 7 + s.id) % 20 < 7 then 'passed' else 'filtered_out' end::filter_result, '{}',
  sc, sc, 'v1', case when sc is not null then ct + interval '5 min' end, 0, sc::numeric,
  array['fit one reason text here that is moderately long','second fit reason'], array['a gap'], jsonb_build_object('en', 'One line summary of the job ' || j.id, 'zh', '摘要 ' || j.id), 'en',
  sc is not null and not s.latest, ct
from jobs j
join snaps s on s.until > j.first_seen_at and s.saved_at <= now()
left join jclosed c on c.id = j.id
cross join lateral (select greatest(s.saved_at, j.first_seen_at) + interval '1 min' as ct) t
cross join lateral (select case when (j.id * 7 + s.id) % 20 < 7 and (j.first_seen_at >= s.saved_at or j.last_seen_at > s.saved_at) then (j.id * 13 + s.id) % 100 end as sc) x
where c.closed_at is null or c.closed_at > s.saved_at;

insert into signals (job_id, tier, kind, value_json, quote, quote_offset, extractor)
select j.id, (array['T1','T2','T3','T4','tag'])[1 + k], 'kw', null, 'quote text ' || k, k * 10, 'rule' from jobs j, generate_series(0, 4) k;
insert into signal_scans (job_id, description_hash, rules_hash, salary_hash, candidate_count)
select id, md5(description), 'rules1', md5(coalesce(salary_json::text, '')), 3 from jobs;
insert into trap_scans (job_id, description_hash, sources_hash, rules_hash) select j.id, md5(coalesce(j.description, '')), 'x', 'rules1' from jobs j;
insert into job_visa (job_id, status, evidence, input_hash) select id, 'not_mentioned', '[]', 'h' from jobs;
insert into job_ghost (job_id, level, score, evidence, input_hash) select id, 'none', 0, '[]', 'h' from jobs;
insert into job_seen (job_id, via, seen_at) select id, 'detail', first_seen_at + interval '1 day' from jobs where id % 5 <> 0 and first_seen_at < now() - interval '1 day';
insert into applications (job_id, status) select id, (array['interested','applied','interviewing','rejected','archived']::application_status[])[1 + id % 5] from jobs where id % 60 = 0;
insert into job_favorites (job_id) select id from jobs where id % 150 = 0;
insert into ai_usage (provider, task, model, tokens_in, tokens_out, duration_ms, outcome, cost_estimate, job_id, at)
select 'claude', 'score', 'm', 3000, 400, 5000, 'ok', 0, job_id, scored_at from scores where score is not null;
insert into control_requests (kind, payload, status, result, requested_at, finished_at)
select (array['run_ai','translate_job','run_cycle','score_jobs','breakdown_job']::control_request_kind[])[1 + g % 5],
  case when g % 5 in (1, 4) then jsonb_build_object('jobId', 1 + (g * 37) % :njobs) else jsonb_build_object('cycleId', 1) end,
  'done', jsonb_build_object('ok', true), now() - g * interval '2 hours', now() - g * interval '2 hours' + interval '1 min'
from generate_series(1, :span * 12) g;
insert into notifications (kind, cycle_id, payload_json, sent_at)
select 'job', (select min(id) from cycles), jsonb_build_object('jobId', j.id, 'text', repeat('x', 300)), j.first_seen_at + interval '1 hour' from jobs j where j.id % 4 = 0;
vacuum analyze;
select status, count(*) from jobs group by 1 order by 1;
select (select count(*) from scores) as scores, (select count(*) from scores where score is not null) as scored, (select count(*) from profile_snapshots) as snaps, (select count(*) from cycles) as cycles, (select count(*) from raw_postings) as raw;
select pg_size_pretty(pg_total_relation_size('jobs')) jobs, pg_size_pretty(pg_total_relation_size('scores')) scores, pg_size_pretty(pg_total_relation_size('raw_postings')) raw;
