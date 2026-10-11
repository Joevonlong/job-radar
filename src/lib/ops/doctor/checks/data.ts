/** Backups, free disk space and the host's power settings. */
import path from "node:path";

import { trapsTranslator } from "@/lib/traps/text";

import { diskLevel, internalDataPath, volumeLabel } from "../../disk";
import type { DockerDataLocation } from "../../docker-data";
import { ageSeconds, cached, fail, formatAgo, formatBytes, ok, warn } from "../helpers";
import { SkipCheck, type CheckOutcome, type DoctorCheck, type DoctorContext } from "../types";

const backupSpec = { id: "backup.recent", group: "data" } as const;

export const backupCheck: DoctorCheck = {
  ...backupSpec,
  async run(ctx) {
    const { t } = ctx;
    const { backup } = ctx.config.schedule;
    if (!backup.enabled) return warn(backupSpec, t("checks.backup.recent.disabled"), t("checks.backup.recent.disabledHint"));
    const files = await ctx.probes.backups(ctx.backupDir);
    if (files === null) return fail(backupSpec, t("checks.backup.recent.noDir", { dir: ctx.backupDir }), t("checks.backup.recent.noDirHint"));
    const newest = files[0];
    if (newest === undefined) return warn(backupSpec, t("checks.backup.recent.none", { dir: ctx.backupDir, cron: backup.cron }), t("checks.backup.recent.noneHint"));
    const age = ageSeconds(newest.modifiedAt, ctx.now);
    const limitSeconds = backup.max_age_hours * 3600;
    if (age > limitSeconds) {
      return fail(backupSpec, t("checks.backup.recent.old", { ago: formatAgo(ctx, age), name: newest.name, hours: backup.max_age_hours }), t("checks.backup.recent.oldHint"));
    }
    if (backup.config_archive && !newest.hasConfig) {
      return warn(backupSpec, t("checks.backup.recent.noConfig", { name: newest.name }), t("checks.backup.recent.noConfigHint"));
    }
    return ok(backupSpec, t("checks.backup.recent.ok", { name: newest.name, size: formatBytes(newest.bytes), ago: formatAgo(ctx, age), count: files.length }));
  },
};

interface DiskTarget {
  id: string;
  /** Set for a result whose id has no title of its own in the messages. */
  title?: string;
  target: string;
  /** What breaks when this volume fills up. */
  consequence: string;
  thresholds: { min_free_disk_gb: number; warn_free_disk_gb: number };
  /** Name the measured path in the detail (the backups path is already in `backup.recent`). */
  showPath: boolean;
  cleanup: { fail: string; warn: string };
}

async function diskResult(ctx: DoctorContext, input: DiskTarget): Promise<CheckOutcome> {
  const { t } = ctx;
  const spec = { id: input.id, group: "data", ...(input.title === undefined ? {} : { title: input.title }) } as const;
  const space = await ctx.probes.disk(input.target);
  if (space === null) return warn(spec, t("checks.disk.unreadable", { path: input.target }), t("checks.disk.unreadableHint"));
  const freeGb = space.freeBytes / 1024 ** 3;
  const percent = space.totalBytes > 0 ? Math.round((space.freeBytes / space.totalBytes) * 100) : 0;
  const gb = freeGb.toFixed(1);
  const detail = input.showPath ? t("checks.disk.freeAt", { gb, percent, path: input.target }) : t("checks.disk.freeSpace", { gb, percent });
  const level = diskLevel(space.freeBytes, input.thresholds);
  if (level === "fail") return fail(spec, t("checks.disk.belowMin", { detail, min: input.thresholds.min_free_disk_gb, consequence: input.consequence }), input.cleanup.fail);
  if (level === "warn") return warn(spec, t("checks.disk.belowWarn", { detail, warn: input.thresholds.warn_free_disk_gb }), input.cleanup.warn);
  return ok(spec, detail);
}

const dockerData = (ctx: DoctorContext): Promise<DockerDataLocation> => cached(ctx, "docker-data", () => ctx.probes.dockerData());

/** Where the space goes on the volume with the backups, Docker's data and the ai-worker logs (all on the project volume once the log-dir option is in place). */
function projectCleanup(ctx: DoctorContext): { fail: string; warn: string } {
  const logs = path.join(ctx.appRoot, "data", "logs");
  return { fail: ctx.t("checks.disk.cleanupFail", { logs }), warn: ctx.t("checks.disk.cleanupWarn", { logs }) };
}

export const diskCheck: DoctorCheck = {
  id: "disk.free",
  group: "data",
  async run(ctx) {
    const { t } = ctx;
    const cleanup = projectCleanup(ctx);
    const backups = await diskResult(ctx, { id: "disk.backups", target: ctx.backupDir, consequence: t("checks.disk.backups.consequence"), thresholds: ctx.settings, showPath: false, cleanup });
    const docker = await dockerData(ctx);
    if (path.resolve(docker.path) === path.resolve(ctx.backupDir)) return [backups];
    const dockerResult = await diskResult(ctx, { id: "disk.docker", target: docker.path, consequence: t("checks.disk.docker.consequence"), thresholds: ctx.settings, showPath: true, cleanup });
    return [backups, dockerResult];
  },
};

const dockerLocationSpec = { id: "disk.docker_location", group: "data" } as const;

/** Docker Desktop's disk image (database, images, build cache) belongs on the project volume, not on the nearly full internal disk. */
export const dockerLocationCheck: DoctorCheck = {
  ...dockerLocationSpec,
  async run(ctx) {
    const { t } = ctx;
    if (ctx.platform !== "darwin") return ok(dockerLocationSpec, t("common.notMacos"));
    const docker = await dockerData(ctx);
    const volume = volumeLabel(ctx.appRoot);
    const same = await ctx.probes.sameVolume(docker.path, ctx.appRoot);
    const where = `${docker.path}${docker.source === "default" ? t("checks.disk.docker_location.defaultLocation") : ""}`;
    // The ai-worker (launchd) must not read Docker's settings itself; tell the operator which path to pin in ai.yaml.
    const configured = ctx.config.ai.host_worker.docker_data_path;
    const pinHint =
      configured === undefined && (docker.source === "settings-store" || docker.source === "settings")
        ? t("checks.disk.docker_location.pinHint", { path: docker.path })
        : configured !== undefined && path.resolve(configured) !== path.resolve(docker.path)
          ? t("checks.disk.docker_location.mismatchHint", { configured, path: docker.path })
          : undefined;
    if (same === null) return warn(dockerLocationSpec, t("checks.disk.docker_location.unreadable", { docker: docker.path, app: ctx.appRoot }), t("checks.disk.docker_location.unreadableHint"));
    if (same) return { ...ok(dockerLocationSpec, t("checks.disk.docker_location.same", { where, volume })), ...(pinHint === undefined ? {} : { hint: pinHint }) };
    return warn(dockerLocationSpec, t("checks.disk.docker_location.other", { where, volume }), t("checks.disk.docker_location.otherHint", { guide: ctx.settings.storage_guide }));
  },
};

/** The Mac's own disk; when it fills up, macOS, Docker Desktop and launchd's logs all get into trouble. */
export const internalDiskCheck: DoctorCheck = {
  id: "disk.internal",
  group: "data",
  async run(ctx) {
    const { t } = ctx;
    const { internal_min_free_disk_gb: min, internal_warn_free_disk_gb: warnAt, storage_guide: guide } = ctx.settings;
    return diskResult(ctx, {
      id: "disk.internal",
      target: internalDataPath(ctx.platform),
      consequence: t("checks.disk.internal.consequence"),
      thresholds: { min_free_disk_gb: min, warn_free_disk_gb: warnAt },
      showPath: true,
      cleanup: { fail: t("checks.disk.internal.cleanupFail", { guide }), warn: t("checks.disk.internal.cleanupWarn", { guide }) },
    });
  },
};

const powerSpec = { id: "host.power", group: "host" } as const;

export function parsePmset(stdout: string): { autorestart: number | null; sleep: number | null } {
  const value = (name: string): number | null => {
    const match = new RegExp(`^\\s*${name}\\s+(\\d+)`, "m").exec(stdout);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  return { autorestart: value("autorestart"), sleep: value("sleep") };
}

export const powerCheck: DoctorCheck = {
  ...powerSpec,
  async run(ctx) {
    const { t } = ctx;
    if (ctx.platform !== "darwin") return ok(powerSpec, t("common.notMacos"));
    const out = await ctx.probes.run("pmset", ["-g"]);
    if (out.kind !== "ran" || out.exitCode !== 0) return warn(powerSpec, t("checks.host.power.noResult"), t("checks.host.power.noResultHint"));
    const { autorestart, sleep } = parsePmset(out.stdout);
    const problems: string[] = [];
    if (autorestart !== 1) problems.push(t("checks.host.power.autorestart", { value: autorestart === null ? t("checks.host.power.notSet") : String(autorestart) }));
    if (sleep !== 0) problems.push(t("checks.host.power.sleep", { value: sleep === null ? t("checks.host.power.notSet") : String(sleep) }));
    if (problems.length > 0) return warn(powerSpec, problems.join(t("common.detailSeparator")), t("checks.host.power.problemsHint"));
    return ok(powerSpec, t("checks.host.power.ok"));
  },
};

// ---------------------------------------------------------------- AI traps

/** How many jobs carry AI traps (all / recent) and how many wait for their first scan; warns when that backlog is large. */
export const trapsCheck: DoctorCheck = {
  id: "data.traps",
  group: "data",
  async run(ctx) {
    const trapText = trapsTranslator(ctx.locale);
    const trapsSpec = { id: "data.traps", group: "data" } as const;
    let probe;
    try {
      probe = await ctx.probes.traps(ctx.now);
    } catch {
      throw new SkipCheck(ctx.t("common.dbUnreadable"));
    }
    if (probe.state === "config_error") return warn(trapsSpec, trapText("doctor.configError", { problem: probe.problem }), trapText("doctor.configHint"));
    if (!probe.enabled) return warn(trapsSpec, trapText("doctor.disabled"), trapText("doctor.disabledHint"));
    if (probe.stats === null) return warn(trapsSpec, trapText("doctor.noTables"), trapText("doctor.noTablesHint"));
    const { jobsWithTraps, recentJobsWithTraps, backlog } = probe.stats;
    const detail = trapText("doctor.detail", { withTraps: jobsWithTraps, recent: recentJobsWithTraps, days: probe.recentDays, backlog });
    if (backlog > probe.backlogWarn) return warn(trapsSpec, `${detail} · ${trapText("doctor.backlog", { backlog, limit: probe.backlogWarn })}`, trapText("doctor.backlogHint"));
    return ok(trapsSpec, detail);
  },
};

// ---------------------------------------------------------------- file ownership on Linux

const ownershipSpec = { id: "data.ownership", group: "data" } as const;
/** Paths named in the detail. */
const OWNERSHIP_SAMPLE = 3;
/** Entries walked at most (data/ holds logs, exports and backups; the check must stay quick). */
const OWNERSHIP_MAX_ENTRIES = 20_000;

/** The uid the containers run as (compose `user: ${PUID:-1000}`); null when PUID is not a number. */
function containerUid(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = (env.PUID ?? "").trim();
  if (raw === "") return 1000;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * Linux only: the containers run as PUID:PGID and write data/ and .auth/ on the host as that user. Files owned by
 * another uid (left by an older version that ran as root, or by a `sudo` command) cannot be written and break the web,
 * the runner or a LinkedIn sign-in. macOS (Docker Desktop maps ownership) is skipped.
 */
export const ownershipCheck: DoctorCheck = {
  ...ownershipSpec,
  async run(ctx) {
    const { t } = ctx;
    if (ctx.platform !== "linux") return ok(ownershipSpec, t("checks.data.ownership.notLinux"));
    const uid = containerUid(ctx.env);
    if (uid === null) return warn(ownershipSpec, t("checks.data.ownership.badPuid", { value: ctx.env.PUID ?? "" }), t("checks.data.ownership.badPuidHint"));
    const roots = [path.join(ctx.appRoot, "data"), path.join(ctx.appRoot, ".auth")];
    const scan = await ctx.probes.foreignOwned(roots, uid, { sample: OWNERSHIP_SAMPLE, maxEntries: OWNERSHIP_MAX_ENTRIES });
    const gid = (ctx.env.PGID ?? "").trim() || "1000";
    if (scan.foreign > 0) {
      const examples = scan.sample.map((entry) => path.relative(ctx.appRoot, entry) || entry).join(", ");
      return warn(ownershipSpec, t("checks.data.ownership.foreign", { count: scan.foreign, uid, examples }), t("checks.data.ownership.foreignHint", { uid, gid }));
    }
    return ok(ownershipSpec, t("checks.data.ownership.ok", { uid, count: scan.scanned }));
  },
};

export const DATA_CHECKS: readonly DoctorCheck[] = [backupCheck, diskCheck, dockerLocationCheck, internalDiskCheck, trapsCheck, ownershipCheck];
export const HOST_CHECKS: readonly DoctorCheck[] = [powerCheck];
