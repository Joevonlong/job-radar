// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiUnavailableError, quotaGuardAttempts, quotaGuardResume } from "@/lib/ai/errors";
import { classifyTranslationFailure } from "@/lib/translation/errors";
import { createMemoryHealthStore, EMPTY_HEALTH } from "@/lib/ai/health";
import {
  createMemoryQuotaStore,
  effectiveQuota,
  evaluateQuota,
  nextQuotaState,
  parseQuotaState,
  quotaPolicy,
  quotaStateChanged,
  readQuotaStatuses,
  recordQuotaNotified,
  suggestQuotaCaps,
  type AiQuotaStore,
  type QuotaPolicy,
  type QuotaState,
} from "@/lib/ai/quota-guard";
import { createAiRouter } from "@/lib/ai/router";
import type { AiProvider, AiProviderId } from "@/lib/ai/types";
import { createMemoryUsageStore } from "@/lib/ai/usage";
import type { ChannelLogger } from "@/lib/channels/types";
import { configRegistry } from "@/lib/config";
import { QUOTA_GUARD_DEFAULTS } from "@/lib/config/schemas/ai";

import { pinnedAi, scriptedProvider, shippedCatalog, usageEntry, type Step } from "./helpers";

const NOW = new Date("2026-10-07T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const policy = (over: Partial<QuotaPolicy> = {}): QuotaPolicy => ({
  provider: "codex-cli",
  windowHours: 5,
  hardRequests: 10,
  cycleRequestCap: 5,
  resumeRatio: 0.8,
  defaultMinutes: 60,
  maxMinutes: 300,
  ...over,
});

/** `count` calls of `provider`, the oldest `firstAgoMs` ago, one per `stepMs`. */
const calls = (count: number, firstAgoMs: number, stepMs = MIN, provider = "codex-cli") =>
  Array.from({ length: count }, (_, i) => ({ provider, at: at(-firstAgoMs + i * stepMs) }));

const hardState = (over: Partial<QuotaState> = {}): QuotaState => ({ level: "hard", reason: "window", since: at(-HOUR), resumeAt: at(HOUR), hardRequests: 10, notifiedLevel: null, ...over });

describe("evaluateQuota", () => {
  it("is ok below the cap and hard at it, counting only calls inside the window of this provider", () => {
    const old = calls(5, 6 * HOUR); // outside the 5 h window
    const other = calls(20, HOUR, MIN, "claude-cli");
    expect(evaluateQuota([...old, ...other, ...calls(9, HOUR)], policy(), NOW, null)).toMatchObject({ level: "ok", windowRequests: 9, resumeAt: null });
    const hard = evaluateQuota([...old, ...other, ...calls(10, HOUR)], policy(), NOW, null);
    expect(hard).toMatchObject({ level: "hard", reason: "window", windowRequests: 10 });
  });

  it("slides: calls leave the window as time passes", () => {
    const rows = calls(10, 5 * HOUR - 10 * MIN); // the oldest leaves the window 10 minutes from now
    expect(evaluateQuota(rows, policy(), NOW, null).level).toBe("hard");
    expect(evaluateQuota(rows, policy(), at(11 * MIN), null).level).toBe("ok");
  });

  it("keeps a window cap until the count is below resume_ratio x hard_requests (hysteresis)", () => {
    const previous = hardState();
    expect(evaluateQuota(calls(8, HOUR), policy(), NOW, previous).level).toBe("hard"); // 8 >= 0.8 x 10
    expect(evaluateQuota(calls(7, HOUR), policy(), NOW, previous).level).toBe("ok");
    // without a previous cap the same 8 calls are fine
    expect(evaluateQuota(calls(8, HOUR), policy(), NOW, null).level).toBe("ok");
  });

  it("a pause caused by another cap does not carry over: putting the cap back lifts it at once", () => {
    // 300 calls against a cap of 320; the user lowers the cap to 3: paused
    const rows = calls(300, 2 * HOUR, 10_000);
    const lowered = evaluateQuota(rows, policy({ hardRequests: 3 }), NOW, null);
    expect(lowered).toMatchObject({ level: "hard", hardRequests: 3 });
    const stored = nextQuotaState(null, lowered, NOW);
    expect(stored.hardRequests).toBe(3);
    // set back to 320: 300 is above 0.8 x 320 but the stored pause was the cap of 3, so the window is judged afresh
    expect(evaluateQuota(rows, policy({ hardRequests: 320 }), NOW, stored)).toMatchObject({ level: "ok", hardRequests: 320 });
    // an unchanged cap keeps the hysteresis
    expect(evaluateQuota(calls(300, 2 * HOUR, 10_000), policy({ hardRequests: 320 }), NOW, hardState({ hardRequests: 320 })).level).toBe("hard");
  });

  it("puts the resume time where enough of the oldest calls have left the window", () => {
    // 10 calls, one per minute, the oldest 4 h ago: below the line means at most 7 calls, so the 3rd oldest has to leave
    const rows = calls(10, 4 * HOUR);
    const result = evaluateQuota(rows, policy(), NOW, null);
    expect(result.resumeAt?.toISOString()).toBe(at(-4 * HOUR + 2 * MIN + 5 * HOUR).toISOString());
  });

  it("never puts the resume time later than max_minutes from now", () => {
    const result = evaluateQuota(calls(10, 10 * MIN), policy({ maxMinutes: 30 }), NOW, null);
    expect(result.resumeAt?.toISOString()).toBe(at(30 * MIN).toISOString());
  });

  it("hard_requests 0 turns the window cap off", () => {
    expect(evaluateQuota(calls(500, HOUR, 1000), policy({ hardRequests: 0 }), NOW, hardState())).toMatchObject({ level: "ok", windowRequests: 500 });
  });
});

describe("quota state", () => {
  it("reads a bad stored row as no state", () => {
    expect(parseQuotaState({ level: "very hard" })).toBeNull();
    expect(parseQuotaState("nonsense")).toBeNull();
    expect(parseQuotaState({ level: "hard", reason: "window", since: "not a date", resumeAt: null, notifiedLevel: null })).toBeNull();
    expect(parseQuotaState({ level: "hard", reason: "window", since: NOW.toISOString(), resumeAt: null, notifiedLevel: "hard" })).toMatchObject({ level: "hard", hardRequests: null, notifiedLevel: "hard" });
  });

  it("keeps notifiedLevel and marks a level change with since", () => {
    const previous = hardState({ notifiedLevel: "hard" });
    const next = nextQuotaState(previous, { level: "ok", reason: null, resumeAt: null, windowRequests: 1, hardRequests: 10 }, NOW);
    expect(next).toEqual({ level: "ok", reason: null, since: NOW, resumeAt: null, hardRequests: null, notifiedLevel: "hard" });
    const same = nextQuotaState(previous, { level: "hard", reason: "window", resumeAt: previous.resumeAt, windowRequests: 11, hardRequests: 10 }, NOW);
    expect(same.since).toBe(previous.since);
    expect(quotaStateChanged(previous, same)).toBe(false);
    expect(quotaStateChanged(null, same)).toBe(true);
  });

  it("an error cooldown counts as hard with reason error; with a window cap the later resume time wins", () => {
    const p = policy();
    const cooling = { ...EMPTY_HEALTH, coolingUntil: at(2 * HOUR) };
    expect(effectiveQuota(p, { level: "ok", reason: null, resumeAt: null, windowRequests: 1, hardRequests: 10 }, cooling, NOW, null)).toMatchObject({ level: "hard", reason: "error", resumeAt: at(2 * HOUR) });
    expect(effectiveQuota(p, { level: "hard", reason: "window", resumeAt: at(HOUR), windowRequests: 10, hardRequests: 10 }, cooling, NOW, null)).toMatchObject({ level: "hard", reason: "window", resumeAt: at(2 * HOUR) });
    expect(effectiveQuota(p, { level: "ok", reason: null, resumeAt: null, windowRequests: 1, hardRequests: 10 }, { ...EMPTY_HEALTH, coolingUntil: at(-MIN) }, NOW, null)).toMatchObject({ level: "ok", reason: null });
  });

  it("recordQuotaNotified stores the level once, creating a state when there is none", async () => {
    const store = createMemoryQuotaStore();
    await recordQuotaNotified(store, "claude-cli", "hard", NOW);
    expect(store.states.get("claude-cli")).toMatchObject({ level: "ok", notifiedLevel: "hard" });
    store.states.set("codex-cli", hardState());
    await recordQuotaNotified(store, "codex-cli", "hard", NOW);
    expect(store.states.get("codex-cli")).toMatchObject({ level: "hard", reason: "window", notifiedLevel: "hard" });
  });

  it("the router's write keeps notifiedLevel and the alerts' write keeps the window fields", async () => {
    const store = createMemoryQuotaStore();
    await store.setNotifiedLevel("codex-cli", "hard", NOW);
    // the router stores from a read made before the alert was recorded: notifiedLevel null in its copy
    await store.setState("codex-cli", hardState({ notifiedLevel: null }));
    expect(store.states.get("codex-cli")).toMatchObject({ level: "hard", hardRequests: 10, notifiedLevel: "hard" });
    await store.setNotifiedLevel("codex-cli", "ok", NOW);
    expect(store.states.get("codex-cli")).toMatchObject({ level: "hard", reason: "window", hardRequests: 10, notifiedLevel: "ok" });
  });
});

describe("readQuotaStatuses", () => {
  const config = pinnedAi((raw) => {
    raw.quota_guard = { providers: { codex_cli: { hard_requests: 10, cycle_request_cap: 5 }, claude_cli: { hard_requests: 0, cycle_request_cap: 0 } } };
  });

  it("reports every guarded provider, nothing when the guard is off", async () => {
    const store = createMemoryQuotaStore(calls(10, HOUR).map((c) => usageEntry({ ...c, provider: "codex-cli", task: "score" })));
    const statuses = await readQuotaStatuses(store, config, new Map(), NOW);
    expect(statuses.get("codex-cli")).toMatchObject({ level: "hard", reason: "window", windowRequests: 10, hardRequests: 10 });
    expect(statuses.get("claude-cli")).toMatchObject({ level: "ok", hardRequests: 0 });
    expect(store.states.size).toBe(0); // read only

    const off = pinnedAi((raw) => {
      raw.quota_guard = { enabled: false };
    });
    expect((await readQuotaStatuses(store, off, new Map(), NOW)).size).toBe(0);
  });

  it("fails open when the calls cannot be read", async () => {
    const broken: AiQuotaStore = {
      usageSince: async () => {
        throw new Error("db down");
      },
      countSince: async () => 0,
      getState: async () => null,
      setState: async () => {},
      setNotifiedLevel: async () => {},
    };
    expect((await readQuotaStatuses(broken, config, new Map(), NOW)).get("codex-cli")).toMatchObject({ level: "ok", windowRequests: 0 });
  });
});

describe("quotaGuardResume", () => {
  const guarded = { provider: "codex-cli" as const, outcome: "skipped" as const, kind: "budget" as const, message: "usage cap", guard: { reason: "window" as const, resumeAt: at(HOUR).toISOString() } };

  it("names the cap when it is the reason, with the earliest resume time", () => {
    const apiClosed = { provider: "anthropic" as const, outcome: "skipped" as const, kind: "budget" as const, message: "closed" };
    const off = { provider: "mimo" as const, outcome: "skipped" as const, kind: "not_configured" as const, message: "off" };
    expect(quotaGuardResume(new AiUnavailableError("translate", [guarded, apiClosed, off]))).toEqual({ resumeAt: at(HOUR).toISOString() });
  });

  it("leaves a more actionable failure of another provider to surface (not logged in, a broken call)", () => {
    for (const kind of ["auth", "timeout", "invalid_output"] as const) {
      const other = { provider: "claude-cli" as const, outcome: "failed" as const, kind, message: kind };
      expect(quotaGuardResume(new AiUnavailableError("translate", [guarded, other]))).toBeUndefined();
    }
  });
  it("a translation names the login problem, not the cap, when another provider is not logged in", () => {
    const auth = { provider: "claude-cli" as const, outcome: "failed" as const, kind: "auth" as const, message: "login expired" };
    expect(classifyTranslationFailure(new AiUnavailableError("translate", [guarded, auth]))).toMatchObject({ code: "auth" });
    expect(classifyTranslationFailure(new AiUnavailableError("translate", [guarded]))).toMatchObject({ code: "quota_guard", resumeAt: at(HOUR).toISOString() });
  });
});

describe("suggestQuotaCaps", () => {
  const options = { perCycleLimit: 80, minDays: 14, minCycles: 20 };
  const history = { provider: "codex-cli", firstAt: at(-30 * 24 * HOUR), lastAt: NOW, windowMax: 101, cycleMax: 47, cycles: 60 };

  it("takes 1.5 x the observed maxima, rounded up", () => {
    expect(suggestQuotaCaps(history, options)).toEqual({ provider: "codex-cli", hardRequests: 152, cycleRequestCap: 71, basis: "history" });
  });

  it("falls back with too little history", () => {
    expect(suggestQuotaCaps({ ...history, cycles: 5 }, options)).toEqual({ provider: "codex-cli", hardRequests: 320, cycleRequestCap: 160, basis: "fallback" });
    expect(suggestQuotaCaps({ ...history, provider: "claude-cli", firstAt: at(-3 * 24 * HOUR) }, options)).toEqual({ provider: "claude-cli", hardRequests: 20, cycleRequestCap: 10, basis: "fallback" });
    expect(suggestQuotaCaps({ provider: "claude-cli", firstAt: null, lastAt: null, windowMax: null, cycleMax: null, cycles: 0 }, options).basis).toBe("fallback");
  });
});

describe("quota_guard schema", () => {
  const parse = (edit: (raw: Record<string, unknown>) => void) => () => pinnedAi(edit);

  it("fills a missing block with the defaults (older user files still parse)", () => {
    const config = pinnedAi((raw) => {
      delete raw.quota_guard;
    });
    expect(config.quota_guard).toEqual(QUOTA_GUARD_DEFAULTS);
    const partial = pinnedAi((raw) => {
      raw.quota_guard = { providers: { codex_cli: { hard_requests: 7 } } };
    });
    expect(partial.quota_guard.providers.codex_cli).toEqual({ ...QUOTA_GUARD_DEFAULTS.providers.codex_cli, hard_requests: 7 });
  });

  it("rejects negatives, a zero window, a ratio above 1 and unknown keys", () => {
    expect(parse((raw) => (raw.quota_guard = { providers: { codex_cli: { hard_requests: -1 } } }))).toThrow();
    expect(parse((raw) => (raw.quota_guard = { providers: { claude_cli: { cycle_request_cap: -5 } } }))).toThrow();
    expect(parse((raw) => (raw.quota_guard = { providers: { claude_cli: { window_hours: 0 } } }))).toThrow();
    expect(parse((raw) => (raw.quota_guard = { resume_ratio: 1.5 }))).toThrow();
    expect(parse((raw) => (raw.quota_guard = { soft_requests: 3 }))).toThrow();
    expect(parse((raw) => (raw.quota_guard = { providers: { anthropic: {} } }))).toThrow();
    expect(configRegistry.ai.schema.safeParse({}).success).toBe(false); // the rest of the schema is unchanged
  });

  it("quotaPolicy is null when the guard is off", () => {
    expect(quotaPolicy(pinnedAi((raw) => (raw.quota_guard = { enabled: false })), "codex-cli")).toBeNull();
  });
});

// ---------------------------------------------------------------- the router gate

const schema = z.object({ ok: z.boolean() });
const prompt = { system: "s", user: "u" };
const good = '{"ok": true}';
const CYCLE_START = at(-30 * MIN);

function warnings(): ChannelLogger & { warned: string[] } {
  const warned: string[] = [];
  const noop = () => {};
  return { warned, debug: noop, info: noop, warn: (message: string) => warned.push(message), error: noop } as unknown as ChannelLogger & { warned: string[] };
}

function setup(
  options: {
    ids?: AiProviderId[];
    origin?: "cycle" | "control";
    cycleStartedAt?: Date | null;
    edit?: (raw: Record<string, unknown>) => void;
    steps?: Partial<Record<AiProviderId, Step[]>>;
  } = {},
) {
  const config = pinnedAi((raw) => {
    raw.quota_guard = {
      fallthrough_to_api: false,
      providers: { codex_cli: { window_hours: 5, hard_requests: 10, cycle_request_cap: 4 }, claude_cli: { window_hours: 5, hard_requests: 10, cycle_request_cap: 4 } },
    };
    options.edit?.(raw);
  });
  const ids = options.ids ?? ["codex-cli", "claude-cli", "anthropic"];
  const providers: AiProvider[] = [];
  const transports = new Map<AiProviderId, ReturnType<typeof scriptedProvider>["transport"]>();
  for (const id of ids) {
    const { provider, transport } = scriptedProvider(id, options.steps?.[id] ?? [good]);
    providers.push(provider);
    transports.set(id, transport);
  }
  const usage = createMemoryUsageStore();
  const quota = createMemoryQuotaStore(usage.entries);
  const health = createMemoryHealthStore();
  const logger = warnings();
  // another router on the same stores: the late phase, or the other process, of the same cycle
  const makeRouter = () => createAiRouter({
    config,
    providers,
    usage,
    health,
    quota,
    origin: options.origin ?? "cycle",
    cycleStartedAt: options.cycleStartedAt === undefined ? CYCLE_START : options.cycleStartedAt,
    now: () => NOW,
    timeZone: "UTC",
    catalog: shippedCatalog(),
    logger,
  });
  const router = makeRouter();
  const seed = (provider: AiProviderId, count: number, firstAgoMs: number) => {
    for (const c of calls(count, firstAgoMs, MIN, provider)) usage.entries.push(usageEntry({ provider, task: "score", at: c.at }));
  };
  return { router, makeRouter, usage, quota, health, transports, seed, logger };
}

const callsOf = (env: ReturnType<typeof setup>, id: AiProviderId) => env.transports.get(id)?.calls.length ?? 0;

describe("router: usage cap", () => {
  it("a window cap skips the provider for every origin, stores the state and falls to the next subscription CLI", async () => {
    for (const origin of ["cycle", "control"] as const) {
      const env = setup({ origin });
      env.seed("codex-cli", 10, 2 * HOUR);
      const result = await env.router.run("score", prompt, schema);
      expect(result.provider).toBe("claude-cli");
      expect(callsOf(env, "codex-cli")).toBe(0);
      expect(env.quota.states.get("codex-cli")).toMatchObject({ level: "hard", reason: "window", notifiedLevel: null });
      expect(env.logger.warned).toContain("ai usage cap reached, provider paused");
    }
  });

  it("the per-cycle cap holds back the cycle but not a request the user made", async () => {
    const cycle = setup();
    cycle.seed("codex-cli", 4, 20 * MIN); // all after the cycle started
    expect((await cycle.router.run("score", prompt, schema)).provider).toBe("claude-cli");
    expect(cycle.quota.states.get("codex-cli")).toMatchObject({ level: "ok" }); // the cycle cap is not a stored state

    const control = setup({ origin: "control" });
    control.seed("codex-cli", 4, 20 * MIN);
    expect((await control.router.run("score", prompt, schema)).provider).toBe("codex-cli");

    // calls before the cycle started do not count toward it
    const earlier = setup();
    earlier.seed("codex-cli", 4, 2 * HOUR);
    expect((await earlier.router.run("score", prompt, schema)).provider).toBe("codex-cli");

    // no cycle start known: no per-cycle cap
    const unknown = setup({ cycleStartedAt: null });
    unknown.seed("codex-cli", 4, 20 * MIN);
    expect((await unknown.router.run("score", prompt, schema)).provider).toBe("codex-cli");
  });

  it("the main and the late phase share one cycle count (two routers on the same usage rows)", async () => {
    const env = setup();
    for (let i = 0; i < 3; i += 1) expect((await env.router.run("score", prompt, schema)).provider).toBe("codex-cli");
    const late = env.makeRouter();
    expect((await late.run("translate", prompt, schema)).provider).toBe("codex-cli"); // the 4th call of the cycle
    expect((await late.run("translate", prompt, schema)).provider).toBe("claude-cli");
    expect((await env.router.run("score", prompt, schema)).provider).toBe("claude-cli");
    expect(callsOf(env, "codex-cli")).toBe(4);
  });

  it("never falls through to a paid API provider when the cap held the CLIs back (fallthrough_to_api: false)", async () => {
    const env = setup();
    env.seed("codex-cli", 10, HOUR);
    env.seed("claude-cli", 10, HOUR);
    const error = await env.router.run("translate", prompt, schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(callsOf(env, "anthropic")).toBe(0);
    const attempts = (error as AiUnavailableError).attempts;
    expect(quotaGuardAttempts(attempts).map((a) => [a.provider, a.guard.reason])).toEqual([
      ["codex-cli", "window"],
      ["claude-cli", "window"],
    ]);
    expect(attempts.find((a) => a.provider === "anthropic")).toMatchObject({ outcome: "skipped", kind: "budget" });
    expect(quotaGuardResume(error)?.resumeAt).toEqual(expect.any(String));

    const check = await env.router.usable("score");
    expect(check.usable).toBe(false);
  });

  it("falls through to the API when fallthrough_to_api is on", async () => {
    const env = setup({
      edit: (raw) => {
        (raw.quota_guard as Record<string, unknown>).fallthrough_to_api = true;
      },
    });
    env.seed("codex-cli", 10, HOUR);
    env.seed("claude-cli", 10, HOUR);
    expect((await env.router.run("score", prompt, schema)).provider).toBe("anthropic");
  });

  it("an error cooldown still falls through to the API as before, marked as the cap's error reason", async () => {
    const env = setup({ ids: ["codex-cli", "anthropic"] });
    env.health.rows.set("codex-cli", { ...EMPTY_HEALTH, coolingUntil: at(HOUR), lastErrorKind: "rate_limited" });
    expect((await env.router.run("score", prompt, schema)).provider).toBe("anthropic");
    const check = setup({ ids: ["codex-cli"] });
    check.health.rows.set("codex-cli", { ...EMPTY_HEALTH, coolingUntil: at(HOUR), lastErrorKind: "rate_limited" });
    const blocked = await check.router.usable("score");
    expect(blocked.blocked[0]).toMatchObject({ provider: "codex-cli", kind: "rate_limited", guard: { reason: "error", resumeAt: at(HOUR).toISOString() } });
  });

  it("lowering hard_requests below the current count caps at once", async () => {
    const env = setup({ edit: (raw) => ((raw.quota_guard as { providers: { codex_cli: Record<string, unknown> } }).providers.codex_cli.hard_requests = 3) });
    env.seed("codex-cli", 3, 3 * HOUR);
    expect((await env.router.run("score", prompt, schema)).provider).toBe("claude-cli");
  });

  it("fails open when the calls cannot be counted", async () => {
    const env = setup();
    const broken = createAiRouter({
      config: pinnedAi(),
      providers: [scriptedProvider("codex-cli", [good]).provider],
      usage: null,
      quota: {
        usageSince: async () => {
          throw new Error("db down");
        },
        countSince: async () => {
          throw new Error("db down");
        },
        getState: async () => null,
        setState: async () => {},
        setNotifiedLevel: async () => {},
      },
      cycleStartedAt: CYCLE_START,
      now: () => NOW,
      timeZone: "UTC",
      catalog: shippedCatalog(),
      logger: env.logger,
    });
    expect((await broken.run("score", prompt, schema)).provider).toBe("codex-cli");
    expect(env.logger.warned).toContain("ai usage cap could not be checked, the call is allowed");
  });

  it("does nothing when the guard is off", async () => {
    const env = setup({ edit: (raw) => ((raw.quota_guard as Record<string, unknown>).enabled = false) });
    env.seed("codex-cli", 50, HOUR);
    expect((await env.router.run("score", prompt, schema)).provider).toBe("codex-cli");
    expect(env.quota.states.size).toBe(0);
  });
});
