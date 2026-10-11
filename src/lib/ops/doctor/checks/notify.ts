/** Telegram configuration, the public URL, Tailscale and `tailscale serve`. Nothing here sends a message. */
import { z } from "zod";

import { loadTelegramEnv, parseAllowedUserIds } from "@/lib/env";
import { isLoopbackBind, WEB_BIND_ENV } from "@/lib/security/local-request";
import { MIN_RECOMMENDED_SCRYPT_N, plainPasswordLength, readPasswordSetting } from "@/lib/security/password";
import { sessionSecretTooShort } from "@/lib/security/session";
import { webAccessSettings } from "@/lib/security/web-access-settings";

import { extractJson, fail, joinList, ok, warn } from "../helpers";
import { loadCompose, loadTailscale } from "../shared";
import { type CheckOutcome, type DoctorCheck, type DoctorContext } from "../types";

const credentialsSpec = { id: "telegram.credentials", group: "notify" } as const;

export const telegramCredentialsCheck: DoctorCheck = {
  ...credentialsSpec,
  async run(ctx) {
    const { t } = ctx;
    // Telegram is optional: while it is switched off, missing credentials are simply "not used", not a failure
    const wanted = ctx.config.notify.telegram.enabled;
    try {
      const telegram = loadTelegramEnv(ctx.env);
      if (telegram === null) {
        return wanted
          ? fail(credentialsSpec, t("checks.telegram.credentials.none"), t("checks.telegram.credentials.noneHint"))
          : ok(credentialsSpec, t("checks.telegram.credentials.optional"));
      }
      return ok(credentialsSpec, t("checks.telegram.credentials.ok"));
    } catch (error) {
      // loadTelegramEnv only ever names the variable, never the value.
      const detail = error instanceof Error ? error.message : t("checks.telegram.credentials.invalid");
      return wanted ? fail(credentialsSpec, detail, t("checks.telegram.credentials.invalidHint")) : warn(credentialsSpec, detail, t("checks.telegram.credentials.invalidHint"));
    }
  },
};

const allowedUsersSpec = { id: "telegram.allowed_users", group: "notify" } as const;

/** in a group chat every member can press the buttons unless TELEGRAM_ALLOWED_USER_IDS limits them. Reads the environment only. */
export const telegramAllowedUsersCheck: DoctorCheck = {
  ...allowedUsersSpec,
  async run(ctx) {
    const { t } = ctx;
    let telegram: ReturnType<typeof loadTelegramEnv>;
    try {
      telegram = loadTelegramEnv(ctx.env);
    } catch {
      return ok(allowedUsersSpec, t("checks.telegram.credentials.invalid")); // telegram.credentials reports the problem
    }
    if (telegram === null) return ok(allowedUsersSpec, t("checks.telegram.credentials.none"));
    const allowed = parseAllowedUserIds(telegram.TELEGRAM_ALLOWED_USER_IDS);
    if (allowed !== null) return ok(allowedUsersSpec, t("checks.telegram.allowed_users.ok", { count: allowed.length }));
    if (telegram.TELEGRAM_CHAT_ID.startsWith("-")) return warn(allowedUsersSpec, t("checks.telegram.allowed_users.group"), t("checks.telegram.allowed_users.groupHint"));
    return ok(allowedUsersSpec, t("checks.telegram.allowed_users.private"));
  },
};

const enabledSpec = { id: "telegram.enabled", group: "notify" } as const;

export const telegramEnabledCheck: DoctorCheck = {
  ...enabledSpec,
  async run(ctx) {
    if (ctx.config.notify.telegram.enabled) return ok(enabledSpec, "telegram.enabled: true");
    // Off is a valid choice. Only credentials that are already in .env make an off switch worth a note.
    let configured = false;
    try {
      configured = loadTelegramEnv(ctx.env) !== null;
    } catch {
      configured = true;
    }
    return configured ? warn(enabledSpec, ctx.t("checks.telegram.enabled.offConfigured"), ctx.t("checks.telegram.enabled.offHint")) : ok(enabledSpec, ctx.t("checks.telegram.enabled.optional"));
  },
};

const publicSpec = { id: "network.public_url", group: "network" } as const;

export const publicUrlCheck: DoctorCheck = {
  ...publicSpec,
  async run(ctx) {
    const { t } = ctx;
    const base = ctx.config.notify.public_base_url;
    if (base === null) return warn(publicSpec, t("checks.network.public_url.unset"), t("checks.network.public_url.unsetHint"));
    const url = `${base.replace(/\/+$/, "")}/api/health`;
    const answer = await ctx.probes.http(url);
    if (answer.ok) return ok(publicSpec, `GET ${url} → ${answer.status}`);
    return fail(
      publicSpec,
      answer.status === null ? t("checks.network.public_url.noAnswer", { url, error: answer.error ?? "unknown" }) : `GET ${url} → ${answer.status}`,
      t("checks.network.public_url.failHint"),
    );
  },
};

const statusSpec = { id: "tailscale.status", group: "network" } as const;

export const tailscaleStatusCheck: DoctorCheck = {
  ...statusSpec,
  async run(ctx) {
    const { t } = ctx;
    const state = await loadTailscale(ctx);
    if (state.kind === "missing") return warn(statusSpec, t("checks.tailscale.status.missing"), t("checks.tailscale.status.missingHint"));
    if (state.kind === "unknown") return warn(statusSpec, state.reason, t("checks.tailscale.status.unknownHint"));
    if (state.kind === "stopped") return warn(statusSpec, t("checks.tailscale.status.stopped", { state: state.backendState }), t("checks.tailscale.status.stoppedHint"));
    return ok(statusSpec, state.dnsName === null ? t("checks.tailscale.status.connected") : t("checks.tailscale.status.connectedAs", { name: state.dnsName }));
  },
};

const serveSpec = { id: "tailscale.serve", group: "network" } as const;

const serveStatusSchema = z.object({
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional() })).optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
});

function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
  } catch {
    return "";
  }
}

/** The proxy targets of `tailscale serve`; null when Tailscale does not run or the status cannot be read. */
async function serveProxies(ctx: DoctorContext): Promise<string[] | null> {
  const state = await loadTailscale(ctx);
  if (state.kind !== "running") return null;
  const out = await ctx.probes.run("tailscale", ["serve", "status", "--json"]);
  if (out.kind !== "ran" || out.exitCode !== 0) return null;
  const parsed = serveStatusSchema.safeParse(extractJson(out.stdout) ?? {});
  if (!parsed.success) return null;
  const proxies: string[] = [];
  for (const site of Object.values(parsed.data.Web ?? {})) {
    for (const handler of Object.values(site.Handlers ?? {})) if (handler.Proxy !== undefined) proxies.push(handler.Proxy);
  }
  return proxies;
}

const webAccessSpec = { id: "web.access", group: "network" } as const;

/**
 * A password, no `JOB_RADAR_WEB_BIND` in `.env`, and no web container: the web runs by hand (`pnpm start`, `pnpm dev`),
 * listens on every interface, and so asks for the password on this machine too. Compose publishes on 127.0.0.1 without
 * the variable, so a running web container is fine.
 */
async function outsideCompose(ctx: DoctorContext, outcome: CheckOutcome): Promise<CheckOutcome> {
  if (outcome.status !== "ok" || (ctx.env[WEB_BIND_ENV] ?? "").trim() !== "") return outcome;
  const compose = await loadCompose(ctx);
  if (compose.available && compose.containers.some((c) => c.service === "web" && c.state === "running")) return outcome;
  return warn(webAccessSpec, ctx.t("checks.web.access.hostNoBind"), ctx.t("checks.web.access.hostNoBindHint"));
}

/**
 * The optional web password: set as a hash (✅), as plain text (⚠️, also when shorter than `min_password_length`), as a
 * hash that cannot be read (❌: nobody can sign in), or not at all: fine while the web listens on loopback only and
 * `tailscale serve` does not forward to it, ⚠️ otherwise.
 */
export const webAccessCheck: DoctorCheck = {
  ...webAccessSpec,
  async run(ctx) {
    const { t } = ctx;
    const setting = readPasswordSetting(ctx.env);
    // an unusable JOB_RADAR_SESSION_SECRET is only worth a word when nothing else is wrong
    const first = (outcome: CheckOutcome): CheckOutcome =>
      outcome.status === "ok" && sessionSecretTooShort(ctx.env) ? warn(webAccessSpec, t("checks.web.access.secretShort"), t("checks.web.access.secretShortHint")) : outcome;
    if (setting !== null) {
      if (setting.kind === "hash") {
        if (setting.parsed === null) return first(fail(webAccessSpec, t("checks.web.access.hashInvalid"), t("checks.web.access.hashInvalidHint")));
        if (setting.parsed.N < MIN_RECOMMENDED_SCRYPT_N) {
          return warn(webAccessSpec, t("checks.web.access.weakHash", { n: setting.parsed.N, min: MIN_RECOMMENDED_SCRYPT_N }), t("checks.web.access.weakHashHint"));
        }
        return first(await outsideCompose(ctx, ok(webAccessSpec, t("checks.web.access.hash"))));
      }
      const min = webAccessSettings().min_password_length;
      const length = plainPasswordLength(setting) ?? 0;
      if (length < min) return first(warn(webAccessSpec, t("checks.web.access.short", { length, min }), t("checks.web.access.shortHint")));
      return first(warn(webAccessSpec, t("checks.web.access.plain"), t("checks.web.access.plainHint")));
    }
    const how: string[] = [];
    const bind = (ctx.env[WEB_BIND_ENV] ?? "").trim();
    if (!isLoopbackBind(bind)) how.push(t("checks.web.access.exposedBind", { bind }));
    const port = portOf(ctx.settings.web_url);
    const proxies = await serveProxies(ctx);
    if (proxies !== null && proxies.some((proxy) => portOf(proxy) === port)) how.push(t("checks.web.access.exposedServe", { port }));
    if (how.length > 0) return first(warn(webAccessSpec, t("checks.web.access.noneExposed", { how: joinList(ctx, how) }), t("checks.web.access.noneExposedHint")));
    return first(ok(webAccessSpec, t("checks.web.access.noneLocal")));
  },
};

export const tailscaleServeCheck: DoctorCheck = {
  ...serveSpec,
  async run(ctx) {
    const { t } = ctx;
    const state = await loadTailscale(ctx);
    if (state.kind !== "running") return warn(serveSpec, t("checks.tailscale.serve.notRunning"), t("checks.tailscale.serve.notRunningHint"));
    const out = await ctx.probes.run("tailscale", ["serve", "status", "--json"]);
    if (out.kind !== "ran" || out.exitCode !== 0) return warn(serveSpec, t("checks.tailscale.serve.noResult"), t("checks.tailscale.serve.manualHint"));
    const parsed = serveStatusSchema.safeParse(extractJson(out.stdout) ?? {});
    if (!parsed.success) return warn(serveSpec, t("checks.tailscale.serve.unreadable"), t("checks.tailscale.serve.manualHint"));
    const funnel = Object.entries(parsed.data.AllowFunnel ?? {}).filter(([, on]) => on).map(([host]) => host);
    const port = portOf(ctx.settings.web_url);
    if (funnel.length > 0) return fail(serveSpec, t("checks.tailscale.serve.funnel", { hosts: joinList(ctx, funnel) }), t("checks.tailscale.serve.funnelHint", { port }));
    const proxies: string[] = [];
    for (const site of Object.values(parsed.data.Web ?? {})) {
      for (const handler of Object.values(site.Handlers ?? {})) if (handler.Proxy !== undefined) proxies.push(handler.Proxy);
    }
    if (proxies.length === 0) return warn(serveSpec, t("checks.tailscale.serve.none"), t("checks.tailscale.serve.noneHint", { port }));
    if (!proxies.some((proxy) => portOf(proxy) === port)) {
      return warn(serveSpec, t("checks.tailscale.serve.wrongPort", { targets: joinList(ctx, proxies), port }), t("checks.tailscale.serve.wrongPortHint", { port }));
    }
    return ok(serveSpec, t("checks.tailscale.serve.ok", { port }));
  },
};

export const NETWORK_CHECKS: readonly DoctorCheck[] = [publicUrlCheck, tailscaleStatusCheck, tailscaleServeCheck, webAccessCheck];
export const NOTIFY_CHECKS: readonly DoctorCheck[] = [telegramCredentialsCheck, telegramAllowedUsersCheck, telegramEnabledCheck];
