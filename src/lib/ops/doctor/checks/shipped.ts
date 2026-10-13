/**
 * `config.shipped`: which shipped defaults the running processes report, and whether each report really comes from the
 * process running now (a report is only a row in the database: it outlives the process that wrote it).
 *
 *   - web, runner (containers): the report's `instance` (the container's host name) is the start of the running container's
 *     id, and the report was written no earlier than the container's start minus `doctor.shipped_report_skew_seconds`;
 *   - ai-worker (with `execution: host`): the report is newer than `ai.yaml host_worker.offline_after_seconds`, and its PID is
 *     the PID launchd / systemd gives for the service. No PID from the service manager means the report cannot be matched.
 *
 * It also warns when a running container of the project has something mounted over /app/config: the shipped defaults
 * are part of the image, and a mount there (a compose file from before that change) hides them.
 *
 * Every case that cannot be confirmed is a warning; there is no failure. Without the database the check is skipped.
 */
import { z } from "zod";

import { SHIPPED_CONFIG_PROCESSES, shortShippedConfigId, type ShippedConfigProcess } from "@/lib/config/shipped-id";
import type { ShippedConfigReportRow } from "@/lib/db/repos/runtime-state";

import { ageSeconds, cached, formatAgo, ok, warn } from "../helpers";
import { dbUp } from "../shared";
import { SkipCheck, type CommandOutcome, type DoctorCheck, type DoctorContext } from "../types";
import { AI_WORKER_SYSTEMD_UNIT, aiWorkerLaunchdLabel, parseLaunchctlPrint } from "./ai";

const spec = { id: "config.shipped", group: "data" } as const;

/** The processes that run as compose services, under the same service name. */
const CONTAINER_PROCESSES = ["web", "runner"] as const satisfies readonly ShippedConfigProcess[];

interface RunningContainer {
  id: string;
  service: string;
  /** Docker's start time; null when it cannot be read. */
  startedAt: Date | null;
  /** The sources of whatever is mounted on /app/config or below it (the shipped defaults in the image). */
  configMounts: string[];
}

type Containers = { available: true; running: RunningContainer[] } | { available: false; reason: string };

const inspectSchema = z.array(
  z.object({
    Id: z.string(),
    State: z.object({ StartedAt: z.string().optional(), Running: z.boolean().optional() }).optional(),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable().optional() }).optional(),
    Mounts: z
      .array(z.object({ Destination: z.string(), Source: z.string().optional(), Name: z.string().optional() }))
      .nullable()
      .optional(),
  }),
);

/** Where the images keep the shipped defaults (Dockerfile: COPY config/ /app/config/). */
const SHIPPED_DIR_IN_IMAGE = "/app/config";

const SERVICE_LABEL = "com.docker.compose.service";

function dockerProblem(ctx: DoctorContext, out: CommandOutcome): string | null {
  if (out.kind === "missing") return ctx.t("checks.compose.noDocker");
  if (out.kind === "timeout") return ctx.t("checks.compose.dockerTimeout");
  return null;
}

/** The running containers of the compose project: ids from `docker ps`, start times and services from `docker inspect`. */
export function loadRunningContainers(ctx: DoctorContext): Promise<Containers> {
  return cached(ctx, "shipped:containers", async () => {
    const ps = await ctx.probes.run("docker", ["ps", "--no-trunc", "--filter", `label=com.docker.compose.project=${ctx.settings.compose_project}`, "--format", "{{.ID}}"]);
    const psProblem = dockerProblem(ctx, ps);
    if (psProblem !== null) return { available: false, reason: psProblem };
    if (ps.kind !== "ran" || ps.exitCode !== 0) return { available: false, reason: ctx.t("checks.compose.dockerDown") };
    const ids = ps.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{12,64}$/.test(line));
    if (ids.length === 0) return { available: true, running: [] };
    const inspect = await ctx.probes.run("docker", ["inspect", ...ids]);
    const inspectProblem = dockerProblem(ctx, inspect);
    if (inspectProblem !== null) return { available: false, reason: inspectProblem };
    // A container that stopped between the two calls makes `docker inspect` exit 1 but still print the others.
    let parsed: z.infer<typeof inspectSchema> | null = null;
    if (inspect.kind === "ran") {
      try {
        const result = inspectSchema.safeParse(JSON.parse(inspect.stdout));
        if (result.success) parsed = result.data;
      } catch {
        // not JSON
      }
    }
    if (parsed === null) return { available: false, reason: ctx.t("checks.config.shipped.inspectUnreadable") };
    const running: RunningContainer[] = [];
    for (const row of parsed) {
      if (row.State?.Running === false) continue;
      const started = row.State?.StartedAt === undefined ? Number.NaN : Date.parse(row.State.StartedAt);
      const configMounts = (row.Mounts ?? [])
        .filter((m) => m.Destination === SHIPPED_DIR_IN_IMAGE || m.Destination.startsWith(`${SHIPPED_DIR_IN_IMAGE}/`))
        .map((m) => m.Source || m.Name || m.Destination);
      running.push({ id: row.Id, service: row.Config?.Labels?.[SERVICE_LABEL] ?? "", startedAt: Number.isNaN(started) ? null : new Date(started), configMounts });
    }
    return { available: true, running };
  });
}

/** The ai-worker's PID as the service manager gives it, or why there is none. */
async function workerPid(ctx: DoctorContext): Promise<{ pid: number } | { pid: null; reason: string }> {
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
}

/** One process: null when its report is confirmed, else what is wrong (in the report's language). */
type Finding = { process: ShippedConfigProcess; problem: string | null; id: string | null };

function containerFinding(ctx: DoctorContext, process: ShippedConfigProcess, row: ShippedConfigReportRow | null, containers: Containers): Finding {
  const { t } = ctx;
  const id = row === null ? null : shortShippedConfigId(row.report.id);
  const finding = (problem: string | null): Finding => ({ process, problem, id });
  if (row === null) return finding(t("checks.config.shipped.noReport", { process }));
  if (!containers.available) return finding(t("checks.config.shipped.dockerUnavailable", { process, reason: containers.reason }));
  const mine = containers.running.filter((c) => c.service === process);
  if (mine.length === 0) return finding(t("checks.config.shipped.noContainer", { process, project: ctx.settings.compose_project }));
  const match = mine.find((c) => c.id.startsWith(row.report.instance));
  if (match === undefined) {
    return finding(t("checks.config.shipped.otherContainer", { process, instance: row.report.instance, running: mine.map((c) => c.id.slice(0, 12)).join(", ") }));
  }
  if (match.startedAt === null) return finding(t("checks.config.shipped.noStartTime", { process }));
  const earliest = match.startedAt.getTime() - ctx.settings.shipped_report_skew_seconds * 1000;
  if (row.updatedAt.getTime() < earliest) {
    return finding(t("checks.config.shipped.beforeStart", { process, reported: row.updatedAt.toISOString(), started: match.startedAt.toISOString() }));
  }
  return finding(null);
}

async function workerFinding(ctx: DoctorContext, row: ShippedConfigReportRow | null): Promise<Finding> {
  const { t } = ctx;
  const process = "ai-worker";
  const id = row === null ? null : shortShippedConfigId(row.report.id);
  const finding = (problem: string | null): Finding => ({ process, problem, id });
  if (row === null) return finding(t("checks.config.shipped.noReport", { process }));
  const limit = ctx.config.ai.host_worker.offline_after_seconds;
  const age = ageSeconds(row.updatedAt, ctx.now);
  if (age > limit) return finding(t("checks.config.shipped.stale", { process, ago: formatAgo(ctx, age), limit }));
  const service = await workerPid(ctx);
  if (service.pid === null) return finding(t("checks.config.shipped.noPid", { process, reason: service.reason }));
  if (service.pid !== row.report.pid) return finding(t("checks.config.shipped.otherPid", { process, reported: row.report.pid, running: service.pid }));
  return finding(null);
}

export const shippedConfigCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    const { t } = ctx;
    if (!(await dbUp(ctx))) throw new SkipCheck(t("common.dbDown"));
    let reports: Awaited<ReturnType<DoctorContext["probes"]["shippedConfigReports"]>>;
    try {
      reports = await ctx.probes.shippedConfigReports();
    } catch {
      throw new SkipCheck(t("common.dbUnreadable"));
    }
    const findings: Finding[] = [];
    const mountProblems: string[] = [];
    const services = CONTAINER_PROCESSES.filter((process) => ctx.settings.compose_services.includes(process));
    if (services.length > 0) {
      const containers = await loadRunningContainers(ctx);
      for (const process of services) findings.push(containerFinding(ctx, process, reports[process], containers));
      if (containers.available) {
        for (const c of containers.running) {
          if (c.configMounts.length === 0) continue;
          mountProblems.push(t("checks.config.shipped.configMounted", { service: c.service || c.id.slice(0, 12), source: c.configMounts.join(", "), dir: SHIPPED_DIR_IN_IMAGE }));
        }
      }
    }
    if (ctx.config.ai.execution === "host") findings.push(await workerFinding(ctx, reports["ai-worker"]));
    findings.sort((a, b) => SHIPPED_CONFIG_PROCESSES.indexOf(a.process) - SHIPPED_CONFIG_PROCESSES.indexOf(b.process));

    const reportProblems = findings.filter((f) => f.problem !== null).map((f) => f.problem as string);
    const problems = [...mountProblems, ...reportProblems];
    const confirmed = findings
      .filter((f) => f.problem === null)
      .map((f) => t("checks.config.shipped.item", { process: f.process, id: f.id ?? "" }))
      .join(t("common.detailSeparator"));
    if (problems.length > 0) {
      const detail = [...problems, ...(confirmed === "" ? [] : [confirmed])].join(t("common.detailSeparator"));
      const hints = [...(mountProblems.length > 0 ? [t("checks.config.shipped.configMountedHint")] : []), ...(reportProblems.length > 0 ? [t("checks.config.shipped.hint")] : [])];
      return warn(spec, detail, hints.join(t("common.detailSeparator")));
    }
    if (findings.length === 0) return ok(spec, t("checks.config.shipped.nothing"));
    return ok(spec, confirmed);
  },
};

export const SHIPPED_CHECKS: readonly DoctorCheck[] = [shippedConfigCheck];
