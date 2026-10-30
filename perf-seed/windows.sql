-- realistic cycle windows: the newest jobs were first seen inside the 14 most recent cycles (~60 per cycle), their scores scored in the same cycle
with r as (select id, started_at, row_number() over (order by started_at desc) rn from cycles order by started_at desc limit 14),
  j as (select id, row_number() over (order by first_seen_at desc) rn from jobs order by first_seen_at desc limit 14*60)
update jobs set first_seen_at = r.started_at + interval '5 min' from j, r where jobs.id = j.id and r.rn = 1 + (j.rn - 1) / 60;
update scores s set scored_at = j.first_seen_at + interval '10 min', created_at = j.first_seen_at + interval '6 min' from jobs j where j.id = s.job_id and s.score is not null and j.first_seen_at > now() - interval '9 days' and s.created_at < j.first_seen_at + interval '1 hour';
vacuum analyze jobs; vacuum analyze scores;
