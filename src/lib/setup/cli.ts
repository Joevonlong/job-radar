/**
 * `pnpm run setup` (host side; scripts/setup.ts is the thin entry). The same eight steps as the web wizard, through
 * the same step services, so both write the same files. Modes: interactive (`node:readline`), `--answers <file.yaml>`
 * (unattended), `--step <id>` (one step), `--status [--json]`, `--complete`. Prints environment variables by name with
 * set / not set only; no value is ever read into the output (C4). The one exception to "the setup never touches .env" is
 * the interactive Telegram step (telegram-setup.ts): it writes the three Telegram keys, then restarts what reads them
 * (`--no-restart` only prints the commands).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { ensureConfigFiles, ensureProfileFiles, loadConfig } from "@/lib/config";
import { listPackIds } from "@/lib/market";
import { CONTRACT_OPTIONS, SENIORITY_OPTIONS, WORKPLACE_OPTIONS } from "@/lib/profile/draft";
import { AI_PROVIDER_IDS, AI_PROVIDER_KINDS } from "@/lib/config/ai-options";
import { LOCALES } from "@/i18n/locale";
import { closeDb, getDb, pingDb } from "@/lib/db";
import { underVitest } from "@/lib/db/test-guard";
import { requestRunCycle } from "@/lib/control/service";
import { resolveHostDatabaseUrl } from "@/lib/ops/doctor/database-url";
import { aiWorkerLaunchdLabel } from "@/lib/ops/ai-worker-label";
import { AI_WORKER_SYSTEMD_UNIT } from "@/lib/ops/doctor/checks/ai";
import { resolveComposeProject, runCommand } from "@/lib/ops/doctor/probes";
import { createServiceControl, type ServiceControl } from "@/lib/ops/services";
import type { TelegramFetch } from "@/lib/notify/telegram-client";
import type { Locale } from "@/i18n/locale";

import { aiInputOf, languageInputOf, marketInputOf, parseAnswers, profileInputOf, sourcesInputOf, targetsInputOf, telegramInputOf, type SetupAnswers } from "./answers";
import { claudeLoginState, codexLoginState } from "./cli-login";
import { planKeywordGroups } from "./keywords";
import { completeSetup, readSetupState } from "./state";
import { isSetupStepId, SETUP_STEP_IDS, type SetupStepId } from "./steps";
import { saveAiStep } from "./steps/ai";
import { saveLanguageStep } from "./steps/language";
import { saveMarketStep } from "./steps/market";
import { saveProfileStep } from "./steps/profile";
import { finishSetup, skipSetupStep } from "./steps/review";
import { saveSourcesStep } from "./steps/sources";
import { saveTargetsStep } from "./steps/targets";
import { saveTelegramStep } from "./steps/telegram";
import { readinessParams } from "./readiness";
import { withInterruptsHeld } from "./interrupt-guard";
import { runTelegramSetup, TELEGRAM_KEYS, type DoctorLine } from "./telegram-setup";
import { cliLocale, profileErrorsTranslator, profileFieldsTranslator, setupTranslator, type SetupTranslator } from "./text";
import type { SetupStepResult } from "./types";
import { heartbeats, loadSetupView, readinessOf, type SetupView } from "./view";
import type { CliIo } from "./cli-io";

export type { CliIo } from "./cli-io";

/** What tests replace: the Bot API, Docker / launchd / systemd, the doctor, the `.env` path, the clock. */
export interface CliDeps {
  telegram?: {
    fetch?: TelegramFetch;
    /** null: nothing can be restarted from here. */
    services?: ServiceControl | null;
    doctor?: () => Promise<DoctorLine[] | null>;
    envFile?: string;
    now?: () => Date;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

interface Context {
  io: CliIo;
  t: SetupTranslator;
  tProfile: ReturnType<typeof profileErrorsTranslator>;
  tFields: ReturnType<typeof profileFieldsTranslator>;
  db: boolean;
  locale: Locale;
  env: NodeJS.ProcessEnv;
  restart: boolean;
  deps: CliDeps;
}

const DB_PING_MS = 4000;

/** Whether the database answers (within a few seconds); the host uses the compose-style variables when DATABASE_URL is not set. */
async function databaseAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  // Never the compose default under Vitest (a test without DATABASE_URL has no database)
  if ((env.DATABASE_URL ?? "").trim() === "" && !underVitest(env)) env.DATABASE_URL = resolveHostDatabaseUrl(env);
  try {
    return await Promise.race([pingDb(getDb()), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DB_PING_MS))]);
  } catch {
    return false;
  }
}

function printResult(ctx: Context, result: SetupStepResult): boolean {
  if (result.status === "saved") {
    ctx.io.out(ctx.t("cli.saved"));
    return true;
  }
  if (result.status === "skipped") {
    ctx.io.out(ctx.t("cli.skipped"));
    return true;
  }
  ctx.io.err(ctx.t("cli.notSaved"));
  if (result.formError !== null) ctx.io.err(`  ${ctx.t(`formErrors.${result.formError}`)}`);
  for (const error of result.fieldErrors) {
    const message = error.ns === "profile" ? ctx.tProfile(error.key, { min: 0, max: 0, message: "", ...error.params }) : ctx.t(`errors.${error.key}`, { message: "", model: "", ...error.params });
    ctx.io.err(ctx.t("cli.fieldError", { path: error.path, message }));
  }
  return false;
}

// ---------------------------------------------------------------- status

async function statusReport(ctx: Context): Promise<{ text: string[]; json: unknown }> {
  const status = readSetupState();
  const ai = (() => {
    try {
      return loadConfig("ai");
    } catch {
      return null;
    }
  })();
  const channels = (() => {
    try {
      return loadConfig("channels");
    } catch {
      return null;
    }
  })();
  const beats = ctx.db ? await heartbeats(ai) : { runnerOnline: null, worker: null };
  const readiness = readinessOf({ channels, ai, heartbeats: beats });
  const steps = Object.fromEntries(SETUP_STEP_IDS.map((id) => [id, status.state?.steps[id]?.status ?? null]));
  const { t } = ctx;
  const stateLine =
    status.error !== null
      ? t("cli.state.invalid", { error: status.error })
      : status.pending
        ? t("cli.state.pending")
        : status.source === "existing_install"
          ? t("cli.state.existing")
          : status.state === null
            ? t("cli.state.missing")
            : t("cli.state.completed", { at: status.state.completed_at ?? "", by: status.state.completed_by === null ? "" : t(`cli.by.${status.state.completed_by}`) });
  const text = [
    t("cli.title"),
    stateLine,
    ...SETUP_STEP_IDS.map((id, index) => t("cli.stepLine", { index: index + 1, name: t(`steps.${id}.name`), state: t(`cli.stepState.${steps[id] ?? "open"}`) })),
    t("cli.readinessTitle"),
    ...readiness.map((item) => t("cli.readinessLine", { status: t(`review.statusLabel.${item.status}`), text: t(`review.readiness.${item.id}`, readinessParams(item, (field) => ctx.tFields(`fields.${field}`), ctx.tFields("separator"))) })),
  ];
  const json = {
    pending: status.pending,
    completed_at: status.state?.completed_at ?? null,
    completed_by: status.state?.completed_by ?? null,
    source: status.source,
    error: status.error,
    steps,
    readiness: readiness.map((item) => ({ id: item.id, status: item.status, params: item.params, ...(item.fields ? { fields: item.fields } : {}) })),
  };
  return { text, json };
}

// ---------------------------------------------------------------- the steps

type StepRun = (ctx: Context, view: SetupView, answers: SetupAnswers) => Promise<SetupStepResult>;

const split = (line: string): string[] =>
  line
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** Run one step from the answers: its section is saved, a missing section is skipped. */
const FROM_ANSWERS: Record<Exclude<SetupStepId, "review">, StepRun> = {
  language: async (_ctx, _view, a) => (a.language ? saveLanguageStep(languageInputOf(a.language)) : skipSetupStep("language")),
  market: async (_ctx, view, a) => (a.market && view.market.draft ? saveMarketStep(marketInputOf(a.market, view.market.draft)) : a.market ? { status: "error", step: "market", fieldErrors: [], formError: "profileUnreadable" } : skipSetupStep("market")),
  profile: async (_ctx, view, a) => (a.profile && view.profile.draft ? saveProfileStep(profileInputOf(a.profile, view.profile.draft)) : a.profile ? { status: "error", step: "profile", fieldErrors: [], formError: "profileUnreadable" } : skipSetupStep("profile")),
  targets: async (_ctx, view, a) => (a.targets && view.targets.draft ? saveTargetsStep(targetsInputOf(a.targets, view.targets.draft)) : a.targets ? { status: "error", step: "targets", fieldErrors: [], formError: "profileUnreadable" } : skipSetupStep("targets")),
  sources: async (_ctx, _view, a) => (a.sources ? saveSourcesStep(sourcesInputOf(a.sources)) : skipSetupStep("sources")),
  ai: async (_ctx, _view, a) => (a.ai ? saveAiStep(aiInputOf(a.ai)) : skipSetupStep("ai")),
  telegram: async (_ctx, _view, a) => (a.telegram ? saveTelegramStep(telegramInputOf(a.telegram)) : skipSetupStep("telegram")),
};

async function freshView(): Promise<SetupView> {
  return loadSetupView({ locale: cliLocale(), acceptLanguage: null });
}

/** Ask with the current value as default (Enter keeps it). */
async function ask(ctx: Context, question: string, current: string): Promise<string> {
  const answer = await ctx.io.ask(`${question} ${ctx.t("cli.keep", { value: current === "" ? ctx.t("cli.values.empty") : current })}: `);
  if (answer === null) throw new EndOfInput();
  return answer.trim() === "" ? current : answer.trim();
}

async function askYes(ctx: Context, question: string, current: boolean): Promise<boolean> {
  const answer = await ask(ctx, question, current ? ctx.t("cli.yes") : ctx.t("cli.no"));
  return answer.toLowerCase().startsWith(ctx.t("cli.yes").toLowerCase());
}

class EndOfInput extends Error {
  constructor() {
    super("end of input");
    this.name = "EndOfInput";
  }
}

/** Interactive questions of each step -> the answers section the converters take. */
/** (The Telegram step has a flow of its own: `telegramStep`.) */
async function interview(ctx: Context, step: Exclude<SetupStepId, "review" | "telegram">, view: SetupView): Promise<SetupAnswers> {
  const { t } = ctx;
  const p = (key: Parameters<SetupTranslator>[0], values?: Record<string, string>): string => t(key, values as never);
  switch (step) {
    case "language": {
      const ui = await ask(ctx, p("cli.prompts.uiLocale", { options: LOCALES.join(", ") }), view.language.current);
      if (!view.language.fileAvailable) return parseOrThrow({ language: { ui_locale: ui } });
      const aiOutput = await ask(ctx, p("language.aiOutput"), view.language.aiOutput);
      const target = await ask(ctx, p("language.translation"), view.language.translationTarget);
      return parseOrThrow({ language: { ui_locale: ui, ai_output: aiOutput, translation_target: target } });
    }
    case "market": {
      const d = view.market.draft;
      if (d === null) return parseOrThrow({ market: { pack: "" } });
      const pack = await ask(ctx, p("cli.prompts.pack", { options: listPackIds().join(", ") }), d.market.pack);
      const country = await ask(ctx, p("cli.prompts.country"), pack === d.market.pack ? d.market.country : "");
      const currency = await ask(ctx, p("cli.prompts.currency"), pack === d.market.pack ? d.market.currency : "");
      const language = await ask(ctx, p("cli.prompts.homeLanguage"), pack === d.market.pack ? d.market.home_language : "");
      const locations = split(await ask(ctx, p("cli.prompts.locations"), d.locations.join(", ")));
      const scope = await ask(ctx, p("cli.prompts.remoteScope"), d.remote_scope);
      // like the web wizard (browser zone): until the step is done, suggest this computer's zone, not the shipped placeholder
      const hostZone = view.steps.market.status === null ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
      const timezone = await ask(ctx, p("cli.prompts.timezone"), hostZone !== undefined && hostZone !== "" ? hostZone : d.timezone);
      const remote = scope.startsWith("region:") ? { region: split(scope.slice("region:".length)) } : scope;
      return parseOrThrow({ market: { pack, country, currency, home_language: language, locations, remote_scope: remote, timezone } });
    }
    case "profile": {
      const d = view.profile.draft;
      if (d === null) return parseOrThrow({ profile: {} });
      const summary = await ask(ctx, p("cli.prompts.summary"), d.summary.replace(/\s+/g, " ").trim());
      const skills = split(await ask(ctx, p("cli.prompts.skills"), d.skills.map((s) => (s.years === "" ? s.name : `${s.name}:${s.years}`)).join(", "))).map((entry) => {
        const [name = "", years] = entry.split(":").map((x) => x.trim());
        const n = years === undefined || years === "" ? null : Number(years);
        return { name, years: n !== null && Number.isFinite(n) ? n : null };
      });
      const languages = Object.fromEntries(
        split(await ask(ctx, p("cli.prompts.languages"), d.languages.map((l) => `${l.code}:${l.level}`).join(", "))).map((entry) => {
          const [code = "", level = ""] = entry.split(":").map((x) => x.trim());
          return [code.toLowerCase(), level === "native" ? "native" : level.toUpperCase()];
        }),
      );
      const yearsText = await ask(ctx, p("cli.prompts.years"), d.years_experience);
      const city = await ask(ctx, p("cli.prompts.city"), d.city);
      const visa = await askYes(ctx, p("cli.prompts.visa"), d.needs_visa_sponsorship);
      const yearsNumber = yearsText === "" ? null : Number(yearsText);
      return parseOrThrow({ profile: { summary, skills, languages, years_experience: yearsNumber !== null && Number.isFinite(yearsNumber) ? yearsNumber : null, city, needs_visa_sponsorship: visa } });
    }
    case "targets": {
      const d = view.targets.draft;
      if (d === null) return parseOrThrow({ targets: {} });
      const titles = split(await ask(ctx, p("cli.prompts.titles"), d.target_titles.join(", ")));
      const seniority = await ask(ctx, p("cli.prompts.seniority", { options: SENIORITY_OPTIONS.join(", ") }), d.seniority);
      const workplace = split(await ask(ctx, p("cli.prompts.workplace", { options: WORKPLACE_OPTIONS.join(", ") }), d.workplace.join(", ")));
      const salary = Number(await ask(ctx, p("cli.prompts.salary", { currency: view.market.saved?.currency || "" }), d.salary_floor_year));
      const student = await askYes(ctx, p("cli.prompts.student"), d.exclude_student_roles);
      const companies = split(await ask(ctx, p("cli.prompts.excludeCompanies"), d.exclude_companies.join(", ")));
      const keywords = split(await ask(ctx, p("cli.prompts.excludeKeywords"), d.exclude_keywords.join(", ")));
      if (view.targets.keywordGroups !== null) {
        const plan = planKeywordGroups(view.targets.keywordGroups, view.targets.shippedKeywordGroups, titles);
        if (plan.mode !== "none") ctx.io.out(t(`cli.keywords.${plan.mode}`, { titles: (plan.groups.targets ?? []).join(", ") }));
      }
      return parseOrThrow({
        targets: {
          target_titles: titles,
          seniority,
          workplace,
          salary_floor_year: Number.isFinite(salary) ? Math.round(salary) : 0,
          contracts: { allow: CONTRACT_OPTIONS.filter((k) => d.contracts[k] === "allow"), exclude: CONTRACT_OPTIONS.filter((k) => d.contracts[k] === "exclude") },
          exclude_student_roles: student,
          exclude_companies: companies,
          exclude_keywords: keywords,
        },
      });
    }
    case "sources": {
      const fresh = view.steps.sources.status === null;
      // channels that need the terms-of-service acknowledgement are never pre-selected before the step was saved once
      const on = view.sources.channels.filter((c) => (c.consent === null ? c.enabled || (fresh && c.local) : !fresh && c.enabled)).map((c) => c.id);
      for (const c of view.sources.channels) {
        const env = c.env.length === 0 ? "" : t("cli.channelEnv", { names: c.env.map((e) => e.name).join(", "), state: c.env.map((e) => (e.present ? t("env.set") : t("env.missing"))).join(", ") });
        ctx.io.out(t("cli.channelLine", { mark: on.includes(c.id) ? "[x]" : "[ ]", id: c.id, env }));
      }
      const chosen = split(await ask(ctx, p("cli.prompts.channels"), on.join(", ")));
      const boards = split(await ask(ctx, p("cli.prompts.boards"), "")).map((entry) => {
        const [ats = "", token = "", ...name] = entry.split(":");
        return { ats: ats.trim(), token: token.trim(), name: name.join(":").trim() || token.trim() };
      });
      const offered = view.sources.channels.map((c) => c.id);
      const risky = view.sources.channels.filter((c) => c.consent !== null && chosen.includes(c.id) && (fresh || !c.enabled));
      let acknowledge_scraping = false;
      if (risky.length > 0) {
        ctx.io.out(t("cli.consentNotice", { channels: risky.map((c) => c.id).join(", ") }));
        acknowledge_scraping = await askYes(ctx, p("cli.prompts.consent"), false);
      }
      return parseOrThrow({ sources: { enable: chosen, disable: offered.filter((id) => !chosen.includes(id)), boards, acknowledge_scraping } });
    }
    case "ai": {
      const timeoutMs = (() => {
        try {
          return loadConfig("schedule").doctor.command_timeout_seconds * 1000;
        } catch {
          return 10_000;
        }
      })();
      const run = (command: string, args: readonly string[]) => runCommand(command, args, timeoutMs);
      const ai = loadConfig("ai");
      const [claude, codex] = await Promise.all([claudeLoginState(run, ai.providers.claude_cli.command), codexLoginState(run, ai.providers.codex_cli.command)]);
      ctx.io.out(t("cli.aiLogin", { command: ai.providers.claude_cli.command, state: claude }));
      ctx.io.out(t("cli.aiLogin", { command: ai.providers.codex_cli.command, state: codex }));
      for (const provider of view.ai.providers) if (provider.key !== null) ctx.io.out(t("cli.aiKey", { name: provider.key.name, state: provider.key.present ? "set" : "missing" }));
      if (claude !== "logged_in" || codex !== "logged_in") ctx.io.out(t("cli.aiLoginHint"));
      const order = split(await ask(ctx, p("cli.prompts.aiOrder", { options: AI_PROVIDER_KINDS.join(", ") }), view.ai.order.join(", ")));
      const enabled = split(await ask(ctx, p("cli.prompts.aiEnabled", { options: AI_PROVIDER_IDS.join(", ") }), view.ai.providers.filter((x) => x.enabled).map((x) => x.id).join(", ")));
      return parseOrThrow({ ai: { order, providers: Object.fromEntries(view.ai.providers.map((x) => [x.id, { enabled: enabled.includes(x.id) }])) } });
    }
  }
}

class AnswerError extends Error {
  constructor(readonly issues: Array<{ path: string; message: string }>) {
    super("invalid answer");
    this.name = "AnswerError";
  }
}

function parseOrThrow(raw: unknown): SetupAnswers {
  const parsed = parseAnswers(raw);
  if (!parsed.ok) throw new AnswerError(parsed.issues);
  return parsed.answers;
}

/** One interactive step: ask, then save / skip / stop; offers to retry after errors. "stop" ends the run. */
async function interactiveStep(ctx: Context, step: Exclude<SetupStepId, "review">): Promise<"next" | "stop"> {
  const { t } = ctx;
  if (step === "telegram") return telegramStep(ctx);
  for (;;) {
    const view = await freshView();
    ctx.io.out("");
    ctx.io.out(t("cli.stepHeader", { index: SETUP_STEP_IDS.indexOf(step) + 1, total: SETUP_STEP_IDS.length, title: t(`steps.${step}.title`) }));
    ctx.io.out(t(`steps.${step}.description`));
    let answers: SetupAnswers;
    try {
      answers = await interview(ctx, step, view);
    } catch (error) {
      if (error instanceof AnswerError) {
        ctx.io.err(t("cli.notSaved"));
        for (const issue of error.issues) ctx.io.err(t("cli.answersIssue", issue));
        if (await askYes(ctx, t("cli.retry"), true)) continue;
        return "next";
      }
      throw error;
    }
    const choice = (await ask(ctx, t("cli.askSave"), t("cli.yes"))).toLowerCase();
    if (choice.startsWith(t("cli.skip"))) {
      printResult(ctx, await skipSetupStep(step));
      return "next";
    }
    if (!choice.startsWith(t("cli.yes"))) {
      ctx.io.out(t("cli.cancelled"));
      return "stop";
    }
    if (printResult(ctx, await FROM_ANSWERS[step](ctx, view, answers))) return "next";
    if (!(await askYes(ctx, t("cli.retry"), true))) return "next";
  }
}

// ---------------------------------------------------------------- telegram (writes .env, restarts)

const doctorJsonSchema = z.object({ results: z.array(z.object({ status: z.enum(["ok", "warn", "fail"]), title: z.string(), detail: z.string() })) });

/**
 * The doctor child's environment: this process's, without the Telegram keys. They were loaded from the old `.env` when
 * `pnpm run setup` started, and `--env-file-if-exists` never overrides a variable that is already set (even to ""):
 * without them the child reads the `.env` just written.
 */
export function doctorChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const key of TELEGRAM_KEYS) delete child[key];
  return child;
}

/** `pnpm run doctor --only telegram --json` as a child process: it reads the new `.env` itself. */
export async function telegramDoctor(locale: Locale, timeoutMs: number, env: NodeJS.ProcessEnv = process.env, run: typeof runCommand = runCommand): Promise<DoctorLine[] | null> {
  const out = await run(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/doctor.ts", "--only", "telegram", "--json", "--lang", locale], timeoutMs, { env: doctorChildEnv(env) });
  if (out.kind !== "ran") return null;
  try {
    const parsed = doctorJsonSchema.safeParse(JSON.parse(out.stdout));
    return parsed.success ? parsed.data.results : null;
  } catch {
    return null;
  }
}

/** Docker compose, launchd / systemd as the deploy script and the doctor find them; null when schedule.yaml cannot be read. */
function hostServices(env: NodeJS.ProcessEnv, restartWaitSeconds: number, busyNote: string): ServiceControl | null {
  try {
    const { doctor } = loadConfig("schedule");
    return createServiceControl(
      {
        project: resolveComposeProject(env, doctor.compose_project),
        platform: process.platform,
        uid: typeof process.getuid === "function" ? process.getuid() : null,
        launchdLabel: aiWorkerLaunchdLabel(doctor.ai_worker_launchd_label, doctor.command_timeout_seconds * 1000),
        systemdUnit: AI_WORKER_SYSTEMD_UNIT,
        commandTimeoutMs: doctor.command_timeout_seconds * 1000,
        restartWaitSeconds,
      },
      // own process group (a Ctrl-C cannot cut a recreate half-way) and no exit on a further Ctrl-C until it is done
      (command, args, timeoutMs) => withInterruptsHeld(busyNote, () => runCommand(command, args, timeoutMs, { detached: true })),
    );
  } catch {
    return null;
  }
}

async function telegramStep(ctx: Context): Promise<"next" | "stop"> {
  const { t, io } = ctx;
  io.out("");
  io.out(t("cli.stepHeader", { index: SETUP_STEP_IDS.indexOf("telegram") + 1, total: SETUP_STEP_IDS.length, title: t("steps.telegram.title") }));
  io.out(t("steps.telegram.description"));
  let config;
  try {
    config = loadConfig("notify");
  } catch {
    io.err(t("formErrors.configUnreadable"));
    return "next";
  }
  const deps = ctx.deps.telegram ?? {};
  const services = deps.services !== undefined ? deps.services : hostServices(ctx.env, config.telegram.setup.restart_wait_seconds, t("cli.telegram.servicesBusy"));
  const doctorTimeoutMs = (() => {
    try {
      const { doctor } = loadConfig("schedule");
      return (doctor.command_timeout_seconds + doctor.probe_timeout_seconds) * 4 * 1000;
    } catch {
      return 60_000;
    }
  })();
  const outcome = await runTelegramSetup({
    io,
    t,
    env: ctx.env,
    envFile: deps.envFile ?? path.resolve(".env"),
    config,
    services,
    restart: ctx.restart,
    doctor: deps.doctor ?? (() => telegramDoctor(ctx.locale, doctorTimeoutMs, ctx.env)),
    saveEnabled: (enabled) => saveTelegramStep({ enabled }),
    skip: () => skipSetupStep("telegram"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (outcome === "saved") io.out(t("cli.saved"));
  else if (outcome === "skipped") io.out(t("cli.skipped"));
  else if (outcome === "failed") io.err(t("cli.notSaved"));
  else {
    io.out(t("cli.cancelled"));
    return "stop";
  }
  return "next";
}

async function queueFirstCycle(ctx: Context): Promise<void> {
  if (!ctx.db) {
    ctx.io.out(ctx.t("cli.firstCycleNoDb"));
    return;
  }
  const result = await requestRunCycle({});
  if (result.status === "queued") ctx.io.out(result.existing ? ctx.t("cli.firstCycleExisting", { id: result.request }) : ctx.t("cli.firstCycleQueued", { id: result.request }));
  else ctx.io.out(ctx.t("cli.firstCycleNoDb"));
}

async function complete(ctx: Context): Promise<boolean> {
  const before = readSetupState();
  if (!before.pending && before.state?.completed_at) {
    ctx.io.out(ctx.t("cli.alreadyCompleted"));
    return true;
  }
  const result = await finishSetup("cli");
  ctx.io.out(result.status === "error" ? ctx.t("cli.completeFailed") : ctx.t("cli.completed"));
  return result.status !== "error";
}

// ---------------------------------------------------------------- entry

export async function runSetupCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env, deps: CliDeps = {}): Promise<number> {
  let values: { step?: string; answers?: string; status?: boolean; json?: boolean; complete?: boolean; lang?: string; help?: boolean; "no-restart"?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { step: { type: "string" }, answers: { type: "string" }, status: { type: "boolean" }, json: { type: "boolean" }, complete: { type: "boolean" }, lang: { type: "string" }, "no-restart": { type: "boolean" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (error) {
    const t = setupTranslator(cliLocale());
    io.err(t("cli.badArgs", { message: error instanceof Error ? error.message : "bad arguments" }));
    io.err(t("cli.usage"));
    return 2;
  }
  const locale = cliLocale(values.lang);
  const t = setupTranslator(locale);
  if (values.help) {
    io.out(t("cli.usage"));
    return 0;
  }
  if (values.step !== undefined && !isSetupStepId(values.step)) {
    io.err(t("cli.unknownStep", { step: values.step, steps: SETUP_STEP_IDS.join(", ") }));
    return 2;
  }

  // the same first-start filling as the web and the runner (an existing install gets setup.yaml marked complete here);
  // `--status` only reports, so it reads the shipped defaults and writes nothing
  if (!values.status) {
    await ensureConfigFiles();
    try {
      await ensureProfileFiles();
    } catch {
      // reported by the steps that read the profile
    }
  }
  const ctx: Context = { io, t, tProfile: profileErrorsTranslator(locale), tFields: profileFieldsTranslator(locale), db: await databaseAvailable(env), locale, env, restart: values["no-restart"] !== true, deps };
  try {
    if (values.status) {
      const report = await statusReport(ctx);
      if (values.json) io.out(JSON.stringify(report.json, null, 2));
      else for (const line of report.text) io.out(line);
      return 0;
    }
    if (values.complete) {
      const result = await completeSetup("cli");
      io.out(result.ok ? t("cli.completed") : t("cli.completeFailed"));
      return result.ok ? 0 : 1;
    }
    const only = values.step as SetupStepId | undefined;
    const steps = SETUP_STEP_IDS.filter((id): id is Exclude<SetupStepId, "review"> => id !== "review" && (only === undefined || id === only));

    if (values.answers !== undefined) {
      let raw: unknown;
      try {
        raw = parseYaml(fs.readFileSync(values.answers, "utf8"));
      } catch (error) {
        io.err(t("cli.answersRead", { file: values.answers, error: error instanceof Error ? error.message.split("\n")[0] ?? "" : "" }));
        return 2;
      }
      const parsed = parseAnswers(raw);
      if (!parsed.ok) {
        io.err(t("cli.answersInvalid"));
        for (const issue of parsed.issues) io.err(t("cli.answersIssue", issue));
        return 2;
      }
      let failed = false;
      for (const step of steps) {
        io.out(t("cli.stepHeader", { index: SETUP_STEP_IDS.indexOf(step) + 1, total: SETUP_STEP_IDS.length, title: t(`steps.${step}.title`) }));
        if (!printResult(ctx, await FROM_ANSWERS[step](ctx, await freshView(), parsed.answers))) failed = true;
      }
      if (only === undefined || only === "review") {
        if (parsed.answers.finish.run_first_cycle) await queueFirstCycle(ctx);
        if (parsed.answers.finish.complete && !failed && !(await complete(ctx))) failed = true;
      }
      return failed ? 1 : 0;
    }

    io.out(t("cli.title"));
    io.out(t("cli.intro"));
    try {
      for (const step of steps) if ((await interactiveStep(ctx, step)) === "stop") return 0;
      if (only === undefined || only === "review") {
        const report = await statusReport(ctx);
        for (const line of report.text.slice(1)) io.out(line);
        if (ctx.db && (await askYes(ctx, t("cli.askFirstCycle"), false))) await queueFirstCycle(ctx);
        if (await askYes(ctx, t("cli.askComplete"), true)) return (await complete(ctx)) ? 0 : 1;
      }
      return 0;
    } catch (error) {
      if (error instanceof EndOfInput) {
        io.out(t("cli.cancelled"));
        return 0;
      }
      throw error;
    }
  } finally {
    await Promise.race([closeDb(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
