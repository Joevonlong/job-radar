import { describe, expect, it } from "vitest";

import { checkAiAgainstCatalog } from "@/lib/config/model-catalog";
import { configRegistry } from "@/lib/config/registry";
import { catalogIssuesToSettingsErrors, clientFieldErrors, configToDraft, draftToCandidate, getAt, settingsDraftSchema, toSettingsErrors, toNumber, type KeywordGroupDraft, type SettingsDraft } from "@/lib/settings/draft";
import { SETTINGS_FORMS, type SettingsForm } from "@/lib/settings/tabs";

import { shippedCatalogRaw, shippedConfig } from "./helpers";

function validate(tab: SettingsForm, candidate: unknown) {
  return configRegistry[tab].schema.safeParse(candidate);
}

/** Edit a copy of the shipped draft and return the field errors the schema reports. */
function errorsFor(tab: SettingsForm, edit: (draft: SettingsDraft) => void) {
  const config = shippedConfig(tab);
  const draft = configToDraft(tab, config);
  edit(draft);
  const { candidate, errors } = draftToCandidate(tab, draft, config);
  const result = validate(tab, candidate);
  return [...errors, ...(result.success ? [] : toSettingsErrors(tab, result.error))];
}

describe("config <-> draft", () => {
  it.each(SETTINGS_FORMS)("%s: an untouched draft gives back exactly the config", (tab) => {
    const config = shippedConfig(tab);
    const { candidate, errors } = draftToCandidate(tab, configToDraft(tab, config), config);
    expect(errors).toEqual([]);
    expect(candidate).toEqual(config);
    expect(validate(tab, candidate).success).toBe(true);
  });

  it("the draft is JSON that its zod schema accepts", () => {
    for (const tab of SETTINGS_FORMS) {
      const draft = configToDraft(tab, shippedConfig(tab));
      expect(settingsDraftSchema.safeParse(JSON.parse(JSON.stringify(draft))).success, tab).toBe(true);
    }
  });

  it("keeps keys the form does not show (jobspy proxies)", () => {
    const config = shippedConfig("channels") as { jobspy: { proxies: string[] } };
    const withProxy = structuredClone(config);
    withProxy.jobspy.proxies = ["http://user:secret@proxy.example.test:8080"];
    const draft = configToDraft("channels", withProxy);
    expect(JSON.stringify(draft)).not.toContain("secret");
    const { candidate } = draftToCandidate("channels", draft, withProxy);
    expect((candidate as typeof config).jobspy.proxies).toEqual(["http://user:secret@proxy.example.test:8080"]);
  });

  it("edits a region remote scope as its key and gives the list back", () => {
    const config = { ...(shippedConfig("search") as Record<string, unknown>), remote_scope: { region: ["eu", "CH"] } };
    const draft = configToDraft("search", config);
    expect(draft.remote_scope).toBe("region:eu,CH");
    expect(draftToCandidate("search", draft, config).candidate).toEqual(config);
    draft.remote_scope = "region:";
    expect(validate("search", draftToCandidate("search", draft, config).candidate).success).toBe(false);
    // an old value is shown as the new one
    expect(configToDraft("search", { ...config, remote_scope: "eu_any" }).remote_scope).toBe("region:eu");
  });

  it("applies edits: numbers, switches, lists, groups, order and prices", () => {
    const config = shippedConfig("search");
    const draft = configToDraft("search", config);
    draft["window_hours.morning"] = "36";
    draft.remote_scope = "worldwide";
    draft.locations = ["Berlin", "Hamburg"];
    draft.keyword_groups = [...(draft.keyword_groups as KeywordGroupDraft[]), { id: "data", keywords: ["Data Engineer"] }];
    const { candidate } = draftToCandidate("search", draft, config);
    const parsed = configRegistry.search.schema.parse(candidate);
    expect(parsed.window_hours.morning).toBe(36);
    expect(parsed.remote_scope).toBe("worldwide");
    expect(parsed.locations).toEqual(["Berlin", "Hamburg"]);
    expect(parsed.keyword_groups.data).toEqual(["Data Engineer"]);

    const channels = shippedConfig("channels");
    const channelsDraft = configToDraft("channels", channels);
    channelsDraft["linkedin.cascade"] = ["linkedin-guest", "linkedin-brightdata"];
    channelsDraft["sources.indeed.enabled"] = false;
    const edited = configRegistry.channels.schema.parse(draftToCandidate("channels", channelsDraft, channels).candidate);
    expect(edited.linkedin.cascade).toEqual(["linkedin-guest", "linkedin-brightdata"]);
    expect(edited.sources.indeed.enabled).toBe(false);

    const ai = shippedConfig("ai");
    const aiDraft = configToDraft("ai", ai);
    aiDraft["tasks.translate"] = [{ provider: "deepseek", model: "deepseek-v4-pro" }, { provider: "api", model: "" }];
    const aiEdited = configRegistry.ai.schema.parse(draftToCandidate("ai", aiDraft, ai).candidate);
    expect(aiEdited.tasks.translate).toEqual({ order: ["deepseek", "api"], models: { deepseek: "deepseek-v4-pro" } });
    // an order the form did not touch keeps whatever the file says (the user's own choice, edited in /settings)
    expect(aiEdited.tasks.score).toEqual((ai as { tasks: { score: unknown } }).tasks.score);
  });

  it("a German penalty level left empty is removed, one that is filled is added", () => {
    const ai = shippedConfig("ai");
    const draft = configToDraft("ai", ai);
    expect(draft["scoring.language_penalty.B1"]).toBe("");
    expect(draft["scoring.language_penalty.C1"]).toBe("20");
    draft["scoring.language_penalty.B1"] = "5";
    draft["scoring.language_penalty.C2"] = "";
    const parsed = configRegistry.ai.schema.parse(draftToCandidate("ai", draft, ai).candidate);
    expect(parsed.scoring.language_penalty).toEqual({ B1: 5, B2: 10, C1: 20 });
  });

  it("an optional text field left empty is removed from the file", () => {
    const ai = shippedConfig("ai");
    const draft = configToDraft("ai", ai);
    draft["providers.codex_cli.model"] = "gpt-x";
    const set = draftToCandidate("ai", draft, ai).candidate as { providers: { codex_cli: { model?: string } } };
    expect(set.providers.codex_cli.model).toBe("gpt-x");
    draft["providers.codex_cli.model"] = "  ";
    const cleared = draftToCandidate("ai", draft, set).candidate as { providers: { codex_cli: { model?: string } } };
    expect("model" in cleared.providers.codex_cli).toBe(false);
  });
});

describe("toNumber", () => {
  it("reads plain decimals and flags everything else", () => {
    expect(toNumber(" 12 ")).toBe(12);
    expect(toNumber("0.5")).toBe(0.5);
    expect(toNumber("-3")).toBe(-3);
    expect(toNumber("")).toBeUndefined();
    expect(Number.isNaN(toNumber("12abc"))).toBe(true);
    expect(Number.isNaN(toNumber("1e3"))).toBe(true);
  });
});

describe("field errors", () => {
  it("a bad cron expression is reported on that cycle's field", () => {
    const errors = errorsFor("schedule", (d) => {
      d["cycles.weekday_morning.cron"] = "0 7 * *";
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "cycles.weekday_morning.cron", key: "cron" });
    expect(errors[0]?.params?.detail).toMatch(/5 fields/);
  });

  it("an unknown time zone, a non-number and an empty required number", () => {
    const errors = errorsFor("schedule", (d) => {
      d.timezone = "Mars/Olympus";
    });
    expect(errors).toEqual([expect.objectContaining({ path: "timezone", key: "timezone" })]);
    const text = errorsFor("search", (d) => {
      d["window_hours.morning"] = "";
      d["window_hours.evening"] = "ten";
      d.max_per_group_per_location = "2.5";
    });
    expect(text).toContainEqual(expect.objectContaining({ path: "window_hours.morning", key: "required" }));
    expect(text).toContainEqual(expect.objectContaining({ path: "window_hours.evening", key: "number" }));
    expect(text).toContainEqual(expect.objectContaining({ path: "max_per_group_per_location", key: "integer" }));
  });

  it("negative and zero values name their minimum", () => {
    const errors = errorsFor("notify", (d) => {
      d["reminders.max_items"] = "0";
      d.push_min_score = "101";
      d.max_per_cycle = "-1";
      d["alerts.dedupe_hours"] = "-2";
    });
    expect(errors.map((e) => `${e.path}:${e.key}`).sort()).toEqual(["max_per_cycle:greaterThan", "push_min_score:max", "reminders.max_items:greaterThan", "alerts.dedupe_hours:greaterThan"].sort());
  });

  it("breakdown tab: edits round-trip, the hidden head share stays, bad values name their field", () => {
    const config = shippedConfig("breakdown");
    const draft = configToDraft("breakdown", config);
    draft.enabled = true;
    draft.mode = "auto";
    draft["auto.min_rank"] = "75";
    draft["auto.per_cycle_limit"] = "3";
    draft.timeout_seconds = "300";
    const edited = configRegistry.breakdown.schema.parse(draftToCandidate("breakdown", draft, config).candidate);
    expect(edited).toMatchObject({ enabled: true, mode: "auto", auto: { min_rank: 75, per_cycle_limit: 3 }, timeout_seconds: 300, jd_head_share: 0.7 });
    const errors = errorsFor("breakdown", (d) => {
      d.mode = "sometimes";
      d["auto.min_rank"] = "120";
      d.jd_max_chars = "100";
    });
    expect(errors.map((e) => e.path).sort()).toEqual(["auto.min_rank", "jd_max_chars", "mode"]);
  });

  it("number lists and nullable text: thresholds are parsed, an empty URL becomes null", () => {
    const config = { ...(shippedConfig("notify") as Record<string, unknown>), public_base_url: null };
    const draft = configToDraft("notify", config);
    expect(draft["alerts.budget_thresholds"]).toEqual(["0.8", "1"]);
    expect(draft.public_base_url).toBe("");
    draft["alerts.budget_thresholds"] = ["0.5", "0.9", "1"];
    draft.public_base_url = "https://radar.example.ts.net";
    const edited = configRegistry.notify.schema.parse(draftToCandidate("notify", draft, config).candidate);
    expect(edited.alerts.budget_thresholds).toEqual([0.5, 0.9, 1]);
    expect(edited.public_base_url).toBe("https://radar.example.ts.net");
    draft.public_base_url = "  ";
    expect(configRegistry.notify.schema.parse(draftToCandidate("notify", draft, config).candidate).public_base_url).toBeNull();

    const errors = errorsFor("notify", (d) => {
      d["alerts.budget_thresholds"] = ["abc", "2"];
    });
    expect(errors.map((e) => e.key).sort()).toEqual(["max", "number"]);
    expect(errors.every((e) => e.path === "alerts.budget_thresholds")).toBe(true);
  });

  it("clock times, budgets above the cap and throttle order", () => {
    const quiet = errorsFor("notify", (d) => {
      d["quiet_hours.start"] = "25:00";
    });
    expect(quiet).toEqual([expect.objectContaining({ path: "quiet_hours.start", key: "clockTime" })]);

    const channels = errorsFor("channels", (d) => {
      d["sources.indeed.monthly_budget_usd"] = "99";
      d["linkedin.guest.throttle.min_delay_ms"] = "9000";
      d["linkedin.brightdata.country"] = "de";
      d["sources.greenhouse.api_base_url"] = "not a url";
      d["linkedin.brightdata.poll_interval_ms"] = "900000";
    });
    expect(channels).toContainEqual(expect.objectContaining({ path: "sources.indeed.monthly_budget_usd", key: "overBudgetCap" }));
    expect(channels).toContainEqual(expect.objectContaining({ path: "linkedin.guest.throttle.min_delay_ms", key: "delayOrder" }));
    expect(channels).toContainEqual(expect.objectContaining({ path: "linkedin.brightdata.country", key: "country" }));
    expect(channels).toContainEqual(expect.objectContaining({ path: "sources.greenhouse.api_base_url", key: "url" }));
    expect(channels).toContainEqual(expect.objectContaining({ path: "linkedin.brightdata.poll_interval_ms", key: "pollOrder" }));
  });

  it("ui tab: axis order, tick step and warning hours get their own messages", () => {
    const errors = errorsFor("ui", (d) => {
      d["salary_axis.max_k"] = "30";
      d["salary_axis.tick_step_k"] = "500";
      d["freshness.warn_hours"] = "100";
    });
    expect(errors).toContainEqual(expect.objectContaining({ path: "salary_axis.max_k", key: "axisOrder" }));
    expect(errors).toContainEqual(expect.objectContaining({ path: "salary_axis.tick_step_k", key: "tickTooLarge" }));
    expect(errors).toContainEqual(expect.objectContaining({ path: "freshness.warn_hours", key: "warnOrder" }));
  });

  it("an empty cascade, a duplicate list entry and an empty keyword list", () => {
    const channels = errorsFor("channels", (d) => {
      d["linkedin.cascade"] = [];
      d["sources.greenhouse.title_prefilter.include_terms"] = ["AI", "AI"];
    });
    expect(channels).toContainEqual(expect.objectContaining({ path: "linkedin.cascade", key: "atLeastOne" }));
    expect(channels).toContainEqual(expect.objectContaining({ path: "sources.greenhouse.title_prefilter.include_terms", key: "duplicates" }));
    const search = errorsFor("search", (d) => {
      d.locations = [];
      d.keyword_groups = [{ id: "empty_group", keywords: [] }];
    });
    expect(search).toContainEqual(expect.objectContaining({ path: "locations", key: "atLeastOne" }));
    expect(search).toContainEqual(expect.objectContaining({ path: "keyword_groups", key: "atLeastOne" }));
  });

  it("keyword groups: duplicate ids and bad ids", () => {
    const duplicate = errorsFor("search", (d) => {
      d.keyword_groups = [
        { id: "a", keywords: ["x"] },
        { id: "a", keywords: ["y"] },
      ];
    });
    expect(duplicate).toEqual([expect.objectContaining({ path: "keyword_groups", key: "duplicates" })]);
    const bad = errorsFor("search", (d) => {
      d.keyword_groups = [{ id: "Not Snake", keywords: ["x"] }];
    });
    expect(bad).toContainEqual(expect.objectContaining({ path: "keyword_groups", key: "groupId" }));
  });

  it("a task's route round-trips; an empty route is {}, the api layer takes no model, a repeated provider is refused", () => {
    const config = shippedConfig("ai");
    const draft = configToDraft("ai", config);
    expect(draft["tasks.translate"]).toEqual([
      { provider: "codex-cli", model: "" },
      { provider: "claude-cli", model: "" },
      { provider: "api", model: "" },
    ]);
    draft["tasks.translate"] = [{ provider: "claude-cli", model: "claude-sonnet-5-5" }, { provider: "api", model: "ignored" }];
    expect(getAt(draftToCandidate("ai", draft, config).candidate, "tasks.translate")).toEqual({ order: ["claude-cli", "api"], models: { "claude-cli": "claude-sonnet-5-5" } });
    draft["tasks.translate"] = [];
    expect(getAt(draftToCandidate("ai", draft, config).candidate, "tasks.translate")).toEqual({});
    draft["tasks.translate"] = [{ provider: "claude-cli", model: "" }, { provider: "claude-cli", model: "" }];
    expect(draftToCandidate("ai", draft, config).errors).toEqual([{ path: "tasks.translate", key: "duplicates" }]);
  });

  it("the schema's task-model rules map to the route field", () => {
    const config = shippedConfig("ai");
    const draft = configToDraft("ai", config);
    // a model for a provider that is not in the task's order cannot be built from the form; hand-built candidates still map
    const candidate = structuredClone(draftToCandidate("ai", draft, config).candidate) as { tasks: Record<string, unknown> };
    candidate.tasks.score = { models: { "claude-cli": "claude-haiku-4-5" } };
    const result = validate("ai", candidate);
    expect(result.success).toBe(false);
    if (!result.success) expect(toSettingsErrors("ai", result.error)).toEqual([expect.objectContaining({ path: "tasks.score", key: "taskModelsNeedOrder" })]);
    candidate.tasks.score = { order: ["codex-cli"], models: { "claude-cli": "claude-haiku-4-5" } };
    const second = validate("ai", candidate);
    if (!second.success) expect(toSettingsErrors("ai", second.error)).toEqual([expect.objectContaining({ path: "tasks.score", key: "taskModelNotInOrder" })]);
    else expect.unreachable();
  });

  it("the catalog check lands on the field of the model, the effort or the task row", () => {
    const config = shippedConfig("ai");
    const draft = configToDraft("ai", config);
    draft["providers.anthropic.model"] = "claude-new";
    draft["tasks.translate"] = [{ provider: "claude-cli", model: "claude-nope" }];
    const { candidate } = draftToCandidate("ai", draft, config);
    const parsed = configRegistry.ai.schema.parse(candidate);
    const catalog = configRegistry.models.schema.parse(shippedCatalogRaw());
    const mapped = catalogIssuesToSettingsErrors("ai", checkAiAgainstCatalog(parsed, catalog));
    expect(mapped).toEqual([
      { path: "providers.anthropic.model", key: "modelNotInCatalog", params: { model: "claude-new" } },
      { path: "tasks.translate", key: "modelNotInCatalog", params: { model: "claude-nope" } },
    ]);
  });

  it("the codex model and the per-task effort are optional dropdowns", () => {
    const config = shippedConfig("ai");
    const draft = configToDraft("ai", config);
    expect(draft["providers.codex_cli.model"]).toBe("");
    expect(draft["providers.codex_cli.reasoning_effort_by_task.translate"]).toBe("");
    draft["providers.codex_cli.reasoning_effort_by_task.translate"] = "medium";
    draft["providers.codex_cli.model"] = "gpt-6.1-sol";
    const { candidate, errors } = draftToCandidate("ai", draft, config);
    expect(errors).toEqual([]);
    const parsed = validate("ai", candidate);
    expect(parsed.success).toBe(true);
    const codex = getAt(candidate, "providers.codex_cli") as { model?: string; reasoning_effort_by_task: Record<string, string> };
    expect(codex.reasoning_effort_by_task).toEqual({ translate: "medium" });
    expect(codex.model).toBe("gpt-6.1-sol");
    // back to "same as the default" / "CLI default": the keys go away again
    draft["providers.codex_cli.reasoning_effort_by_task.translate"] = "";
    draft["providers.codex_cli.model"] = "";
    const cleared = getAt(draftToCandidate("ai", draft, config).candidate, "providers.codex_cli") as Record<string, unknown>;
    expect(cleared.reasoning_effort_by_task).toEqual({});
    expect("model" in cleared).toBe(false);
  });

  it("an effort outside the enum is refused on the server", () => {
    const errors = errorsFor("ai", (d) => {
      d["providers.codex_cli.reasoning_effort"] = "turbo";
    });
    expect(errors).toEqual([expect.objectContaining({ path: "providers.codex_cli.reasoning_effort", key: "invalidChoice" })]);
    const order = errorsFor("ai", (d) => {
      d.order = ["codex-cli", "gpt-cli"];
    });
    expect(order).toContainEqual(expect.objectContaining({ path: "order" }));
  });

  it("issues without a field are reported with their config path", () => {
    // a hidden key the form cannot edit (proxy list) is kept as it is on disk; if it is invalid the error says where
    const config = structuredClone(shippedConfig("channels")) as { jobspy: { proxies: string[] } };
    config.jobspy.proxies = [""];
    const { candidate } = draftToCandidate("channels", configToDraft("channels", config), config);
    const result = validate("channels", candidate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toSettingsErrors("channels", result.error)).toEqual([expect.objectContaining({ path: "", key: "required", configPath: "jobspy.proxies.0" })]);
    }
  });
});

describe("forms for the formerly hidden keys", () => {
  it("scoring.priority: the weights, factors, seniority and location tables round-trip and name their field when wrong", () => {
    const config = shippedConfig("ai");
    const draft = configToDraft("ai", config);
    expect(Object.keys(draft).filter((path) => path.startsWith("scoring.priority.")).length).toBeGreaterThan(20);
    draft["scoring.priority.weights.title"] = "50";
    draft["scoring.priority.generic_title_words"] = ["engineer", "manager"];
    draft["scoring.priority.seniority_fit.junior"] = "0.25";
    const { candidate } = draftToCandidate("ai", draft, config);
    const parsed = configRegistry.ai.schema.parse(candidate);
    expect(parsed.scoring.priority.weights.title).toBe(50);
    expect(parsed.scoring.priority.generic_title_words).toEqual(["engineer", "manager"]);
    expect(parsed.scoring.priority.seniority_fit.junior).toBe(0.25);

    const errors = errorsFor("ai", (d) => {
      d["scoring.priority.location_fit.exact"] = "1.5";
      d["scoring.priority.recency_days"] = "0";
      d["scoring.priority.weights.signals"] = "abc";
    });
    const keys = errors.map((error) => `${error.path}:${error.key}`);
    expect(keys).toContain("scoring.priority.location_fit.exact:max");
    expect(keys).toContain("scoring.priority.recency_days:greaterThan");
    expect(keys.some((key) => key.startsWith("scoring.priority.weights.signals:"))).toBe(true);
  });

  it("schedule: the suggestion's switch / cron / limits, the LinkedIn slot, the backup age and the manual interval are fields", () => {
    const config = shippedConfig("schedule");
    const draft = configToDraft("schedule", config);
    for (const path of ["suggest.enabled", "suggest.cron", "suggest.notify", "suggest.lookback_weeks", "suggest.max_suggestions", "suggest.min_confidence", "linkedin_recommended.enabled", "linkedin_recommended.cron", "backup.max_age_hours", "manual_triggers.min_interval_seconds"]) {
      expect(draft[path], path).toBeDefined();
    }
    draft["suggest.cron"] = "0 9 * * 2";
    draft["suggest.min_confidence"] = "0.7";
    const parsed = configRegistry.schedule.schema.parse(draftToCandidate("schedule", draft, config).candidate);
    expect(parsed.suggest).toMatchObject({ cron: "0 9 * * 2", min_confidence: 0.7 });
    // the keys that only size the prompt are untouched
    expect(parsed.suggest.positive_statuses).toEqual((config as { suggest: { positive_statuses: string[] } }).suggest.positive_statuses);
    const errors = errorsFor("schedule", (d) => {
      d["suggest.cron"] = "not a cron";
      d["suggest.min_confidence"] = "1.5";
    });
    expect(errors.map((e) => `${e.path}:${e.key}`)).toEqual(expect.arrayContaining(["suggest.cron:cron", "suggest.min_confidence:max"]));
  });

  it("insights: the ranges, cities and histogram cuts are a form; the cross-field rules name their field", () => {
    const config = shippedConfig("insights");
    const draft = configToDraft("insights", config);
    draft.ranges_days = ["7", "14", "60"];
    draft.default_range_days = "14";
    draft.cities = ["Hamburg"];
    expect(configRegistry.insights.schema.parse(draftToCandidate("insights", draft, config).candidate)).toMatchObject({ ranges_days: [7, 14, 60], default_range_days: 14, cities: ["Hamburg"] });
    const keys = (edit: (d: SettingsDraft) => void) => errorsFor("insights", edit).map((e) => `${e.path}:${e.key}`);
    expect(keys((d) => (d.default_range_days = "5"))).toContain("default_range_days:notInRanges");
    expect(keys((d) => (d.ranges_days = ["30", "7"]))).toContain("ranges_days:sortedAsc");
    expect(keys((d) => (d.score_bucket_cap = "3"))).toContain("score_bucket_cap:capOrder");
  });

  it("resume: empty paths are null, a relative path is refused", () => {
    const config = shippedConfig("resume");
    const draft = configToDraft("resume", config);
    draft.resume_kit_path = "/Users/me/resume-kit";
    draft.pdf_dir = "";
    const parsed = configRegistry.resume.schema.parse(draftToCandidate("resume", draft, config).candidate);
    expect(parsed.resume_kit_path).toBe("/Users/me/resume-kit");
    expect(parsed.pdf_dir).toBeNull();
    expect(errorsFor("resume", (d) => (d.master_resume_path = "relative/path.yaml")).map((e) => `${e.path}:${e.key}`)).toContain("master_resume_path:absolutePath");
  });

  it("breakdown: the head share is a field now", () => {
    const errors = errorsFor("breakdown", (d) => (d.jd_head_share = "0.95"));
    expect(errors.map((e) => `${e.path}:${e.key}`)).toContain("jd_head_share:max");
  });

  it("ui: the AI usage display settings are a form; the hidden-status blocks are not (the workflow tab owns them)", () => {
    const config = shippedConfig("ui");
    const draft = configToDraft("ui", config);
    expect(draft["ai_usage.default_range"]).toBeDefined();
    expect(Object.keys(draft).some((path) => path.startsWith("applications") || path.startsWith("filters"))).toBe(false);
    draft["ai_usage.default_range"] = "7d";
    expect(configRegistry.ui.schema.parse(draftToCandidate("ui", draft, config).candidate).ai_usage.default_range).toBe("7d");
  });
});

describe("clientFieldErrors (language codes)", () => {
  it("flags a bad language code in a text field and in a list, and accepts good ones", () => {
    const draft = configToDraft("language", shippedConfig("language"));
    expect(clientFieldErrors("language", draft)).toEqual([]);
    draft["ai.output"] = "english";
    draft["ai.summary_also"] = ["de", "zz-9"];
    draft["translation.target"] = "pt-BR";
    expect(clientFieldErrors("language", draft).map((e) => [e.path, e.key])).toEqual([
      ["ai.output", "languageTag"],
      ["ai.summary_also", "languageTag"],
    ]);
  });

  it("the server refuses the same value", () => {
    expect(errorsFor("language", (d) => { d["ai.output"] = "english"; }).map((e) => e.key)).toContain("languageTag");
  });
});
