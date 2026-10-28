/** Docker, the compose services, the web app and the database. */
import fs from "node:fs";

import { isLoopbackBind, WEB_BIND_ENV } from "@/lib/security/local-request";
import { readPasswordSetting } from "@/lib/security/password";

import { ageSeconds, fail, joinList, ok, warn } from "../helpers";
import { dbUp, jobspyBaseUrl, jobspyInUse, loadCompose, loadSources, loadWebHealth, tryLoadSources, type ComposeContainer } from "../shared";
import { SkipCheck, type CheckOutcome, type DoctorCheck, type DoctorContext } from "../types";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const dockerSpec = { id: "docker.daemon", group: "stack" } as const;

export const dockerDaemonCheck: DoctorCheck = {
  ...dockerSpec,
  async run(ctx) {
    const { t } = ctx;
    const out = await ctx.probes.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (out.kind === "missing") return fail(dockerSpec, t("checks.docker.daemon.missing"), t("checks.docker.daemon.missingHint"));
    if (out.kind === "timeout") return fail(dockerSpec, t("checks.docker.daemon.timeout"), t("checks.docker.daemon.timeoutHint"));
    if (out.exitCode !== 0) return fail(dockerSpec, t("checks.docker.daemon.down"), t("checks.docker.daemon.downHint"));
    const version = out.stdout.trim();
    return ok(dockerSpec, version === "" ? t("checks.docker.daemon.upNoVersion") : t("checks.docker.daemon.up", { version }));
  },
};

/** How a service that has no compose container can still be in use: processes started by hand on the host (UAT, `pnpm runner`). */
async function hostEvidence(ctx: DoctorContext, service: string): Promise<string | null> {
  const { t } = ctx;
  if (service === "db") return (await dbUp(ctx)) ? t("checks.compose.dbReachable") : null;
  if (service === "web") {
    const web = await loadWebHealth(ctx);
    return web.reachable && web.status !== null && web.status < 500 ? t("checks.compose.answers", { url: ctx.settings.web_url }) : null;
  }
  if (service === "runner") {
    const sources = await tryLoadSources(ctx);
    const age = sources?.runner.ageSeconds ?? null;
    return age !== null && age <= ctx.runnerMaxAgeSeconds ? t("checks.compose.runnerHeartbeat", { age }) : null;
  }
  if (service === "jobspy") {
    const base = jobspyBaseUrl(ctx);
    if (base === null) return null;
    const answer = await ctx.probes.http(`${base}/health`);
    return answer.ok ? t("checks.compose.answers", { url: base }) : null;
  }
  return null;
}

/**
 * `inUse` false: nothing needs the service right now (the jobspy sidecar while every channel that uses it is off), so a
 * missing, stopped or unhealthy container is a warning. A port published beyond loopback stays a failure.
 */
function composeResult(ctx: DoctorContext, service: string, containers: readonly ComposeContainer[], dockerReason: string | null, evidence: string | null, inUse: boolean): CheckOutcome {
  const { t } = ctx;
  const spec = { id: `compose.${service}`, group: "stack", title: t("checks.compose.serviceTitle", { service }) } as const;
  const down = (detail: string, hint: string): CheckOutcome => (inUse ? fail(spec, detail, hint) : warn(spec, t("checks.compose.notInUse", { detail }), hint));
  const logs = `docker compose -p ${ctx.settings.compose_project} logs --tail 100 ${service}`;
  const mine = containers.filter((c) => c.service === service);
  const running = mine.find((c) => c.state === "running");
  const container = running ?? mine[0];

  // Processes started by hand on the host (UAT, `pnpm runner`) can stand in for a container that is missing or stopped.
  const standIn = (state: string): CheckOutcome | null => (evidence === null ? null : warn(spec, t("checks.compose.standIn", { state, evidence }), t("checks.compose.standInHint")));

  if (container === undefined) {
    const state = dockerReason ?? t("checks.compose.noContainer", { project: ctx.settings.compose_project });
    const stoodIn = standIn(state);
    if (stoodIn !== null) return stoodIn;
    if (dockerReason !== null) return down(t("checks.compose.missingOnHost", { reason: dockerReason }), t("checks.compose.missingOnHostHint"));
    return down(state, t("checks.compose.missingHint"));
  }
  if (running === undefined) {
    const stoodIn = standIn(t("checks.compose.containerState", { state: container.state }));
    if (stoodIn !== null) return stoodIn;
  }

  const exposed = container.published.filter((p) => !LOOPBACK_HOSTS.has(p.host));
  // The web may be published beyond loopback on purpose (JOB_RADAR_WEB_BIND), but only behind the web password
  const intended = service === "web" && !isLoopbackBind(ctx.env[WEB_BIND_ENV]);
  if (exposed.length > 0 && !(intended && readPasswordSetting(ctx.env) !== null)) {
    const where = joinList(
      ctx,
      exposed.map((p) => `${p.host || t("checks.compose.allInterfaces")}:${p.port}`),
    );
    if (intended) return fail(spec, t("checks.compose.exposedNoPassword", { where }), t("checks.compose.exposedNoPasswordHint"));
    // published beyond loopback, but the web was told it listens on loopback: it still lets "local" requests skip the login
    if (service === "web") return fail(spec, t("checks.compose.exposedExemptionOn", { where }), t("checks.compose.exposedExemptionOnHint"));
    return fail(spec, t("checks.compose.exposed", { where }), t("checks.compose.exposedHint"));
  }

  if (container.state !== "running") {
    const detail = container.exitCode !== null && container.exitCode !== 0 ? t("checks.compose.stoppedWithExit", { state: container.state, code: container.exitCode }) : t("checks.compose.stopped", { state: container.state });
    return down(detail, t("checks.compose.stoppedHint", { logs, service }));
  }
  if (container.health === "unhealthy") return down(t("checks.compose.unhealthy"), t("checks.compose.unhealthyHint", { logs, service }));
  if (container.health === "starting") return warn(spec, t("checks.compose.starting"), t("checks.compose.startingHint", { logs }));
  const state = container.health === "healthy" ? t("checks.compose.runningHealthy") : t("checks.compose.runningNoHealthcheck");
  if (container.published.length === 0) return ok(spec, state);
  return ok(spec, t("checks.compose.withPorts", { state, ports: joinList(ctx, container.published.map((p) => `${p.host}:${p.port}`)) }));
}

export const composeServicesCheck: DoctorCheck = {
  id: "compose.services",
  group: "stack",
  async run(ctx) {
    const compose = await loadCompose(ctx);
    const results: CheckOutcome[] = [];
    for (const service of ctx.settings.compose_services) {
      const containers = compose.available ? compose.containers : [];
      const isRunning = containers.some((c) => c.service === service && c.state === "running");
      const evidence = isRunning ? null : await hostEvidence(ctx, service);
      results.push(composeResult(ctx, service, containers, compose.available ? null : compose.reason, evidence, service !== "jobspy" || jobspyInUse(ctx)));
    }
    return results;
  },
};

const projectSpec = { id: "compose.project", group: "stack" } as const;

function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * DATA-6: the compose project's containers were started from this checkout. A second clone with the same project name
 * would take over the first one's containers (and share its database volume); each instance needs its own names.
 */
export const composeProjectCheck: DoctorCheck = {
  ...projectSpec,
  async run(ctx) {
    const { t } = ctx;
    const project = ctx.settings.compose_project;
    const compose = await loadCompose(ctx);
    if (!compose.available) throw new SkipCheck(compose.reason);
    const dirs = [...new Set(compose.containers.map((c) => c.workingDir).filter((dir): dir is string => dir !== null))];
    if (dirs.length === 0) return ok(projectSpec, t("checks.compose.project.none", { project }));
    const here = realDir(ctx.appRoot);
    const others = dirs.filter((dir) => realDir(dir) !== here);
    if (others.length > 0) return warn(projectSpec, t("checks.compose.project.otherDir", { project, dir: joinList(ctx, others) }), t("checks.compose.project.otherDirHint"));
    return ok(projectSpec, t("checks.compose.project.ok", { project }));
  },
};

const webSpec = { id: "web.http", group: "stack" } as const;

export const webCheck: DoctorCheck = {
  ...webSpec,
  async run(ctx) {
    const { t } = ctx;
    const web = await loadWebHealth(ctx);
    const url = `${ctx.settings.web_url.replace(/\/+$/, "")}/api/health`;
    if (!web.reachable) {
      return fail(webSpec, t("checks.web.http.noAnswer", { url, error: web.error ?? "unknown" }), t("checks.web.http.noAnswerHint", { project: ctx.settings.compose_project, port: new URL(ctx.settings.web_url).port || "80" }));
    }
    if (web.status !== 200) {
      return fail(webSpec, t(web.dbOk ? "checks.web.http.status" : "checks.web.http.statusNoDb", { url, status: web.status ?? 0 }), t("checks.web.http.statusHint"));
    }
    return ok(webSpec, t("checks.web.http.ok", { url }));
  },
};

const dbSpec = { id: "db.connect", group: "stack" } as const;

export const dbConnectCheck: DoctorCheck = {
  ...dbSpec,
  async run(ctx) {
    const { t } = ctx;
    if (await dbUp(ctx)) return ok(dbSpec, t("checks.db.connect.ok"));
    return fail(dbSpec, t("checks.db.connect.fail"), t("checks.db.connect.failHint", { project: ctx.settings.compose_project }));
  },
};

const migrationsSpec = { id: "db.migrations", group: "stack" } as const;

export const migrationsCheck: DoctorCheck = {
  ...migrationsSpec,
  async run(ctx) {
    const { t } = ctx;
    if (!(await dbUp(ctx))) throw new SkipCheck(t("common.dbDown"));
    const status = await ctx.probes.migrations();
    const { applied, expected } = status;
    if (expected === null) return warn(migrationsSpec, t("checks.db.migrations.noJournal", { applied: applied.count }), t("checks.db.migrations.noJournalHint"));
    if (applied.count === 0) return fail(migrationsSpec, t("checks.db.migrations.none", { expected: expected.count }), t("checks.db.migrations.noneHint"));
    const behind = applied.count < expected.count || (expected.latestAt !== null && (applied.latestAt ?? 0) < expected.latestAt);
    if (behind) {
      return fail(migrationsSpec, t("checks.db.migrations.behind", { missing: Math.max(1, expected.count - applied.count), applied: applied.count, expected: expected.count }), t("checks.db.migrations.behindHint"));
    }
    if (applied.count > expected.count || (expected.latestAt !== null && (applied.latestAt ?? 0) > expected.latestAt)) {
      return warn(migrationsSpec, t("checks.db.migrations.ahead", { applied: applied.count, expected: expected.count }), t("checks.db.migrations.aheadHint"));
    }
    return ok(migrationsSpec, t("checks.db.migrations.ok", { applied: applied.count }));
  },
};

const runnerSpec = { id: "runner.heartbeat", group: "processes" } as const;

export const runnerHeartbeatCheck: DoctorCheck = {
  ...runnerSpec,
  async run(ctx) {
    const { t } = ctx;
    const sources = await loadSources(ctx);
    const age = sources.runner.lastHeartbeatAt === null ? null : ageSeconds(sources.runner.lastHeartbeatAt, ctx.now);
    const logs = `docker compose -p ${ctx.settings.compose_project} logs --tail 100 runner`;
    if (age === null) return fail(runnerSpec, t("checks.runner.heartbeat.never"), t("checks.runner.heartbeat.neverHint", { logs }));
    if (age > ctx.runnerMaxAgeSeconds) {
      return fail(runnerSpec, t("checks.runner.heartbeat.stale", { age, max: ctx.runnerMaxAgeSeconds }), t("checks.runner.heartbeat.staleHint", { logs }));
    }
    return ok(runnerSpec, t("checks.runner.heartbeat.ok", { age, max: ctx.runnerMaxAgeSeconds }));
  },
};

export const STACK_CHECKS: readonly DoctorCheck[] = [dockerDaemonCheck, composeServicesCheck, composeProjectCheck, webCheck, dbConnectCheck, migrationsCheck];
export const RUNNER_CHECKS: readonly DoctorCheck[] = [runnerHeartbeatCheck];
