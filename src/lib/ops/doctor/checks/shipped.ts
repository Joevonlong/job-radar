/**
 * `config.shipped`: which shipped defaults the running processes report, and whether each report really comes from the
 * process running now (a report is only a row in the database: it outlives the process that wrote it).
 *
 *   - web, runner (containers): the report's `instance` (the container's host name) is the start of the running container's
 *     id, and the report was written no earlier than the container's start minus `doctor.shipped_report_skew_seconds`;
 *   - ai-worker (with `execution: host`): the report is newer than `ai.yaml host_worker.offline_after_seconds`, and its PID is
 *     the PID launchd / systemd gives for the service. No PID from the service manager means the report cannot be matched.
 *     A confirmed report must also come from a release directory (`<app root>/data/releases/ai-worker/<commit>/config`)
 *     whose commit is the checkout's HEAD: anything else is the worker of another version (a worker-only rollback, an
 *     install from before release directories, a deploy that stopped half-way).
 *
 * It also warns when a running container of the project has something mounted over /app/config: the shipped defaults
 * are part of the image, and a mount there (a compose file from before that change) hides them.
 *
 * Every case that cannot be confirmed is a warning; there is no failure. Without the database the reports cannot be read:
 * the check is skipped, unless a mount over /app/config is found (that part needs only Docker).
 */
import { z } from "zod";

import { SHIPPED_CONFIG_PROCESSES, shortShippedConfigId, type ShippedConfigProcess } from "@/lib/config/shipped-id";
import type { ShippedConfigReportRow } from "@/lib/db/repos/runtime-state";

import { ageSeconds, cached, formatAgo, ok, warn } from "../helpers";
import { dbUp } from "../shared";
import { SkipCheck, type CommandOutcome, type DoctorCheck, type DoctorContext } from "../types";
import { aiWorkerServicePid, aiWorkerServiceReceipt } from "./ai";

const spec = { id: "config.shipped", group: "data" } as const;

/** The processes that run as compose services, under the same service name. */
const CONTAINER_PROCESSES = ["web", "runner"] as const satisfies readonly ShippedConfigProcess[];

interface RunningContainer {
  id: string;
  service: string;
  /** Docker's start time; null when it cannot be read. */
  startedAt: Date | null;
  /** Whatever is mounted on /app/config or below it (the shipped defaults in the image). */
  configMounts: ConfigMount[];
}

interface ConfigMount {
  /** The host path or volume name. */
  source: string;
  destination: string;
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
        .map((m) => ({ source: m.Source || m.Name || m.Destination, destination: m.Destination }));
      running.push({ id: row.Id, service: row.Config?.Labels?.[SERVICE_LABEL] ?? "", startedAt: Number.isNaN(started) ? null : new Date(started), configMounts });
    }
    return { available: true, running };
  });
}

/** One process: null when its report is confirmed, else what is wrong (in the report's language) and, optionally, what to do. */
type Finding = { process: ShippedConfigProcess; problem: string | null; id: string | null; hint?: string };

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

async function workerFinding(ctx: DoctorContext, row: ShippedConfigReportRow | null, receipt: Awaited<ReturnType<typeof aiWorkerServiceReceipt>>): Promise<Finding> {
  const { t } = ctx;
  const process = "ai-worker";
  const id = row === null ? null : shortShippedConfigId(row.report.id);
  const finding = (problem: string | null): Finding => ({ process, problem, id });
  const starting = receipt?.receipt.status === "not_yet" && ["no-holder", "no-heartbeat"].includes(receipt.receipt.reason)
    ? { ...finding(t("checks.config.shipped.starting", { process, pid: receipt.pid })), hint: t("checks.config.shipped.startingHint") }
    : null;
  if (row === null) return starting ?? finding(t("checks.config.shipped.noReport", { process }));
  const limit = ctx.config.ai.host_worker.offline_after_seconds;
  const age = ageSeconds(row.updatedAt, ctx.now);
  if (age > limit) return finding(t("checks.config.shipped.stale", { process, ago: formatAgo(ctx, age), limit }));
  const service = await aiWorkerServicePid(ctx);
  if (service.pid === null) return finding(t("checks.config.shipped.noPid", { process, reason: service.reason }));
  if (service.pid !== row.report.pid) return starting ?? finding(t("checks.config.shipped.otherPid", { process, reported: row.report.pid, running: service.pid }));
  return { ...(await releaseProblem(ctx, row)), process, id };
}

/** The confirmed worker report's directory: a release directory of this checkout, at HEAD. */
async function releaseProblem(ctx: DoctorContext, row: ShippedConfigReportRow): Promise<{ problem: string | null; hint?: string }> {
  const { t } = ctx;
  const process = "ai-worker";
  const releases = `${ctx.appRoot}/data/releases/ai-worker`;
  const dir = row.report.dir.replace(/\/+$/, "");
  const fromDir = dir.startsWith(`${releases}/`) ? /^([0-9a-f]{40})\/config$/.exec(dir.slice(releases.length + 1))?.[1] : undefined;
  if (fromDir === undefined) return { problem: t("checks.config.shipped.notRelease", { process, dir: row.report.dir, releases }), hint: t("checks.config.shipped.notReleaseHint", { root: ctx.appRoot }) };
  const release = row.report.release ?? fromDir;
  const out = await ctx.probes.run("git", ["-C", ctx.appRoot, "rev-parse", "HEAD"]);
  const head = out.kind === "ran" && out.exitCode === 0 ? /^([0-9a-f]{40})\s*$/.exec(out.stdout)?.[1] : undefined;
  if (head === undefined) {
    const reason = out.kind === "missing" ? t("checks.config.shipped.noGit") : t("checks.config.shipped.noAnswer", { command: "git rev-parse HEAD" });
    return { problem: t("checks.config.shipped.headUnknown", { process, reason }), hint: t("checks.config.shipped.otherReleaseHint") };
  }
  if (release !== head) return { problem: t("checks.config.shipped.otherRelease", { process, release: release.slice(0, 12), head: head.slice(0, 12) }), hint: t("checks.config.shipped.otherReleaseHint") };
  return { problem: null };
}

/** One problem per mount: on /app/config itself (hides all of it) or on a directory inside it (hides that part). */
function mountFindings(ctx: DoctorContext, container: RunningContainer): string[] {
  const service = container.service || container.id.slice(0, 12);
  return container.configMounts.map((m) =>
    m.destination === SHIPPED_DIR_IN_IMAGE
      ? ctx.t("checks.config.shipped.configMounted", { service, source: m.source, dir: SHIPPED_DIR_IN_IMAGE })
      : ctx.t("checks.config.shipped.configMountedInside", { service, source: m.source, destination: m.destination, dir: SHIPPED_DIR_IN_IMAGE }),
  );
}

export const shippedConfigCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    const { t } = ctx;
    const services = CONTAINER_PROCESSES.filter((process) => ctx.settings.compose_services.includes(process));
    // The mount check needs only Docker: it runs even when the database is down.
    const containers = services.length > 0 ? await loadRunningContainers(ctx) : null;
    const mountProblems = containers?.available === true ? containers.running.flatMap((c) => mountFindings(ctx, c)) : [];
    const mountHint = t("checks.config.shipped.configMountedHint");

    let reports: Awaited<ReturnType<DoctorContext["probes"]["shippedConfigReports"]>> | null = null;
    const up = await dbUp(ctx);
    // Read the receipt before the reports snapshot: a successful receipt must not be paired with an older report.
    const receipt = up && ctx.config.ai.execution === "host" ? await aiWorkerServiceReceipt(ctx) : null;
    if (up) {
      try {
        reports = await ctx.probes.shippedConfigReports();
      } catch {
        // read below as "cannot be read"
      }
    }
    if (reports === null) {
      if (mountProblems.length === 0) throw new SkipCheck(t(up ? "common.dbUnreadable" : "common.dbDown"));
      const reason = t(up ? "common.dbUnreadable" : "checks.config.shipped.noDatabase");
      return warn(spec, [...mountProblems, t("checks.config.shipped.reportsUnchecked", { reason })].join(t("common.detailSeparator")), mountHint);
    }

    const findings: Finding[] = [];
    if (containers !== null) for (const process of services) findings.push(containerFinding(ctx, process, reports[process], containers));
    if (ctx.config.ai.execution === "host") findings.push(await workerFinding(ctx, reports["ai-worker"], receipt));
    findings.sort((a, b) => SHIPPED_CONFIG_PROCESSES.indexOf(a.process) - SHIPPED_CONFIG_PROCESSES.indexOf(b.process));

    const reportProblems = findings.filter((f) => f.problem !== null).map((f) => f.problem as string);
    const problems = [...mountProblems, ...reportProblems];
    const confirmed = findings
      .filter((f) => f.problem === null)
      .map((f) => t("checks.config.shipped.item", { process: f.process, id: f.id ?? "" }))
      .join(t("common.detailSeparator"));
    if (problems.length > 0) {
      const detail = [...problems, ...(confirmed === "" ? [] : [confirmed])].join(t("common.detailSeparator"));
      // A finding with its own hint (the worker's release) needs that one; the general hint is for reports that do not match.
      const general = findings.some((f) => f.problem !== null && f.hint === undefined);
      const own = [...new Set(findings.flatMap((f) => (f.problem !== null && f.hint !== undefined ? [f.hint] : [])))];
      const hints = [...(mountProblems.length > 0 ? [mountHint] : []), ...(general ? [t("checks.config.shipped.hint")] : []), ...own];
      return warn(spec, detail, hints.join(t("common.detailSeparator")));
    }
    if (findings.length === 0) return ok(spec, t("checks.config.shipped.nothing"));
    return ok(spec, confirmed);
  },
};

export const SHIPPED_CHECKS: readonly DoctorCheck[] = [shippedConfigCheck];
