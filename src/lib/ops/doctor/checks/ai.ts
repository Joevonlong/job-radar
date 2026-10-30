/** The ai-worker (launchd + heartbeat), the claude / codex logins and the AI backlog. */
import path from "node:path";

import { z } from "zod";

import { cliCommandProblem } from "@/lib/ai/providers/cli-guards";
import { isCodexOlderThan, parseCodexVersion } from "@/lib/ai/providers/codex-version";
import type { WorkerEvidence } from "@/lib/db/repos/ai-worker-evidence";

import { AI_WORKER_DEFAULT_LAUNCHD_LABEL, aiWorkerLaunchdLabel } from "../../ai-worker-label";
import { withTimeout } from "../../timeout";
import { configGuardFindings } from "../../config-guards";
import { AI_WORKER_LAUNCHD_LOG, AI_WORKER_LOG_DIR, AI_WORKER_LOG_NAMES } from "../../log-files";
import { ageSeconds, cached, extractJson, fail, formatAgo, formatDuration, formatLocal, joinList, merge, ok, warn, type Piece, type Spec } from "../helpers";
import { loadSources, tryLoadSources } from "../shared";
import { type CheckOutcome, type DoctorCheck, type DoctorContext } from "../types";

// ---------------------------------------------------------------- ai-worker

const launchdSpec = { id: "aiworker.launchd", group: "processes" } as const;

/** Compatibility probe when the configured label is absent and the agent still uses another known label. */
const LEGACY_LAUNCHD_LABEL = "de.jobradar.ai-worker";

/** The fields of `launchctl print` that matter: `state = running`, `pid = 123`, `last exit code = 0`, `stdout path = …`. */
export function parseLaunchctlPrint(stdout: string): { state: string | null; pid: number | null; lastExitCode: string | null; stdoutPath: string | null } {
  const field = (name: string): string | null => {
    const match = new RegExp(`^\\s*${name} = (.+)$`, "m").exec(stdout);
    return match?.[1]?.trim() ?? null;
  };
  const pid = field("pid");
  return { state: field("state"), pid: pid !== null && /^\d+$/.test(pid) ? Number(pid) : null, lastExitCode: field("last exit code"), stdoutPath: field("stdout path") };
}

/** Where the worker's logs are: its own files on the external volume, and launchd's small capture file for start-up failures and crashes. */
function workerLogs(ctx: DoctorContext): { err: string; out: string; launchd: string } {
  return { err: path.join(ctx.appRoot, AI_WORKER_LOG_DIR, AI_WORKER_LOG_NAMES.err), out: path.join(ctx.appRoot, AI_WORKER_LOG_DIR, AI_WORKER_LOG_NAMES.out), launchd: AI_WORKER_LAUNCHD_LOG };
}

/** A plist written before the log-dir option has launchd write `ai-worker.out.log` itself, on the internal disk. */
const isOldLogLayout = (stdoutPath: string | null): boolean => stdoutPath !== null && path.basename(stdoutPath) === AI_WORKER_LOG_NAMES.out;

/** The systemd user unit of the ai-worker on Linux (scripts/ops/install-ai-worker.sh, scripts/ops/systemd/). */
export const AI_WORKER_SYSTEMD_UNIT = "job-radar-ai-worker.service";

/** The ai-worker's PID as the service manager gives it, or why there is none. */
export function aiWorkerServicePid(ctx: DoctorContext): Promise<{ pid: number } | { pid: null; reason: string }> {
  return cached(ctx, "aiworker.servicePid", async () => {
    const { t } = ctx;
    if (ctx.platform === "darwin" && ctx.uid !== null) {
      const label = aiWorkerLaunchdLabel(ctx.settings.ai_worker_launchd_label);
      const out = await ctx.probes.run("launchctl", ["print", `gui/${ctx.uid}/${label}`]);
      if (out.kind !== "ran") return { pid: null, reason: t("checks.config.shipped.noAnswer", { command: "launchctl print" }) };
      if (out.exitCode !== 0) return { pid: null, reason: t("checks.config.shipped.notLoaded", { service: label }) };
      const pid = parseLaunchctlPrint(out.stdout).pid;
      return pid === null ? { pid: null, reason: t("checks.config.shipped.notRunning", { service: label }) } : { pid };
    }
    if (ctx.platform === "linux") {
      const out = await ctx.probes.run("systemctl", ["--user", "show", AI_WORKER_SYSTEMD_UNIT, "-p", "MainPID"]);
      if (out.kind !== "ran" || out.exitCode !== 0) return { pid: null, reason: t("checks.config.shipped.noAnswer", { command: "systemctl --user show" }) };
      const pid = Number(/^MainPID=(\d+)\s*$/m.exec(out.stdout)?.[1] ?? "0");
      return pid > 0 ? { pid } : { pid: null, reason: t("checks.config.shipped.notRunning", { service: AI_WORKER_SYSTEMD_UNIT }) };
    }
    return { pid: null, reason: t("checks.config.shipped.noServiceManager") };
  });
}

/** The receipt of the service's current PID (lock, heartbeat and own report since its lock), or null when it cannot be judged. */
export function aiWorkerServiceReceipt(ctx: DoctorContext): Promise<{ pid: number; receipt: WorkerEvidence } | null> {
  return cached(ctx, "aiworker.receipt", async () => {
    if (ctx.config.ai.execution !== "host") return null;
    try {
      const service = await aiWorkerServicePid(ctx);
      if (service.pid === null) return null;
      const receipt = await withTimeout(ctx.probes.aiWorkerReceipt(service.pid), ctx.settings.probe_timeout_seconds * 1000, "ai-worker receipt");
      return receipt.status === "unknown" ? null : { pid: service.pid, receipt };
    } catch {
      return null;
    }
  });
}

/** `systemctl show -p LoadState -p ActiveState` output: `LoadState=loaded` / `ActiveState=active` lines. */
export function parseSystemctlShow(stdout: string): { load: string | null; active: string | null } {
  const field = (name: string): string | null => new RegExp(`^${name}=(.*)$`, "m").exec(stdout)?.[1]?.trim() || null;
  return { load: field("LoadState"), active: field("ActiveState") };
}

/** Linux: the systemd user unit runs; without one, a worker started by hand still counts (warning). */
async function systemdOutcome(ctx: DoctorContext): Promise<CheckOutcome> {
  const { t } = ctx;
  const unit = AI_WORKER_SYSTEMD_UNIT;
  const out = await ctx.probes.run("systemctl", ["--user", "show", unit, "-p", "LoadState", "-p", "ActiveState"]);
  const heartbeatAge = async (): Promise<number | null> => {
    const sources = await tryLoadSources(ctx);
    return sources?.aiWorker.online === true ? sources.aiWorker.ageSeconds : null;
  };
  if (out.kind === "timeout") return warn(launchdSpec, t("checks.aiworker.launchd.systemdTimeout"), t("checks.aiworker.launchd.timeoutHint"));
  if (out.kind === "missing" || out.exitCode !== 0) {
    const alive = await heartbeatAge();
    if (alive !== null) return warn(launchdSpec, t("checks.aiworker.launchd.noSystemdManual", { age: alive }), t("checks.aiworker.launchd.noSystemdHint"));
    return warn(launchdSpec, t("checks.aiworker.launchd.noSystemd"), t("checks.aiworker.launchd.noSystemdHint"));
  }
  const info = parseSystemctlShow(out.stdout);
  if (info.active === "active") return ok(launchdSpec, t("checks.aiworker.launchd.systemdRunning", { unit }));
  if (info.load === "not-found" || info.load === null) {
    const alive = await heartbeatAge();
    if (alive !== null) return warn(launchdSpec, t("checks.aiworker.launchd.systemdManual", { unit, age: alive }), t("checks.aiworker.launchd.manualHint"));
    return fail(launchdSpec, t("checks.aiworker.launchd.systemdNotInstalled", { unit }), t("checks.aiworker.launchd.notInstalledHint"));
  }
  return fail(
    launchdSpec,
    t("checks.aiworker.launchd.systemdNotRunning", { unit, state: info.active ?? t("common.unknown") }),
    t("checks.aiworker.launchd.systemdNotRunningHint", { unit, errLog: workerLogs(ctx).err }),
  );
}

export const aiWorkerLaunchdCheck: DoctorCheck = {
  ...launchdSpec,
  async run(ctx) {
    const { t } = ctx;
    if (ctx.config.ai.execution !== "host") return ok(launchdSpec, t("checks.aiworker.launchd.notHost"));
    if (ctx.platform === "linux") return systemdOutcome(ctx);
    if (ctx.platform !== "darwin" || ctx.uid === null) return warn(launchdSpec, t("checks.aiworker.launchd.notMacos"), t("checks.aiworker.launchd.notMacosHint"));
    const label = aiWorkerLaunchdLabel(ctx.settings.ai_worker_launchd_label);
    const out = await ctx.probes.run("launchctl", ["print", `gui/${ctx.uid}/${label}`]);
    const heartbeatAge = async (): Promise<number | null> => {
      const sources = await tryLoadSources(ctx);
      return sources?.aiWorker.online === true ? sources.aiWorker.ageSeconds : null;
    };
    if (out.kind === "timeout") return warn(launchdSpec, t("checks.aiworker.launchd.timeout"), t("checks.aiworker.launchd.timeoutHint"));
    if (out.kind === "missing" || out.exitCode !== 0) {
      const otherLabel = label === LEGACY_LAUNCHD_LABEL ? AI_WORKER_DEFAULT_LAUNCHD_LABEL : LEGACY_LAUNCHD_LABEL;
      const legacy = await ctx.probes.run("launchctl", ["print", `gui/${ctx.uid}/${otherLabel}`]);
      if (legacy.kind === "ran" && legacy.exitCode === 0) return warn(launchdSpec, t("checks.aiworker.launchd.legacy", { legacy: otherLabel, label }), t("checks.aiworker.launchd.legacyHint", { label }));
      const alive = await heartbeatAge();
      if (alive !== null) return warn(launchdSpec, t("checks.aiworker.launchd.manual", { label, age: alive }), t("checks.aiworker.launchd.manualHint"));
      return fail(launchdSpec, t("checks.aiworker.launchd.notInstalled", { label }), t("checks.aiworker.launchd.notInstalledHint"));
    }
    const info = parseLaunchctlPrint(out.stdout);
    const logs = workerLogs(ctx);
    if (info.state === "running") {
      const running = info.pid !== null ? t("checks.aiworker.launchd.runningPid", { label, pid: String(info.pid) }) : t("checks.aiworker.launchd.running", { label });
      if (isOldLogLayout(info.stdoutPath)) return warn(launchdSpec, t("checks.aiworker.launchd.oldLogs", { running, path: info.stdoutPath ?? "" }), t("checks.aiworker.launchd.oldLogsHint"));
      return ok(launchdSpec, running);
    }
    const state = info.state ?? t("common.unknown");
    return fail(
      launchdSpec,
      info.lastExitCode !== null ? t("checks.aiworker.launchd.notRunningExit", { label, state, code: info.lastExitCode }) : t("checks.aiworker.launchd.notRunning", { label, state }),
      t("checks.aiworker.launchd.notRunningHint", { launchdLog: logs.launchd, errLog: logs.err }),
    );
  },
};

const heartbeatSpec = { id: "aiworker.heartbeat", group: "processes" } as const;

export const aiWorkerHeartbeatCheck: DoctorCheck = {
  ...heartbeatSpec,
  async run(ctx) {
    const { t } = ctx;
    if (ctx.config.ai.execution !== "host") return ok(heartbeatSpec, t("checks.aiworker.heartbeat.notHost"));
    const { aiWorker } = await loadSources(ctx);
    const limit = aiWorker.offlineAfterSeconds;
    if (aiWorker.lastHeartbeatAt === null) return fail(heartbeatSpec, t("checks.aiworker.heartbeat.never"), t("checks.aiworker.heartbeat.neverHint"));
    const age = ageSeconds(aiWorker.lastHeartbeatAt, ctx.now);
    if (!aiWorker.online) {
      const logs = workerLogs(ctx);
      let label: string = AI_WORKER_DEFAULT_LAUNCHD_LABEL;
      if (ctx.platform === "darwin") {
        try {
          label = aiWorkerLaunchdLabel(ctx.settings.ai_worker_launchd_label);
        } catch {
          // A diagnostic hint must not replace the offline result with a label-validation failure.
          label = "<label>";
        }
      }
      return fail(heartbeatSpec, t("checks.aiworker.heartbeat.offline", { ago: formatAgo(ctx, age), limit }), t("checks.aiworker.heartbeat.offlineHint", { errLog: logs.err, launchdLog: logs.launchd, label }));
    }
    const r = await aiWorkerServiceReceipt(ctx);
    if (r?.receipt.status === "not_yet") {
      if (r.receipt.reason === "other-holder") {
        return warn(heartbeatSpec, t("checks.aiworker.heartbeat.otherHolder", { age, pid: r.pid, holder: r.receipt.holder ?? t("common.unknown") }), t("checks.aiworker.heartbeat.otherHolderHint"));
      }
      const logs = workerLogs(ctx);
      return warn(heartbeatSpec, t("checks.aiworker.heartbeat.notConfirmed", { age, pid: r.pid }), t("checks.aiworker.heartbeat.notConfirmedHint", { errLog: logs.err, outLog: logs.out }));
    }
    return ok(heartbeatSpec, t("checks.aiworker.heartbeat.ok", { age, limit }));
  },
};

// ---------------------------------------------------------------- logins

type Login = { state: "logged_in"; note: string } | { state: "logged_out" } | { state: "missing" } | { state: "unknown"; reason: string };

const claudeStatusSchema = z.object({ loggedIn: z.boolean(), subscriptionType: z.string().optional() });

function claudeLogin(ctx: DoctorContext): Promise<Login> {
  return cached(ctx, "login:claude", async () => {
    const { t } = ctx;
    const command = ctx.config.ai.providers.claude_cli.command;
    const out = await ctx.probes.run(command, ["auth", "status"]);
    if (out.kind === "missing") return { state: "missing" };
    if (out.kind === "timeout") return { state: "unknown", reason: t("checks.ai.login.noAnswer", { command: `${command} auth status` }) };
    const parsed = claudeStatusSchema.safeParse(extractJson(out.stdout));
    if (!parsed.success) return { state: "unknown", reason: t("checks.ai.login.unreadableClaude", { command: `${command} auth status` }) };
    if (!parsed.data.loggedIn) return { state: "logged_out" };
    return { state: "logged_in", note: parsed.data.subscriptionType ? t("checks.ai.login.subscription", { plan: parsed.data.subscriptionType }) : t("checks.ai.login.loggedIn") };
  });
}

function codexLogin(ctx: DoctorContext): Promise<Login> {
  return cached(ctx, "login:codex", async () => {
    const { t } = ctx;
    const command = ctx.config.ai.providers.codex_cli.command;
    const out = await ctx.probes.run(command, ["login", "status"]);
    if (out.kind === "missing") return { state: "missing" };
    if (out.kind === "timeout") return { state: "unknown", reason: t("checks.ai.login.noAnswer", { command: `${command} login status` }) };
    const text = `${out.stdout}\n${out.stderr}`;
    if (out.exitCode === 0 && /logged in/i.test(text)) return { state: "logged_in", note: t("checks.ai.login.loggedIn") };
    if (/not logged in|logged out/i.test(text) || out.exitCode !== 0) return { state: "logged_out" };
    return { state: "unknown", reason: t("checks.ai.login.unreadable", { command: `${command} login status` }) };
  });
}

function loginResult(spec: Spec, provider: "claude-cli" | "codex-cli", login: Login, other: Login, ctx: DoctorContext, loginHint: string, command: string): CheckOutcome {
  const { t } = ctx;
  if (!ctx.config.ai.order.includes(provider)) return ok(spec, t("checks.ai.login.notUsed", { provider }));
  if (login.state === "logged_in") return ok(spec, t("checks.ai.login.ok", { note: login.note }));
  // The other login keeps the AI running: a warning. Neither works: nothing can score or push.
  const otherWorks = other.state === "logged_in";
  const make = otherWorks ? warn : fail;
  const tail = otherWorks ? t("checks.ai.login.otherWorks") : t("checks.ai.login.noneWorks");
  if (login.state === "missing") return make(spec, t("checks.ai.login.missing", { command, tail }), t("checks.ai.login.missingHint", { loginHint }));
  if (login.state === "logged_out") return make(spec, t("checks.ai.login.loggedOut", { tail }), loginHint);
  return warn(spec, login.reason, t("checks.ai.login.unknownHint", { command, loginHint }));
}

const claudeSpec = { id: "ai.claude", group: "ai" } as const;
const codexSpec = { id: "ai.codex", group: "ai" } as const;

export const claudeLoginCheck: DoctorCheck = {
  ...claudeSpec,
  async run(ctx) {
    const [claude, codex] = await Promise.all([claudeLogin(ctx), codexLogin(ctx)]);
    return loginResult(claudeSpec, "claude-cli", claude, codex, ctx, ctx.t("checks.ai.claude.loginHint"), ctx.config.ai.providers.claude_cli.command);
  },
};

export const codexLoginCheck: DoctorCheck = {
  ...codexSpec,
  async run(ctx) {
    const [claude, codex] = await Promise.all([claudeLogin(ctx), codexLogin(ctx)]);
    return loginResult(codexSpec, "codex-cli", codex, claude, ctx, ctx.t("checks.ai.codex.loginHint"), ctx.config.ai.providers.codex_cli.command);
  },
};

// ---------------------------------------------------------------- profile

const profileSpec = { id: "ai.profile", group: "ai" } as const;

const PROFILE_FIELD_KEYS = { summary: "checks.ai.profile.fieldSummary", skills: "checks.ai.profile.fieldSkills" } as const;

/**
 * With neither a summary nor skills in me.yaml scoring is skipped, every job stays "waiting for AI score" and
 * nothing is pushed. A warning while nothing waits yet; a failure once jobs wait for a score.
 */
export const profileCheck: DoctorCheck = {
  ...profileSpec,
  async run(ctx) {
    const { t } = ctx;
    const profile = await ctx.probes.profile();
    if (profile === null) return warn(profileSpec, t("checks.ai.profile.unreadable"), t("checks.ai.profile.unreadableHint"));
    if (profile.usable) return ok(profileSpec, t("checks.ai.profile.ok"));
    const fields = joinList(
      ctx,
      profile.missing.map((field) => (field in PROFILE_FIELD_KEYS ? t(PROFILE_FIELD_KEYS[field as keyof typeof PROFILE_FIELD_KEYS]) : field)),
    );
    let waiting: number | null = null;
    try {
      waiting = await cached(ctx, "unscored", () => ctx.probes.unscoredJobs());
    } catch {
      // no database: the profile alone decides
    }
    if (waiting !== null && waiting > 0) return fail(profileSpec, t("checks.ai.profile.missingWaiting", { fields, waiting }), t("checks.ai.profile.hint"));
    return warn(profileSpec, t("checks.ai.profile.missing", { fields }), t("checks.ai.profile.hint"));
  },
};

// ---------------------------------------------------------------- backlog

const backlogSpec = { id: "ai.backlog", group: "schedule" } as const;

export const aiBacklogCheck: DoctorCheck = {
  ...backlogSpec,
  async run(ctx) {
    const { t } = ctx;
    const sources = await loadSources(ctx);
    const unscored = await cached(ctx, "unscored", () => ctx.probes.unscoredJobs());
    const { queue, lastRun } = sources.aiWorker;
    const pieces: Piece[] = [];

    const oldestAge = queue.oldestPendingAt === null ? null : ageSeconds(queue.oldestPendingAt, ctx.now);
    const tooMany = queue.pending >= ctx.settings.ai_backlog_warn;
    const tooOld = oldestAge !== null && oldestAge >= ctx.settings.ai_oldest_pending_warn_minutes * 60;
    pieces.push({
      status: tooMany || tooOld ? "warn" : "ok",
      detail:
        oldestAge !== null
          ? t("checks.ai.backlog.queueOldest", { pending: queue.pending, running: queue.running, oldest: formatDuration(ctx, oldestAge) })
          : t("checks.ai.backlog.queue", { pending: queue.pending, running: queue.running }),
      hint: t("checks.ai.backlog.queueHint"),
    });
    pieces.push({ status: unscored >= ctx.settings.ai_unscored_warn ? "warn" : "ok", detail: t("checks.ai.backlog.unscored", { count: unscored }), hint: t("checks.ai.backlog.unscoredHint") });
    if (lastRun !== null && lastRun.aiStatus === "skipped_profile_incomplete") {
      pieces.push({ status: "warn", detail: t("checks.ai.backlog.profileIncomplete"), hint: t("checks.ai.backlog.profileIncompleteHint") });
    } else if (lastRun !== null) {
      const failed = lastRun.status === "failed";
      pieces.push({
        status: failed ? "warn" : "ok",
        detail: failed ? t("checks.ai.backlog.lastFailed", { error: lastRun.error ?? t("checks.ai.backlog.unknownReason") }) : t("checks.ai.backlog.lastOk", { scored: lastRun.scored ?? 0, pushed: lastRun.pushed ?? 0 }),
        hint: t("checks.ai.backlog.lastHint", { errLog: workerLogs(ctx).err }),
      });
    }
    return merge(ctx, backlogSpec, pieces);
  },
};

// ---------------------------------------------------------------- usage cap

const quotaSpec = { id: "ai.quota", group: "ai" } as const;

/**
 * Job Radar's own AI usage cap of the subscription CLIs (ai.yaml `quota_guard`): ok while no CLI's rolling window is full;
 * a full window (or a limit the provider reported) warns with the time the CLI is expected back. Only Job Radar's own
 * calls are counted, so this says nothing about what is left of the account's quota.
 */
export const aiQuotaCheck: DoctorCheck = {
  ...quotaSpec,
  async run(ctx) {
    const { t } = ctx;
    if (!ctx.config.ai.quota_guard.enabled) return ok(quotaSpec, t("checks.ai.quota.off"));
    const { ai } = await loadSources(ctx);
    const zone = ctx.config.schedule.timezone;
    const pieces: Piece[] = [];
    for (const provider of ai.providers) {
      const quota = provider.quota;
      if (quota === null) continue;
      const usage = quota.hardRequests > 0 ? t("checks.ai.quota.usage", { used: quota.windowRequests, cap: quota.hardRequests, hours: quota.windowHours }) : t("checks.ai.quota.usageOff", { used: quota.windowRequests, hours: quota.windowHours });
      if (quota.level !== "hard") {
        pieces.push({ status: "ok", detail: t("checks.ai.quota.ok", { provider: provider.id, usage }) });
        continue;
      }
      const until = quota.resumeAt ? formatLocal(quota.resumeAt, zone) : t("checks.ai.quota.unknownTime");
      const detail = quota.reason === "error" ? t("checks.ai.quota.cooling", { provider: provider.id, until }) : t("checks.ai.quota.hard", { provider: provider.id, until, usage });
      pieces.push({ status: "warn", detail, hint: t("checks.ai.quota.hint") });
    }
    if (pieces.length === 0) return ok(quotaSpec, t("checks.ai.quota.none"));
    return merge(ctx, quotaSpec, pieces);
  },
};

// ---------------------------------------------------------------- config guards

const guardsSpec = { id: "config.guards", group: "ai" } as const;

/**
 * What the worker-side guards do with the current config (`src/lib/ops/config-guards.ts`): a refused CLI command is a
 * failure (that provider never runs), dropped codex overrides, refused or custom credential endpoints and the opt-in
 * variable are warnings.
 */
export const configGuardsCheck: DoctorCheck = {
  ...guardsSpec,
  async run(ctx) {
    const { t } = ctx;
    const findings = configGuardFindings({ ai: ctx.config.ai, notify: ctx.config.notify, channels: ctx.config.channels }, ctx.env);
    const pieces: Piece[] = [];
    // An installed codex below `min_version` (the oldest that has the options we pass) warns; equal or newer is fine.
    const codex = ctx.config.ai.providers.codex_cli;
    if (codex.enabled && ctx.config.ai.order.includes("codex-cli") && cliCommandProblem("codex-cli", codex.command) === null) {
      const out = await ctx.probes.run(codex.command, ["--version"]);
      const installed = out.kind === "ran" ? parseCodexVersion(out.stdout) : null;
      if (installed !== null && isCodexOlderThan(installed, codex.min_version)) {
        pieces.push({ status: "warn", detail: t("checks.config.guards.codexVersion", { installed, minimum: codex.min_version }), hint: t("checks.config.guards.codexVersionHint") });
      }
    }
    if (findings.length === 0 && pieces.length === 0) return ok(guardsSpec, t("checks.config.guards.ok"));
    const dropped = findings.filter((f) => f.kind === "override_dropped").map((f) => f.subject.replace(/^ai\.yaml providers\.codex_cli\.config_overrides\./, ""));
    if (dropped.length > 0) pieces.push({ status: "warn", detail: t("checks.config.guards.dropped", { keys: joinList(ctx, dropped) }), hint: t("checks.config.guards.droppedHint") });
    for (const finding of findings) {
      if (finding.kind === "custom_endpoints_env") pieces.push({ status: "warn", detail: t("checks.config.guards.envSet"), hint: t("checks.config.guards.envSetHint") });
      else if (finding.kind === "model_refused") pieces.push({ status: "fail", detail: t("checks.config.guards.refused", { detail: finding.message }), hint: t("checks.config.guards.modelRefusedHint") });
      else if (finding.kind === "command_refused") pieces.push({ status: "fail", detail: t("checks.config.guards.refused", { detail: finding.message }), hint: t("checks.config.guards.refusedHint") });
      else if (finding.kind === "endpoint_refused") pieces.push({ status: "warn", detail: t("checks.config.guards.endpointRefused", { subject: finding.subject }), hint: t("checks.config.guards.endpointRefusedHint") });
      else if (finding.kind === "endpoint_custom") pieces.push({ status: "warn", detail: t("checks.config.guards.endpointCustom", { subject: finding.subject }), hint: t("checks.config.guards.endpointCustomHint") });
    }
    return merge(ctx, guardsSpec, pieces);
  },
};

export const AI_CHECKS: readonly DoctorCheck[] = [aiWorkerLaunchdCheck, aiWorkerHeartbeatCheck, claudeLoginCheck, codexLoginCheck, profileCheck, aiQuotaCheck, configGuardsCheck];
export const BACKLOG_CHECKS: readonly DoctorCheck[] = [aiBacklogCheck];
