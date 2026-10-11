-- Market packs: salaries and T1 amounts carry the market's base currency. Rows written while the base was always EUR
-- get `basePerYear` (= their `eurPerYear`, null stays null) and `baseCurrency: EUR`. Only keys are added, so older code
-- still reads the rows; rows that already have `baseCurrency` are left alone (idempotent).
UPDATE "jobs" SET "salary_json" = "salary_json" || jsonb_build_object('basePerYear', "salary_json"->'eurPerYear', 'baseCurrency', 'EUR')
 WHERE jsonb_typeof("salary_json") = 'object' AND "salary_json" ? 'eurPerYear' AND NOT "salary_json" ? 'baseCurrency';--> statement-breakpoint
UPDATE "signals" SET "value_json" = "value_json" || jsonb_build_object('basePerYear', "value_json"->'eurPerYear', 'baseCurrency', 'EUR')
 WHERE "tier" = 'T1' AND jsonb_typeof("value_json") = 'object' AND "value_json" ? 'eurPerYear' AND NOT "value_json" ? 'baseCurrency';
