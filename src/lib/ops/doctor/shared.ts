/** Reads several checks share (one docker call, one database read ...), cached per doctor run. */
import { z } from "zod";

import { JOBSPY_CHANNEL_IDS } from "@/lib/channels/jobspy/channels";
import { resolveJobspyUrl } from "@/lib/channels/jobspy/client";
import { CHANNEL_CONFIG_TABLE, type ChannelConfigRef } from "@/lib/channels/registry";
import type { SourcesView } from "@/lib/sources/view";

import { cached, extractJson } from "./helpers";
import { SkipCheck, type DoctorContext } from "./types";

export function dbUp(ctx: DoctorContext): Promise<boolean> {
  return cached(ctx, "dbUp", () => ctx.probes.dbPing());
}

/** The `/sources` state; a `SkipCheck` when the database is not reachable (that is `db.connect`'s finding, not every check's). */
export async function loadSources(ctx: DoctorContext): Promise<SourcesView> {
  if (!(await dbUp(ctx))) throw new SkipCheck(ctx.t("common.dbDown"));
  return cached(ctx, "sources", () => ctx.probes.sources());
}

/** `loadSources`, but a failure is `null` (for "is it reachable some other way" questions). */
export async function tryLoadSources(ctx: DoctorContext): Promise<SourcesView | null> {
  try {
    return await loadSources(ctx);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- docker compose

const publisherSchema = z.object({ URL: z.string().optional(), TargetPort: z.number().optional(), PublishedPort: z.number().optional() });
const containerSchema = z.object({
  Service: z.string(),
  State: z.string(),
  Health: z.string().optional(),
  ExitCode: z.number().optional(),
  Publishers: z.array(publisherSchema).nullable().optional(),
  /** `key=value,key=value` (compose writes the project's working directory into one of them). */
  Labels: z.string().optional(),
});

const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir=";

export interface ComposeContainer {
  service: string;
  state: string;
  /** `healthy` / `unhealthy` / `starting`, or "" when the service has no healthcheck. */
  health: string;
  exitCode: number | null;
  /** Host addresses the published ports are bound to. */
  published: Array<{ host: string; port: number }>;
  /** The directory the project was started from (label `com.docker.compose.project.working_dir`); null when unknown. */
  workingDir: string | null;
}

export type ComposeState = { available: false; reason: string } | { available: true; containers: ComposeContainer[] };

/** `docker compose ps --format json` prints one JSON array (older compose) or one object per line (newer). */
export function parseComposePs(stdout: string): ComposeContainer[] {
  const text = stdout.trim();
  if (text === "") return [];
  let rows: unknown[];
  try {
    const parsed: unknown = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
  }
  const containers: ComposeContainer[] = [];
  for (const row of rows) {
    const parsed = containerSchema.safeParse(row);
    if (!parsed.success) continue;
    const c = parsed.data;
    containers.push({
      service: c.Service,
      state: c.State,
      health: c.Health ?? "",
      exitCode: c.ExitCode ?? null,
      published: (c.Publishers ?? []).filter((p) => (p.PublishedPort ?? 0) > 0).map((p) => ({ host: p.URL ?? "", port: p.PublishedPort ?? 0 })),
      workingDir:
        (c.Labels ?? "")
          .split(",")
          .find((label) => label.startsWith(WORKING_DIR_LABEL))
          ?.slice(WORKING_DIR_LABEL.length) || null,
    });
  }
  return containers;
}

export function loadCompose(ctx: DoctorContext): Promise<ComposeState> {
  return cached(ctx, "compose", async () => {
    const out = await ctx.probes.run("docker", ["compose", "-p", ctx.settings.compose_project, "ps", "-a", "--format", "json"]);
    if (out.kind === "missing") return { available: false, reason: ctx.t("checks.compose.noDocker") };
    if (out.kind === "timeout") return { available: false, reason: ctx.t("checks.compose.dockerTimeout") };
    if (out.exitCode !== 0) return { available: false, reason: ctx.t("checks.compose.dockerDown") };
    return { available: true, containers: parseComposePs(out.stdout) };
  });
}

// ---------------------------------------------------------------- web

export interface WebHealth {
  reachable: boolean;
  status: number | null;
  /** `/api/health` reported `db: "ok"`. */
  dbOk: boolean;
  error: string | null;
}

const healthBodySchema = z.object({ db: z.string() });

export function loadWebHealth(ctx: DoctorContext): Promise<WebHealth> {
  return cached(ctx, "web", async () => {
    const answer = await ctx.probes.http(`${ctx.settings.web_url.replace(/\/+$/, "")}/api/health`);
    let dbOk = false;
    if (answer.body !== null) {
      const body = healthBodySchema.safeParse(extractJson(answer.body));
      dbOk = body.success && body.data.db === "ok";
    }
    return { reachable: answer.status !== null, status: answer.status, dbOk, error: answer.error };
  });
}

/** The jobspy sidecar as the host reaches it (`JOBSPY_URL` or `sources.yaml: jobspy.url`); null when the setting is invalid. */
export function jobspyBaseUrl(ctx: DoctorContext): string | null {
  try {
    return resolveJobspyUrl(ctx.config.channels.jobspy, ctx.env);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tailscale

export type TailscaleState =
  | { kind: "missing" }
  | { kind: "unknown"; reason: string }
  | { kind: "stopped"; backendState: string }
  | { kind: "running"; dnsName: string | null };

const tailscaleStatusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string().optional() }).nullable().optional(),
});

export function loadTailscale(ctx: DoctorContext): Promise<TailscaleState> {
  return cached(ctx, "tailscale", async () => {
    const out = await ctx.probes.run("tailscale", ["status", "--json"]);
    if (out.kind === "missing") return { kind: "missing" };
    if (out.kind === "timeout") return { kind: "unknown", reason: ctx.t("checks.tailscale.status.noAnswer") };
    const parsed = tailscaleStatusSchema.safeParse(extractJson(out.stdout));
    if (!parsed.success) return { kind: "unknown", reason: ctx.t("checks.tailscale.status.unreadable") };
    if (parsed.data.BackendState !== "Running") return { kind: "stopped", backendState: parsed.data.BackendState };
    const dns = parsed.data.Self?.DNSName?.replace(/\.$/, "") ?? "";
    return { kind: "running", dnsName: dns === "" ? null : dns };
  });
}

/** Whether a channel that uses the jobspy sidecar is switched on (`enabled` in the effective sources.yaml). */
export function jobspyInUse(ctx: DoctorContext): boolean {
  const config = ctx.config.channels;
  return JOBSPY_CHANNEL_IDS.some((id) => {
    const ref: ChannelConfigRef = CHANNEL_CONFIG_TABLE[id];
    return (ref.section === "linkedin" ? config.linkedin[ref.key] : config.sources[ref.key]).enabled;
  });
}
