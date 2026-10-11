// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiProviderError, AiUnavailableError, QUOTA_PATTERN } from "@/lib/ai/errors";
import { cooldownUntil, createMemoryHealthStore, healthDay, parseResetTime } from "@/lib/ai/health";
import { createAiRouter } from "@/lib/ai/router";
import { createAiStep, registerAiSubtask, resetAiSubtasks } from "@/lib/ai/step";
import type { CycleStepContext } from "@/lib/cycle/steps";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { scriptedProvider, pinnedAi } from "./helpers";

const schema = z.object({ ok: z.boolean() });
const prompt = { system: "s", user: "u" };
const good = '{"ok": true}';
const LIMIT = "You've hit your session limit · resets 5pm (Europe/Berlin)";

describe("quota classification", () => {
  it.each([
    "You've hit your session limit · resets 5pm",
    "Claude usage limit reached. Your limit will reset at 3am",
    "You've hit your usage limit. Try again at 5:40 PM.",
    "429 Too Many Requests",
    "insufficient_quota",
  ])("treats %j as a quota error", (message) => {
    expect(QUOTA_PATTERN.test(message)).toBe(true);
  });

  it("does not treat an ordinary failure as one", () => {
    expect(QUOTA_PATTERN.test("spawn claude ENOENT")).toBe(false);
  });
});

describe("parseResetTime", () => {
  const now = new Date(2026, 9, 7, 15, 0, 0); // local time, so the clock-time cases do not depend on the machine's zone

  it("reads relative durations", () => {
    expect(parseResetTime("Try again in 3 hours 12 minutes.", now)?.getTime()).toBe(now.getTime() + (3 * 60 + 12) * 60_000);
    expect(parseResetTime("resets in 45 minutes", now)?.getTime()).toBe(now.getTime() + 45 * 60_000);
  });

  it("reads a clock time today, or tomorrow when it has passed", () => {
    expect(parseResetTime("resets 5pm (Europe/Berlin)", now)).toEqual(new Date(2026, 9, 7, 17, 0));
    expect(parseResetTime("Try again at 5:40 PM.", now)).toEqual(new Date(2026, 9, 7, 17, 40));
    expect(parseResetTime("resets at 09:30", now)).toEqual(new Date(2026, 9, 8, 9, 30));
    expect(parseResetTime("resets 12am", now)).toEqual(new Date(2026, 9, 8, 0, 0));
  });

  it("reads the epoch of the old limit message", () => {
    expect(parseResetTime("Claude AI usage limit reached|1791400000", now)).toEqual(new Date(1_791_400_000_000));
  });

  it("returns null when no time is named", () => {
    expect(parseResetTime("rate limit exceeded", now)).toBeNull();
  });

  it("cooldownUntil falls back to the default and never exceeds the maximum", () => {
    const policy = { default_minutes: 60, max_minutes: 120 };
    expect(cooldownUntil("rate limit", now, policy).getTime()).toBe(now.getTime() + 60 * 60_000);
    expect(cooldownUntil("resets 5pm", now, policy)).toEqual(new Date(2026, 9, 7, 17, 0));
    expect(cooldownUntil("try again in 3 days", now, policy).getTime()).toBe(now.getTime() + 120 * 60_000);
  });
});

function setup(options: { edit?: (raw: Record<string, unknown>) => void; claude?: Array<string | Error>; codex?: Array<string | Error>; at?: { value: Date } } = {}) {
  const config = pinnedAi((raw) => {
    raw.order = ["claude-cli", "codex-cli"];
    options.edit?.(raw);
  });
  const claude = scriptedProvider("claude-cli", options.claude ?? [good]);
  const codex = scriptedProvider("codex-cli", options.codex ?? [good]);
  const clock = options.at ?? { value: new Date("2026-10-07T10:00:00Z") };
  const health = createMemoryHealthStore();
  const router = createAiRouter({ config, providers: [claude.provider, codex.provider], usage: null, health, now: () => clock.value, timeZone: "Europe/Berlin" });
  return { router, health, claude, codex, clock, config };
}

describe("provider cooldown", () => {
  it("a session-limit error puts claude-cli on cooldown: the next 59 requests skip it and go straight to codex", async () => {
    const t = setup({ claude: [new Error(LIMIT)].map((e) => new AiProviderError("claude-cli", "rate_limited", e.message)) });
    expect((await t.router.run("signals", prompt, schema)).provider).toBe("codex-cli");
    expect(t.claude.transport.calls).toHaveLength(1);
    for (let i = 0; i < 59; i += 1) expect((await t.router.run("signals", prompt, schema)).provider).toBe("codex-cli");
    expect(t.claude.transport.calls).toHaveLength(1); // not retried
    const state = await t.health.get("claude-cli");
    expect(state.lastErrorKind).toBe("rate_limited");
    expect(state.coolingUntil).not.toBeNull();
  });

  it("is shared through the store: a second router (another process) skips the provider without calling it", async () => {
    const t = setup({ claude: [new AiProviderError("claude-cli", "rate_limited", LIMIT)] });
    await t.router.run("score", prompt, schema);
    const other = createAiRouter({ config: t.config, providers: [t.claude.provider, t.codex.provider], usage: null, health: t.health, now: () => t.clock.value, timeZone: "Europe/Berlin" });
    await other.run("score", prompt, schema);
    expect(t.claude.transport.calls).toHaveLength(1);
  });

  it("tries the provider again once the cooldown is over", async () => {
    const t = setup({ claude: [new AiProviderError("claude-cli", "rate_limited", "rate limit"), good] });
    await t.router.run("score", prompt, schema);
    t.clock.value = new Date(t.clock.value.getTime() + 61 * 60_000);
    expect((await t.router.run("score", prompt, schema)).provider).toBe("claude-cli");
    expect((await t.health.get("claude-cli")).coolingUntil).toBeNull();
  });

  it("reports which providers cannot be tried", async () => {
    const t = setup({ claude: [new AiProviderError("claude-cli", "rate_limited", "rate limit")] });
    await t.router.run("score", prompt, schema);
    expect((await t.router.usable("score")).usable).toBe(true);
    const down = setup({ edit: (raw) => { (raw.providers as Record<string, { enabled: boolean }>).codex_cli.enabled = false; (raw.providers as Record<string, { enabled: boolean }>).claude_cli.enabled = false; } });
    const check = await down.router.usable("score");
    expect(check.usable).toBe(false);
    expect(check.blocked.map((b) => b.message)).toEqual([expect.stringContaining("enabled: false"), expect.stringContaining("enabled: false")]);
  });
});

describe("per-provider switches and caps", () => {
  it("a provider with enabled: false is never called", async () => {
    const t = setup({ edit: (raw) => { (raw.providers as Record<string, { enabled: boolean }>).claude_cli.enabled = false; } });
    expect((await t.router.run("score", prompt, schema)).provider).toBe("codex-cli");
    expect(t.claude.transport.calls).toHaveLength(0);
  });

  it("stops using a provider after its daily request cap, and counts again the next day", async () => {
    const t = setup({ edit: (raw) => { (raw.providers as Record<string, { daily_request_cap: number }>).claude_cli.daily_request_cap = 2; } });
    for (let i = 0; i < 5; i += 1) await t.router.run("score", prompt, schema);
    expect(t.claude.transport.calls).toHaveLength(2);
    expect(t.codex.transport.calls).toHaveLength(3);
    t.clock.value = new Date(t.clock.value.getTime() + 24 * 3_600_000);
    expect((await t.router.run("score", prompt, schema)).provider).toBe("claude-cli");
    expect((await t.health.get("claude-cli")).requestsToday).toBe(1);
  });

  it("counts failed requests against the cap too", async () => {
    const t = setup({ claude: [new AiProviderError("claude-cli", "provider_error", "boom")], edit: (raw) => { (raw.providers as Record<string, { daily_request_cap: number }>).claude_cli.daily_request_cap = 1; } });
    await t.router.run("score", prompt, schema);
    await t.router.run("score", prompt, schema);
    expect(t.claude.transport.calls).toHaveLength(1);
  });

  it("a per-task order puts the providers in that order", async () => {
    const t = setup({ edit: (raw) => { (raw.tasks as Record<string, unknown>).translate = { order: ["codex-cli", "claude-cli"] }; } });
    expect((await t.router.run("translate", prompt, schema)).provider).toBe("codex-cli");
  });

  it("healthDay follows the time zone", () => {
    expect(healthDay(new Date("2026-10-07T22:30:00Z"), "Europe/Berlin")).toBe("2026-10-08");
    expect(healthDay(new Date("2026-10-07T22:30:00Z"), "UTC")).toBe("2026-10-07");
  });
});

describe("cycle time budget", () => {
  it("a router past its deadline refuses at once with budget attempts and calls nobody", async () => {
    const t = setup();
    const late = createAiRouter({ config: t.config, providers: [t.claude.provider, t.codex.provider], usage: null, now: () => t.clock.value, deadline: new Date(t.clock.value.getTime() - 1) });
    const error = await late.run("score", prompt, schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).attempts.every((a) => a.kind === "budget")).toBe(true);
    expect(t.claude.transport.calls).toHaveLength(0);
    expect(t.codex.transport.calls).toHaveLength(0);
  });
});

function stepCtx(results: CycleStepContext["results"] = {}): CycleStepContext {
  return { cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: null, signal: new AbortController().signal, logger: quietLogger, now: () => new Date(), config: cycleConfig(), channels: undefined as never, results };
}

describe("the ai step", () => {
  const deps = (providers = [scriptedProvider("codex-cli", [good]).provider], edit?: (raw: Record<string, unknown>) => void) => ({
    loadAiConfig: () => pinnedAi(edit),
    createRouter: (_ctx: CycleStepContext, config: ReturnType<typeof pinnedAi>) => createAiRouter({ config, providers, usage: null }),
  });

  it("is skipped, with the reasons, when no provider can be tried (nothing queued behind a limit)", async () => {
    resetAiSubtasks();
    let ran = false;
    registerAiSubtask({ name: "score", run: async () => { ran = true; } });
    const off = (raw: Record<string, unknown>) => { for (const p of Object.values(raw.providers as Record<string, { enabled: boolean }>)) p.enabled = false; };
    const outcome = await createAiStep(deps(undefined, off))(stepCtx());
    expect(ran).toBe(false);
    expect(outcome).toMatchObject({ result: { skipped: "no_provider_available", subtasks: [] } });
    resetAiSubtasks();
  });

  it("runs the late sub-tasks only in the late phase", async () => {
    resetAiSubtasks();
    const ran: string[] = [];
    registerAiSubtask({ name: "score", run: async () => { ran.push("score"); } });
    registerAiSubtask({ name: "translate", late: true, run: async () => { ran.push("translate"); } });
    await createAiStep({ ...deps(), phase: "main" })(stepCtx());
    expect(ran).toEqual(["score"]);
    await createAiStep({ ...deps(), phase: "late" })(stepCtx());
    expect(ran).toEqual(["score", "translate"]);
    await createAiStep(deps())(stepCtx());
    expect(ran).toEqual(["score", "translate", "score", "translate"]);
    resetAiSubtasks();
  });

  it("gives the router a deadline: the full budget normally, the smaller idle budget when the pipeline created nothing", async () => {
    resetAiSubtasks();
    registerAiSubtask({ name: "score", run: async () => {} });
    const start = new Date("2026-10-07T10:00:00Z");
    const edit = (raw: Record<string, unknown>) => { raw.cycle_budget_minutes = 30; raw.idle_cycle_budget_minutes = 10; };
    const seen: Array<Date | null> = [];
    const step = createAiStep({
      loadAiConfig: () => pinnedAi(edit),
      createRouter: (_c, config, limits) => {
        seen.push(limits.deadline);
        return createAiRouter({ config, providers: [scriptedProvider("codex-cli", [good]).provider], usage: null });
      },
    });
    const at = (results: CycleStepContext["results"]): CycleStepContext => ({ ...stepCtx(results), now: () => start });
    await step(at({ pipeline: { created: 4 } }));
    await step(at({ pipeline: { created: 0 } }));
    await createAiStep({ loadAiConfig: () => pinnedAi((raw) => { edit(raw); raw.cycle_budget_minutes = 0; }), createRouter: (_c, config, limits) => { seen.push(limits.deadline); return createAiRouter({ config, providers: [scriptedProvider("codex-cli", [good]).provider], usage: null }); } })(at({}));
    expect(seen).toEqual([new Date("2026-10-07T10:30:00Z"), new Date("2026-10-07T10:10:00Z"), null]);
    resetAiSubtasks();
  });
});
