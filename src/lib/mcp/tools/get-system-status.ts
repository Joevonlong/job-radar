import { z } from "zod";
import { loadConfig } from "@/lib/config";
import { getDbNow, isCycleRunning } from "@/lib/db";
import { countPendingOpsRequests } from "@/lib/db/queries/ops";
import { loadAiWorkerStatus } from "@/lib/ops/ai-worker";
import { loadDiskStatus } from "@/lib/ops/disk";
import { runDoctor } from "@/lib/ops/doctor/run";
import { loadControlStatus } from "@/lib/settings/status";
import type { McpContext } from "../context";
import { systemStatusOutput, toDoctorDto } from "../dto/ops";

export const getSystemStatusInput = () => z.strictObject({});

export async function getSystemStatus(ctx: McpContext) {
  const now = await getDbNow(ctx.db);
  const doctor = async () => {
    const { createRealContext } = await import("@/lib/ops/doctor/probes");
    return runDoctor(await createRealContext(process.env, { lang: ctx.text.locale }));
  };
  const [report, control, worker, cycleRunning, pending, disk] = await Promise.all([
    (ctx.ops?.doctor ?? doctor)(), loadControlStatus(ctx.db, now), loadAiWorkerStatus(ctx.db, { now, aiConfig: loadConfig("ai") }),
    isCycleRunning(ctx.db), countPendingOpsRequests(ctx.db), loadDiskStatus(ctx.db, now),
  ]);
  return systemStatusOutput.parse({ notices: [], doctor: toDoctorDto(report, ctx.text), runner_online: control.heartbeat.online, ai_worker_online: worker.online, cycle_running: cycleRunning, pending_requests: pending, disk: disk?.level ?? null });
}
