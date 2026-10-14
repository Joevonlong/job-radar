/**
 * What a deploy or a worker switch left behind on this host:
 *
 *   - `ops.releases_lock`: `data/releases/ai-worker/.lock` exists. Held by the deploy that runs this doctor (its token is
 *     in `JOB_RADAR_RELEASES_LOCK_TOKEN`): ok, no clear command. Otherwise a warning with the owner, every in-flight
 *     record and how to clear it (the same three things as the refusal of `scripts/ops/deploy.sh`). The token is never
 *     shown.
 *   - `ops.ai_worker_swap_backup`: `data/run/ai-worker-swap-backup/` exists: a worker switch failed and its rollback did
 *     not finish; `install-ai-worker.sh` refuses to run until it is resolved.
 */
import { RELEASES_PS_COMMAND, type InflightEntry } from "../../releases-lock";
import { formatDuration, joinList, ok, warn } from "../helpers";
import type { DoctorCheck, DoctorContext } from "../types";

const lockSpec = { id: "ops.releases_lock", group: "host" } as const;
const backupSpec = { id: "ops.ai_worker_swap_backup", group: "host" } as const;

function entryText(ctx: DoctorContext, entry: InflightEntry): string {
  const { t } = ctx;
  if (entry.kind === "partial") return t("checks.ops.releases_lock.partial", { name: entry.name });
  if (entry.kind === "unreadable") return t("checks.ops.releases_lock.unreadable", { name: entry.name });
  return t(entry.alive ? "checks.ops.releases_lock.recordAlive" : "checks.ops.releases_lock.recordGone", { name: entry.name, script: entry.script, pid: entry.pid });
}

export const releasesLockCheck: DoctorCheck = {
  ...lockSpec,
  async run(ctx) {
    const { t } = ctx;
    const state = await ctx.probes.releasesLock(ctx.appRoot);
    if (!state.present) return ok(lockSpec, t("checks.ops.releases_lock.none"));
    const records = state.records.length === 0 ? t("checks.ops.releases_lock.noRecords") : t("checks.ops.releases_lock.records", { list: joinList(ctx, state.records.map((e) => entryText(ctx, e))) });
    const owner = state.owner;
    const held = owner === null ? null : formatDuration(ctx, Math.max(0, Math.floor(ctx.now.getTime() / 1000) - owner.started));
    const mine = (ctx.env.JOB_RADAR_RELEASES_LOCK_TOKEN ?? "") !== "" && owner !== null && ctx.env.JOB_RADAR_RELEASES_LOCK_TOKEN === owner.token;
    if (mine && owner !== null && held !== null) {
      return ok(lockSpec, [t("checks.ops.releases_lock.current", { pid: owner.pid, host: owner.host, held }), records].join(t("common.detailSeparator")));
    }
    const who =
      owner === null || held === null
        ? t("checks.ops.releases_lock.ownerUnknown", { lock: state.lockDir })
        : t("checks.ops.releases_lock.owner", { lock: state.lockDir, pid: owner.pid, host: owner.host, held });
    return warn(lockSpec, [who, records].join(t("common.detailSeparator")), t("checks.ops.releases_lock.hint", { ps: RELEASES_PS_COMMAND, lock: state.lockDir }));
  },
};

export const swapBackupCheck: DoctorCheck = {
  ...backupSpec,
  async run(ctx) {
    const { t } = ctx;
    const runDir = `${ctx.appRoot}/data/run`;
    const names = await ctx.probes.listDir(runDir);
    if (names === null || !names.includes("ai-worker-swap-backup")) return ok(backupSpec, t("checks.ops.ai_worker_swap_backup.none"));
    const dir = `${runDir}/ai-worker-swap-backup`;
    return warn(backupSpec, t("checks.ops.ai_worker_swap_backup.found", { dir }), t("checks.ops.ai_worker_swap_backup.hint", { dir }));
  },
};

export const OPS_CHECKS: readonly DoctorCheck[] = [releasesLockCheck, swapBackupCheck];
