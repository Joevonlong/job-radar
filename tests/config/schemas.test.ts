// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CONFIG_NAMES, configRegistry, isValidCron, isValidTimeZone, type ConfigName } from "@/lib/config";
import { unsafePhraseReason } from "@/lib/config/schemas/common";

import { shippedYaml } from "./helpers";

const FILES: Record<ConfigName, string> = {
  activityLog: "activity-log.yaml",
  jobArchive: "job-archive.yaml",
  currentScores: "current-scores.yaml",
  schedule: "schedule.yaml",
  search: "search.yaml",
  jobSearch: "job-search.yaml",
  channels: "sources.yaml",
  ai: "ai.yaml",
  breakdown: "breakdown.yaml",
  models: "models.yaml",
  notify: "notify.yaml",
  interests: "interests.yaml",
  pipeline: "pipeline.yaml",
  pipelineBoard: "pipeline-board.yaml",
  resume: "resume.yaml",
  insights: "insights.yaml",
  ui: "ui.yaml",
  setup: "setup.yaml",
  traps: "traps.yaml",
  salary: "salary.yaml",
  signalPresets: "signal-presets.yaml",
  deliveryAudit: "delivery-audit.yaml",
  mcp: "mcp.yaml",
  language: "language.yaml",
  me: "profile.example/me.yaml",
  preferences: "profile.example/preferences.yaml",
};

type Json = Record<string, unknown>;

/** Deep clone so cases can mutate freely. */
function fixture(name: ConfigName): Json {
  return structuredClone(shippedYaml(FILES[name]));
}

function issuePaths(name: ConfigName, input: unknown): string[] {
  const result = configRegistry[name].schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => (i.code === "unrecognized_keys" ? [...i.path, ...i.keys].join(".") : i.path.join(".")));
}

function at(obj: unknown, ...keys: Array<string | number>): Json {
  let cur: unknown = obj;
  for (const k of keys) cur = (cur as Record<string | number, unknown>)[k];
  return cur as Json;
}

describe("shipped defaults", () => {
  it.each(CONFIG_NAMES)("%s accepts the shipped file", (name) => {
    expect(configRegistry[name].schema.safeParse(fixture(name)).success).toBe(true);
  });

  it("matches the documented default values", () => {
    const schedule = fixture("schedule");
    expect(schedule.timezone).toBe("Europe/Berlin");
    expect(at(schedule, "cycles", "weekday_morning").cron).toBe("0 7 * * 1-5");
    expect(at(schedule, "cycles", "weekday_evening").cron).toBe("0 17 * * 1-5");
    expect(at(schedule, "cycles", "weekend").cron).toBe("0 9 * * 0,6");
    expect(fixture("search").window_hours).toEqual({ morning: 24, evening: 10, weekend: 24 });
    expect(fixture("ai").per_cycle_limit).toBe(80);
    expect(fixture("notify").push_min_score_high_value).toBe(60);
    expect(fixture("preferences").salary_floor_year).toBe(70000);
    expect((fixture("channels").ats_boards as unknown[]).length).toBe(103);
    expect(fixture("channels").registry).toMatchObject({ window_days: 7, board_failing_after: 2, board_stale_hours: 48, import_max_bytes: 524288 });
  });

  it("rejects an unknown top-level key in every file (typo guard)", () => {
    for (const name of CONFIG_NAMES) {
      expect(issuePaths(name, { ...fixture(name), typo_key: 1 })).toContain("typo_key");
    }
  });
});

describe("schedule", () => {
  it("rejects a bad cron, an unknown timezone and a wrong type", () => {
    const bad = fixture("schedule");
    at(bad, "cycles", "weekend").cron = "0 25 * * *";
    bad.timezone = "Mars/Olympus";
    bad.catch_up = "yes";
    expect(issuePaths("schedule", bad)).toEqual(expect.arrayContaining(["cycles.weekend.cron", "timezone", "catch_up"]));
  });

  it("parses cron with croner and explains what is wrong", () => {
    const messages = (cron: string): string[] => {
      const bad = fixture("schedule");
      at(bad, "cycles", "weekend").cron = cron;
      const result = configRegistry.schedule.schema.safeParse(bad);
      return result.success ? [] : result.error.issues.map((i) => i.message);
    };
    expect(messages("0 25 * * *")).toEqual([expect.stringMatching(/invalid cron expression: .*hour/i)]);
    expect(messages("0 7 * *")).toEqual([expect.stringMatching(/exactly 5 fields.*got 4/)]);
    expect(messages("0 7 * * * *")).toEqual([expect.stringMatching(/exactly 5 fields.*got 6/)]);
    expect(messages("")).toEqual([expect.stringMatching(/exactly 5 fields.*got 0/)]);
    expect(messages("@daily")).toEqual([expect.stringMatching(/exactly 5 fields/)]);
    expect(messages("0 9 * * 0,6")).toEqual([]);
    expect(messages("0 9 L * *")).toEqual([]); // croner extensions that fit in 5 fields are fine
  });

  it("cron validator accepts common forms and rejects malformed ones", () => {
    for (const ok of ["0 7 * * 1-5", "*/15 * * * *", "0 9 * * 0,6", "30 6 1 JAN MON", "0 0 * * 7"]) expect(isValidCron(ok)).toBe(true);
    for (const bad of ["", "0 7 * *", "60 * * * *", "* * 0 * *", "* * * 13 *", "a b c d e", "*/0 * * * *", "1-2-3 * * * *", "0 7 * * * *"]) {
      expect(isValidCron(bad)).toBe(false);
    }
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Nope/Nope")).toBe(false);
  });
});

describe("search", () => {
  it("rejects empty groups, non-positive limits and a bad remote scope", () => {
    const bad = fixture("search");
    bad.keyword_groups = { engineering: [] };
    bad.max_per_group_per_location = 0;
    bad.remote_scope = "anywhere";
    expect(issuePaths("search", bad)).toEqual(
      expect.arrayContaining(["keyword_groups.engineering", "max_per_group_per_location", "remote_scope"]),
    );
  });
});

describe("channels", () => {
  it("rejects a negative budget, inverted throttle and unknown cascade id", () => {
    const bad = fixture("channels");
    at(bad, "linkedin", "brightdata").monthly_budget_usd = -1;
    at(bad, "linkedin", "guest").throttle = { min_delay_ms: 5000, max_delay_ms: 100 };
    at(bad, "linkedin").cascade = ["linkedin-brightdata", "linkedin-magic"];
    const paths = issuePaths("channels", bad);
    expect(paths).toContain("linkedin.brightdata.monthly_budget_usd");
    expect(paths).toContain("linkedin.guest.throttle.min_delay_ms");
    expect(paths).toContain("linkedin.cascade.1");
  });

  it("fills in collect.concurrency and the http defaults when they are missing", () => {
    const raw = fixture("channels");
    delete raw.collect;
    delete raw.http;
    const parsed = configRegistry.channels.schema.parse(raw);
    expect(parsed.collect).toEqual({ concurrency: 3, query_rotation: true, max_catch_up_hours: 168, catch_up_tolerance_hours: 6, max_backfill_hours: 168 });
    expect(parsed.http).toEqual({ timeout_ms: 30000, max_retries: 3, backoff_base_ms: 1000, backoff_max_ms: 30000 });
  });

  it("ships the jobspy sidecar block (default proxies empty) and fills it in when missing", () => {
    const ch = fixture("channels");
    expect(ch.jobspy).toMatchObject({ url: "http://127.0.0.1:8000", country_indeed: "germany", proxies: [] });
    delete ch.jobspy;
    expect(configRegistry.channels.schema.parse(ch).jobspy.proxies).toEqual([]);
    const bad = fixture("channels");
    at(bad, "jobspy").url = "ftp://nope";
    at(bad, "jobspy").proxies = [""];
    expect(issuePaths("channels", bad)).toEqual(expect.arrayContaining(["jobspy.url", "jobspy.proxies.0"]));
  });

  it("ships jobspy_google disabled", () => {
    const ch = fixture("channels");
    expect(at(ch, "sources", "jobspy_google").enabled).toBe(false);
  });

  it("ships collect.concurrency and the http block, and validates them", () => {
    const ch = fixture("channels");
    expect(ch.collect).toEqual({ concurrency: 3 });
    expect(ch.http).toEqual({ timeout_ms: 30000, max_retries: 3, backoff_base_ms: 1000, backoff_max_ms: 30000 });
    const bad = fixture("channels");
    at(bad, "collect").concurrency = 0;
    at(bad, "http").max_retries = -1;
    (at(bad, "http") as Json).typo = 1;
    expect(issuePaths("channels", bad)).toEqual(expect.arrayContaining(["collect.concurrency", "http.max_retries", "http.typo"]));
  });

  it("has the agreed paid budgets (15 total, brightdata 5, apify 10)", () => {
    const ch = fixture("channels");
    expect(ch.paid_total_monthly_budget_usd).toBe(15);
    expect(at(ch, "linkedin", "brightdata").monthly_budget_usd).toBe(5);
    expect(at(ch, "linkedin", "apify").monthly_budget_usd).toBe(10);
  });

  it("rejects a per-channel budget above the paid total, and a missing/negative total", () => {
    const bad = fixture("channels");
    at(bad, "linkedin", "apify").monthly_budget_usd = 16;
    at(bad, "sources", "jsearch").monthly_budget_usd = 99;
    expect(issuePaths("channels", bad)).toEqual(["linkedin.apify.monthly_budget_usd", "sources.jsearch.monthly_budget_usd"]);

    const atCap = fixture("channels");
    at(atCap, "linkedin", "apify").monthly_budget_usd = 15;
    expect(configRegistry.channels.schema.safeParse(atCap).success).toBe(true);

    const noTotal = fixture("channels");
    delete noTotal.paid_total_monthly_budget_usd;
    expect(issuePaths("channels", noTotal)).toContain("paid_total_monthly_budget_usd");
    noTotal.paid_total_monthly_budget_usd = -1;
    expect(issuePaths("channels", noTotal)).toContain("paid_total_monthly_budget_usd");
  });

  it("rejects a duplicate cascade entry, a missing source and a non-boolean switch", () => {
    const bad = fixture("channels");
    at(bad, "linkedin").cascade = ["linkedin-guest", "linkedin-guest"];
    delete at(bad, "sources").gmail;
    at(bad, "sources", "lever").enabled = "true";
    const paths = issuePaths("channels", bad);
    expect(paths).toEqual(expect.arrayContaining(["linkedin.cascade", "sources.gmail", "sources.lever.enabled"]));
  });
});

describe("ai", () => {
  it("rejects a bad url, negative budget, out-of-range score and unknown provider in a task order", () => {
    const bad = fixture("ai");
    at(bad, "providers", "deepseek").base_url = "not a url";
    bad.monthly_api_budget_usd = -5;
    bad.translate_auto_min_score = 150;
    at(bad, "tasks", "score").order = ["gpt-9"];
    expect(issuePaths("ai", bad)).toEqual(
      expect.arrayContaining(["providers.deepseek.base_url", "monthly_api_budget_usd", "translate_auto_min_score", "tasks.score.order.0"]),
    );
  });

  it("accepts a per-task order override", () => {
    const ok = fixture("ai");
    at(ok, "tasks", "translate").order = ["deepseek", "api"];
    expect(configRegistry.ai.schema.safeParse(ok).success).toBe(true);
  });
});

describe("notify", () => {
  it("rejects a bad clock time, out-of-range score and non-integer count", () => {
    const bad = fixture("notify");
    at(bad, "quiet_hours").start = "25:00";
    bad.push_min_score = -1;
    bad.max_per_cycle = 2.5;
    expect(issuePaths("notify", bad)).toEqual(expect.arrayContaining(["quiet_hours.start", "push_min_score", "max_per_cycle"]));
  });
});

describe("interests", () => {
  /** The raw category list of a fixture copy. */
  const categoriesOf = (raw: Json): Json[] => (raw.signals as { categories: Json[] }).categories;
  const keyword = (id: string, over: Json = {}): Json => ({ id, kind: "keyword", label: { en: id }, color: "violet", ai_definition: "something", keywords: ["x"], ...over });

  it("rejects an invalid regex, a negative weight and a bad view id", () => {
    const bad = fixture("interests");
    const [t1, t2] = categoriesOf(bad);
    if (!t1 || !t2) throw new Error("fixture");
    t1.patterns = ["(unclosed"];
    t2.weight = -3;
    bad.views = [{ id: "Bad Id", name: "x", filters: {} }];
    expect(issuePaths("interests", bad)).toEqual(expect.arrayContaining(["signals.categories.0.patterns.0", "signals.categories.1.weight", "views.0.id"]));
  });

  it("accepts user-defined categories of every kind", () => {
    const good = fixture("interests");
    categoriesOf(good).push(keyword("visa", { icon: "🛂", high_value: true }), { id: "remote-budget", kind: "tag", label: { zh: "远程预算" }, color: "olive", tags: ["home office budget"] });
    expect(issuePaths("interests", good)).toEqual([]);
  });

  it("a category may be called like a job check (ghost, visa): only breakdown and trap are reserved", () => {
    const good = fixture("interests");
    categoriesOf(good).push(keyword("ghost"), keyword("visa"));
    expect(issuePaths("interests", good)).toEqual([]);
  });

  it("rejects duplicate ids (case-insensitive, deleted ones included), reserved ids, a second amount category and too many categories", () => {
    const dup = fixture("interests");
    categoriesOf(dup).push(keyword("t2"));
    expect(issuePaths("interests", dup)).toEqual(["signals.categories.5.id"]);

    const retired = fixture("interests");
    (retired.signals as Json).retired_categories = [keyword("visa")];
    categoriesOf(retired).push(keyword("Visa"));
    expect(issuePaths("interests", retired)).toEqual(["signals.retired_categories.0.id"]);

    const reserved = fixture("interests");
    categoriesOf(reserved).push(keyword("Breakdown"));
    expect(issuePaths("interests", reserved)).toEqual(["signals.categories.5.id"]);

    const twoAmounts = fixture("interests");
    const first = categoriesOf(twoAmounts)[0];
    categoriesOf(twoAmounts).push({ ...first, id: "pay" });
    expect(issuePaths("interests", twoAmounts)).toEqual(["signals.categories.5.kind"]);

    const many = fixture("interests");
    for (let i = 0; i < 8; i++) categoriesOf(many).push(keyword(`k${i}`));
    expect(issuePaths("interests", many)).toEqual(["signals.categories"]);
  });

  it("checks the id format, a name, the icon length, the palette and ai_confirm_only of a tag category", () => {
    const bad = fixture("interests");
    categoriesOf(bad).push(
      keyword("9lives"),
      keyword("noname", { label: {} }),
      keyword("icon", { icon: "abc" }),
      keyword("colour", { color: "red" }),
      { id: "tags", kind: "tag", label: { en: "Tags" }, color: "neutral", ai_confirm_only: true, tags: ["x"] },
    );
    expect(issuePaths("interests", bad)).toEqual(
      expect.arrayContaining(["signals.categories.5.id", "signals.categories.6.label", "signals.categories.7.icon", "signals.categories.8.color", "signals.categories.9.ai_confirm_only"]),
    );
  });

  it("an amount or keyword category needs an AI definition, a tag category does not", () => {
    const bad = fixture("interests");
    categoriesOf(bad).push(keyword("visa", { ai_definition: undefined }), { id: "perks", kind: "tag", label: { en: "Perks" }, color: "neutral", tags: ["x"] });
    expect(issuePaths("interests", bad)).toEqual(["signals.categories.5.ai_definition"]);
  });

  it("shipped T1 patterns match typical salary phrases", () => {
    const amount = categoriesOf(fixture("interests")).find((c) => c.kind === "amount") as { patterns: string[] };
    const patterns = amount.patterns.map((p) => new RegExp(p, "iu"));
    const hits = (s: string) => patterns.some((p) => p.test(s));
    expect(hits("Salary: €85,000–105,000 per year")).toBe(true);
    expect(hits("up to 120k")).toBe(true);
    expect(hits("90.000 EUR brutto")).toBe(true);
    expect(hits("Gehalt: 70.000 - 90.000")).toBe(true);
    expect(hits("We offer a great team")).toBe(false);
  });
});

describe("ats_boards (sources.yaml)", () => {
  const withBoards = (boards: unknown[]): Json => ({ ...fixture("channels"), ats_boards: boards });

  it("rejects an unknown ats and a bad token", () => {
    const bad = withBoards([
      { name: "A", ats: "workday", token: "a", enabled: true },
      { name: "B", ats: "lever", token: "has space", enabled: true },
    ]);
    expect(issuePaths("channels", bad)).toEqual(expect.arrayContaining(["ats_boards.0.ats", "ats_boards.1.token"]));
  });

  it("rejects the removed `watched` field (watched companies live in interests.yaml)", () => {
    expect(issuePaths("channels", withBoards([{ name: "A", ats: "lever", token: "a", enabled: true, watched: true }]))).toEqual(["ats_boards.0.watched"]);
  });

  it("rejects duplicate ats + token (case-insensitive) and an EU region outside Lever", () => {
    const bad = withBoards([
      { name: "C", ats: "lever", token: "dup", enabled: true },
      { name: "D", ats: "lever", token: "DUP", enabled: true },
      { name: "E", ats: "greenhouse", token: "dup", enabled: true, region: "eu" },
    ]);
    expect(issuePaths("channels", bad)).toEqual(["ats_boards.1.token", "ats_boards.2.region"]);
  });

  it("fills the registry block with its defaults when the file has none (legacy compatibility mode)", () => {
    const without = fixture("channels");
    delete without.registry;
    const parsed = configRegistry.channels.schema.parse(without);
    expect(parsed.registry).toMatchObject({ window_days: 7, board_page_urls: { lever_eu: "https://jobs.eu.lever.co/{token}" } });
  });

  it("requires {token} in every career page template and rejects unknown registry keys", () => {
    const raw = fixture("channels") as Json & { registry: Json & { board_page_urls: Json } };
    const bad = { ...raw, registry: { ...raw.registry, extra: 1, board_page_urls: { ...raw.registry.board_page_urls, ashby: "https://example.com/" } } };
    expect(issuePaths("channels", bad)).toEqual(expect.arrayContaining(["registry.extra", "registry.board_page_urls.ashby"]));
  });
});

describe("me", () => {
  it("rejects a bad level, multi-language entries, negative years and wrong types", () => {
    const bad = fixture("me");
    bad.languages = [{ en: "D9" }, { de: "B1", fr: "A1" }];
    bad.years_experience = -2;
    bad.needs_visa_sponsorship = "no";
    const paths = issuePaths("me", bad);
    expect(paths).toContain("years_experience");
    expect(paths).toContain("needs_visa_sponsorship");
    expect(paths.some((p) => p.startsWith("languages"))).toBe(true);
  });
});

describe("preferences", () => {
  it("rejects a bad enum, negative salary, overlapping contracts and an empty workplace list", () => {
    const bad = fixture("preferences");
    bad.seniority = "god";
    bad.salary_floor_year = -1;
    bad.workplace = [];
    bad.contracts = { allow: ["permanent"], exclude: ["permanent"] };
    expect(issuePaths("preferences", bad)).toEqual(
      expect.arrayContaining(["seniority", "salary_floor_year", "workplace", "contracts.exclude"]),
    );
  });
});

describe("ui ai_usage block", () => {
  it("falls back to the defaults when the file has no block", () => {
    const ui = fixture("ui") as Record<string, unknown>;
    delete ui.ai_usage;
    expect(issuePaths("ui", ui)).toEqual([]);
  });
  it("rejects a range that is not a fixed one, an empty page and an unknown key", () => {
    const bad = fixture("ui") as Record<string, unknown>;
    bad.ai_usage = { default_range: "custom", custom_max_days: 366, log_page_size: 0, csv_max_rows: 20000, extra: 1 };
    expect(issuePaths("ui", bad)).toEqual(expect.arrayContaining(["ai_usage.default_range", "ai_usage.log_page_size"]));
  });
  it("accepts the phase-2 block of the guide", () => {
    const ui = fixture("ui") as Record<string, unknown>;
    ui.ai_usage = { default_range: "30d", custom_max_days: 366, log_page_size: 50, csv_max_rows: 20000 };
    expect(issuePaths("ui", ui)).toEqual([]);
  });
});

describe("ui company drop-down keys", () => {
  it("a file without them (or without the whole filters block) reads with the defaults", () => {
    const parse = (ui: unknown) => configRegistry.ui.schema.parse(ui) as { filters: { hidden_workplaces: string[]; company_options_max: number; company_options_visible: number } };
    const older = fixture("ui") as Record<string, Record<string, unknown>>;
    older.filters = { hidden_workplaces: ["onsite"], hidden_contracts: [] };
    const read = parse(older);
    expect(read.filters.hidden_workplaces).toEqual(["onsite"]);
    expect(read.filters.company_options_max).toBeGreaterThan(0);
    expect(read.filters.company_options_visible).toBeGreaterThan(0);
    const none = fixture("ui") as Record<string, unknown>;
    delete none.filters;
    const fallback = parse(none);
    expect(fallback.filters.company_options_max).toBe(read.filters.company_options_max);
    expect(fallback.filters.company_options_visible).toBe(read.filters.company_options_visible);
  });
  it("rejects a count that is not a whole number from 1 to 5000", () => {
    const bad = fixture("ui") as Record<string, Record<string, unknown>>;
    bad.filters = { hidden_workplaces: [], hidden_contracts: [], company_options_max: 0, company_options_visible: 2.5 };
    expect(issuePaths("ui", bad)).toEqual(expect.arrayContaining(["filters.company_options_max", "filters.company_options_visible"]));
    bad.filters = { hidden_workplaces: [], hidden_contracts: [], company_options_max: 5001, company_options_visible: 10 };
    expect(issuePaths("ui", bad)).toEqual(["filters.company_options_max"]);
  });
});

describe("ui job_checks block", () => {
  it("is optional: a file without it gets the recheck on, no extra phrases, the ghost job check off and the visa check on (auto)", () => {
    const ui = fixture("ui");
    delete ui.job_checks;
    expect(issuePaths("ui", ui)).toEqual([]);
    const parsed = configRegistry.ui.schema.parse(ui) as { job_checks: unknown };
    expect(parsed.job_checks).toEqual({ closed_recheck: { enabled: true, extra_phrases: [] }, ghost: { enabled: false, trusted_companies: [] }, visa: { enabled: true, badges: "auto" } });
  });
  it("takes a switch and phrases, and names an invalid regex by its path", () => {
    const ui = fixture("ui");
    ui.job_checks = { closed_recheck: { enabled: false, extra_phrases: ["position (is )?filled"] } };
    expect(issuePaths("ui", ui)).toEqual([]);
    ui.job_checks = { closed_recheck: { enabled: true, extra_phrases: ["ok", "(unclosed"] }, other: 1 };
    expect(issuePaths("ui", ui)).toEqual(expect.arrayContaining(["job_checks.closed_recheck.extra_phrases.1", "job_checks.other"]));
  });
  it("rejects a phrase that could backtrack catastrophically, by its path", () => {
    const ui = fixture("ui");
    ui.job_checks = { closed_recheck: { enabled: true, extra_phrases: ["fine (phrase)?", "(a+)+b", "no.*longer", "x{2,}"] } };
    expect(issuePaths("ui", ui)).toEqual(["job_checks.closed_recheck.extra_phrases.1", "job_checks.closed_recheck.extra_phrases.2", "job_checks.closed_recheck.extra_phrases.3"]);
  });
});

describe("visa check settings", () => {
  it("ui.yaml job_checks.visa takes a switch and a badge mode, and rejects another mode", () => {
    const ui = fixture("ui");
    ui.job_checks = { visa: { enabled: false, badges: "always" } };
    expect(issuePaths("ui", ui)).toEqual([]);
    const parsed = configRegistry.ui.schema.parse(ui) as { job_checks: { visa: unknown } };
    expect(parsed.job_checks.visa).toEqual({ enabled: false, badges: "always" });
    ui.job_checks = { visa: { badges: "sometimes" } };
    expect(issuePaths("ui", ui)).toEqual(["job_checks.visa.badges"]);
  });

  it("pipeline.yaml job_checks is optional and gets the limits; limits out of range are named", () => {
    const pipeline = fixture("pipeline");
    delete pipeline.config_version;
    delete pipeline.job_checks;
    const parsed = configRegistry.pipeline.schema.parse(pipeline) as { job_checks: { visa: Record<string, number> } };
    expect(parsed.job_checks.visa).toEqual({ per_cycle_limit: 2000, max_quotes: 3, quote_max_chars: 280, negation_words_before: 6, negation_words_after: 5, heading_max_chars: 60 });
    pipeline.job_checks = { visa: { per_cycle_limit: 0, max_quotes: 11, quote_max_chars: 10, negation_words_before: 21, negation_words_after: -1, heading_max_chars: 5 } };
    expect(issuePaths("pipeline", pipeline).sort()).toEqual(
      ["per_cycle_limit", "max_quotes", "quote_max_chars", "negation_words_before", "negation_words_after", "heading_max_chars"].map((key) => `job_checks.visa.${key}`).sort(),
    );
    pipeline.job_checks = { visa: { negation_words_before: 0, negation_words_after: 0 } };
    expect(issuePaths("pipeline", pipeline)).toEqual([]);
  });

  it("pipeline.yaml job_checks.ghost.thin_description.infer_from_headings: true when missing, a boolean otherwise", () => {
    const pipeline = fixture("pipeline");
    delete pipeline.config_version;
    delete pipeline.job_checks;
    type Thin = { job_checks: { ghost: { thin_description: Record<string, unknown> } } };
    expect((configRegistry.pipeline.schema.parse(pipeline) as Thin).job_checks.ghost.thin_description.infer_from_headings).toBe(true);
    pipeline.job_checks = { ghost: { thin_description: { min_words: 80 } } };
    expect((configRegistry.pipeline.schema.parse(pipeline) as Thin).job_checks.ghost.thin_description).toMatchObject({ min_words: 80, infer_from_headings: true });
    pipeline.job_checks = { ghost: { thin_description: { infer_from_headings: false } } };
    expect((configRegistry.pipeline.schema.parse(pipeline) as Thin).job_checks.ghost.thin_description.infer_from_headings).toBe(false);
    pipeline.job_checks = { ghost: { thin_description: { infer_from_headings: "no" } } };
    expect(issuePaths("pipeline", pipeline)).toEqual(["job_checks.ghost.thin_description.infer_from_headings"]);
  });

  it("a saved view keeps a visa filter and rejects an unknown one", () => {
    const good = fixture("interests");
    good.views = [{ id: "sponsor", name: "Sponsor", filters: { visa: "offered" } }];
    expect(issuePaths("interests", good)).toEqual([]);
    good.views = [{ id: "sponsor", name: "Sponsor", filters: { visa: "yes" } }];
    expect(issuePaths("interests", good)).toEqual(["views.0.filters.visa"]);
  });
});

describe("closed-posting phrase patterns", () => {
  it.each([
    "\\bno longer accepting applications\\b",
    "\\bthis (?:job|position) (?:is )?no longer available\\b",
    "\\bStelle (?:ist )?(?:bereits )?(?:besetzt|vergeben)\\b",
    "[Pp]osition filled",
    "\\p{L}{2,3} closed",
    "signs in a class: [+*]",
  ])("allows %s", (source) => {
    expect(unsafePhraseReason(source)).toBeNull();
  });
  it.each([
    ["(a+)+b", "unbounded"],
    ["no.*longer", "unbounded"],
    ["x{2,}", "unbounded"],
    ["x{1,50}", "repetition"],
    ["(a)\\1", "backreferences"],
    ["a?b?c?d?e?f?g?h?i?", "optional"],
    ["x".repeat(201), "longer"],
  ])("rejects %s", (source, reason) => {
    expect(unsafePhraseReason(source)).toContain(reason);
  });
});

describe("ui", () => {
  it("ships the design-system defaults", () => {
    const ui = fixture("ui");
    expect(ui.salary_axis).toEqual({ min_k: 40, max_k: 200, tick_step_k: 20 });
    expect(ui.freshness).toEqual({ decay_hours: 72, warn_hours: 24 });
    expect([ui.trend_cycles, ui.health_cycles, ui.ticker_max_items]).toEqual([7, 14, 8]);
  });

  it("rejects an axis that is not an axis, a tick step that does not fit and warning hours past the decay", () => {
    const bad = fixture("ui");
    at(bad, "salary_axis").max_k = 40;
    at(bad, "salary_axis").tick_step_k = 0;
    at(bad, "freshness").warn_hours = 80;
    bad.trend_cycles = 1;
    bad.health_cycles = 0;
    bad.ticker_max_items = 1.5;
    expect(issuePaths("ui", bad)).toEqual(expect.arrayContaining(["salary_axis.max_k", "salary_axis.tick_step_k", "freshness.warn_hours", "trend_cycles", "health_cycles", "ticker_max_items"]));

    const wide = fixture("ui");
    at(wide, "salary_axis").tick_step_k = 160;
    expect(issuePaths("ui", wide)).toEqual(["salary_axis.tick_step_k"]);
  });

  it("is strict: unknown keys inside nested objects are typos", () => {
    const bad = fixture("ui");
    at(bad, "salary_axis").step = 5;
    expect(issuePaths("ui", bad)).toContain("salary_axis.step");
  });
});
