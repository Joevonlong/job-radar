/**
 * The Telegram step of `pnpm run setup` on the command line: the one place where the bot token and the chat id are
 * entered and written to the local `.env` (the web only shows whether they are set). Flow: paste the token (not echoed)
 * -> `getMe` -> learn the chat id from the first message to the bot (`getUpdates`) or type it -> test message -> write
 * `.env` (three keys only, backed up) -> `telegram.enabled` -> recreate web / runner and restart the host ai-worker ->
 * check the runner's poller and the doctor.
 *
 * Secrets: the token is only ever held in memory, sent to the Bot API host of notify.yaml (with the same endpoint guard as
 * the runner), and written to `.env`. It is never printed, never part of an error (the client scrubs it) and never in a
 * command line. The chat id is shown masked.
 *
 * The runner long-polls `getUpdates` with the same token once Telegram is configured: two pollers take each other's
 * updates. So when the token being set up is the one the running runner uses, the runner is stopped before the chat id is
 * detected and brought back on the way out, whatever happens (finished, failed, quit, Ctrl-C).
 */
import { checkCredentialEndpoint } from "@/lib/credential-endpoints";
import type { NotifyConfig } from "@/lib/config";
import { loadTelegramEnv } from "@/lib/env";
import { ENV_FILE_SERVICES, type AiWorkerManager, type EnvFileService, type ServiceControl } from "@/lib/ops/services";
import { createTelegramClient, isTelegramError, type TelegramClient, type TelegramFetch, type TelegramUpdate } from "@/lib/notify/telegram-client";
import { sendTestMessage } from "@/lib/notify/test-message";

import type { CliIo } from "./cli-io";
import { updateEnvFile } from "./env-file";
import type { SetupTranslator } from "./text";
import type { SetupStepResult } from "./types";

export const TELEGRAM_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS"] as const;

const TOKEN_PATTERN = /^\d+:[\w-]+$/;
const CHAT_PATTERN = /^-?\d+$/;
const USER_IDS_PATTERN = /^\s*\d+(\s*,\s*\d+)*\s*$/;
const POLLER_STARTED = "telegram poller started";
const LOG_POLL_MS = 2000;

export interface DoctorLine {
  status: "ok" | "warn" | "fail";
  title: string;
  detail: string;
}

export interface TelegramSetupDeps {
  io: CliIo;
  t: SetupTranslator;
  /** The current environment (the pnpm script loaded `.env` into it). */
  env: Readonly<Record<string, string | undefined>>;
  /** The `.env` to write. */
  envFile: string;
  config: NotifyConfig;
  fetch?: TelegramFetch;
  /** Docker / launchd / systemd; null when they cannot be controlled from here. */
  services: ServiceControl | null;
  /** False with `--no-restart`: only print the commands. */
  restart: boolean;
  /** `pnpm run doctor --only telegram`, after the restart; null when it could not run. */
  doctor?: () => Promise<DoctorLine[] | null>;
  /** Mark the step done with `telegram.enabled` (notify.yaml) set to this. */
  saveEnabled: (enabled: boolean) => Promise<SetupStepResult>;
  /** Mark the step skipped. */
  skip: () => Promise<SetupStepResult>;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type TelegramSetupOutcome = "saved" | "skipped" | "stopped" | "failed";

interface Credentials {
  token: string;
  chatId: string;
  allowed: string;
}

/** The input ended, the user quit or pressed Ctrl-C: stop without writing anything more. */
class Stop extends Error {
  constructor() {
    super("stopped");
    this.name = "Stop";
  }
}

/** `-100…4321` style: enough to recognise the chat, not the whole id. */
export function maskChatId(chatId: string): string {
  const sign = chatId.startsWith("-") ? "-" : "";
  const digits = chatId.replace(/^-/, "");
  return digits.length <= 4 ? `${sign}${"•".repeat(digits.length)}` : `${sign}•••${digits.slice(-4)}`;
}

/** Strip control characters from a name someone typed in Telegram before it reaches the terminal. */
function clean(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    })
    .join("")
    .trim()
    .slice(0, 80);
}

type Message = NonNullable<TelegramUpdate["message"]>;

function personName(from: Message["from"]): string {
  if (from === undefined) return "?";
  const full = clean([from.first_name, from.last_name].filter((part) => part !== undefined && part !== "").join(" "));
  return full !== "" ? full : from.username !== undefined ? `@${clean(from.username)}` : String(from.id);
}

export function describeChat(t: SetupTranslator, message: Message): string {
  const { chat } = message;
  const isPrivate = chat.type === "private" || (chat.type === undefined && chat.id > 0);
  if (isPrivate) return t("cli.telegram.chatPrivate", { name: personName(message.from) });
  return t("cli.telegram.chatGroup", { title: clean(chat.title ?? "") || "?", name: personName(message.from) });
}

export async function runTelegramSetup(deps: TelegramSetupDeps): Promise<TelegramSetupOutcome> {
  const { io, t } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));
  const signal = io.signal;
  const telegram = deps.config.telegram;
  /** Set while this command has the runner stopped; cleared once it runs again. */
  let runnerStopped = false;
  let envWritten = false;

  const say = (line: string) => io.out(line);
  const warn = (line: string) => io.err(line);

  const read = async (question: string, secret = false): Promise<string> => {
    if (signal?.aborted) throw new Stop();
    const answer = secret && io.askSecret ? await io.askSecret(question) : await io.ask(question);
    if (answer === null || signal?.aborted) throw new Stop();
    return answer.trim();
  };
  /** One of `options` (short answers like `y`, `k`; a longer word starting with one counts too); Enter takes `fallback`. */
  const choose = async <K extends string>(question: string, options: Readonly<Record<K, string>>, fallback: NoInfer<K>): Promise<K> => {
    for (;;) {
      const answer = (await read(`${question} [${options[fallback]}]: `)).toLowerCase();
      if (answer === "") return fallback;
      const hit = (Object.keys(options) as K[]).find((key) => answer.startsWith(options[key].toLowerCase()));
      if (hit !== undefined) return hit;
    }
  };
  const yes = async (question: string, fallback: boolean): Promise<boolean> =>
    (await choose(question, { yes: t("cli.yes"), no: t("cli.no") }, fallback ? "yes" : "no")) === "yes";

  const client = (token: string): TelegramClient =>
    createTelegramClient({
      token,
      baseUrl: telegram.api_base_url,
      requestTimeoutMs: telegram.request_timeout_seconds * 1000,
      maxRetries: telegram.max_retries,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(signal ? { signal } : {}),
    });

  /** The reason of a failed call in words, never with the token (the client scrubs it from every message). */
  const failure = (error: unknown): string => {
    if (signal?.aborted) throw new Stop();
    if (!isTelegramError(error)) return t("cli.telegram.errorUnknown");
    if (error.kind === "api" && (error.status === 401 || error.status === 404)) return t("cli.telegram.errorRejected");
    if (error.kind === "api" && error.status === 409) return t("cli.telegram.errorConflict");
    if (error.kind === "network" || error.kind === "timeout") return t("cli.telegram.errorNetwork", { host: hostOf(telegram.api_base_url) });
    return t("cli.telegram.errorApi", { reason: error.description.slice(0, 200) });
  };

  // ------------------------------------------------------------ runner (getUpdates competition)

  const stopRunnerIfPolling = async (token: string): Promise<void> => {
    if (runnerStopped || deps.services === null || !deps.restart) return;
    // the runner reads the token from .env at start: it can only compete for this bot's updates when that is the token in use
    if ((deps.env.TELEGRAM_BOT_TOKEN ?? "").trim() !== token) return;
    const running = await deps.services.runningServices();
    if (running === null || !running.includes("runner")) return;
    say(t("cli.telegram.runnerStopping"));
    const result = await deps.services.stop("runner");
    if (result.ok) runnerStopped = true;
    else warn(t("cli.telegram.runnerStopFailed", { reason: result.reason }));
  };

  const bringBackRunner = async (): Promise<void> => {
    if (!runnerStopped || deps.services === null) return;
    say(t("cli.telegram.runnerStarting"));
    const result = envWritten ? await deps.services.recreate(["runner"]) : await deps.services.start("runner");
    if (result.ok) {
      runnerStopped = false;
      return;
    }
    warn(t("cli.telegram.runnerStartFailed", { reason: result.reason }));
    for (const command of deps.services.manualCommands(["runner"], null)) warn(`  ${command}`);
  };

  // ------------------------------------------------------------ steps

  const askToken = async (): Promise<{ token: string; bot: string }> => {
    for (;;) {
      const token = await read(t("cli.telegram.askToken"), true);
      if (token === "") continue;
      if (!TOKEN_PATTERN.test(token)) {
        warn(t("cli.telegram.tokenFormat"));
        continue;
      }
      say(t("cli.telegram.checkingToken"));
      try {
        const me = await client(token).getMe();
        const bot = me.username ?? String(me.id);
        say(t("cli.telegram.tokenOk", { bot }));
        return { token, bot };
      } catch (error) {
        warn(failure(error));
        if (!(await yes(t("cli.telegram.retryToken"), true))) throw new Stop();
      }
    }
  };

  /** Wait for the first message to the bot; null when none came in time. */
  const waitForMessage = async (bot: TelegramClient): Promise<Message | null> => {
    const deadline = now().getTime() + telegram.setup.wait_for_message_seconds * 1000;
    // what is already waiting (e.g. the /start of creating the bot): only the newest one is offered
    const backlog = await bot.getUpdates({ timeoutSeconds: 0, ...(signal ? { signal } : {}) });
    let offset = backlog.lastUpdateId === null ? undefined : backlog.lastUpdateId + 1;
    const pending = backlog.updates.map((update) => update.message).filter((message): message is Message => message !== undefined && message.from?.is_bot !== true);
    const newest = pending[pending.length - 1];
    if (newest !== undefined) return newest;
    say(t("cli.telegram.waiting", { seconds: telegram.setup.wait_for_message_seconds }));
    for (;;) {
      const remaining = Math.ceil((deadline - now().getTime()) / 1000);
      if (remaining <= 0) return null;
      const batch = await bot.getUpdates({ ...(offset === undefined ? {} : { offset }), timeoutSeconds: Math.min(telegram.poll_timeout_seconds, remaining), ...(signal ? { signal } : {}) });
      if (batch.lastUpdateId !== null) offset = batch.lastUpdateId + 1;
      const message = batch.updates.map((update) => update.message).find((m): m is Message => m !== undefined && m.from?.is_bot !== true);
      if (message !== undefined) return message;
    }
  };

  const askAllowed = async (fallback: string): Promise<string> => {
    say(t("cli.telegram.groupHint"));
    for (;;) {
      const answer = await read(`${t("cli.telegram.askAllowed")} ${t("cli.keep", { value: fallback === "" ? t("cli.values.empty") : fallback })}: `);
      const value = answer === "" ? fallback : answer;
      if (value === "") return "";
      if (USER_IDS_PATTERN.test(value)) return value.replace(/\s+/g, "");
      warn(t("cli.telegram.allowedFormat"));
    }
  };

  const askChatManually = async (): Promise<{ chatId: string; allowed: string }> => {
    for (;;) {
      const chatId = await read(t("cli.telegram.askChatId"));
      if (!CHAT_PATTERN.test(chatId)) {
        warn(t("cli.telegram.chatFormat"));
        continue;
      }
      return { chatId, allowed: chatId.startsWith("-") ? await askAllowed("") : "" };
    }
  };

  const askChat = async (token: string, botName: string): Promise<{ chatId: string; allowed: string }> => {
    for (;;) {
      const how = await choose(t("cli.telegram.askChatHow"), { detect: t("cli.telegram.optDetect"), manual: t("cli.telegram.optManual"), quit: t("cli.telegram.optQuit") }, "detect");
      if (how === "quit") throw new Stop();
      if (how === "manual") return askChatManually();
      await stopRunnerIfPolling(token);
      say(t("cli.telegram.sendNow", { bot: botName }));
      let message: Message | null;
      try {
        message = await waitForMessage(client(token));
      } catch (error) {
        warn(failure(error));
        if (isTelegramError(error) && error.status === 409) warn(t("cli.telegram.conflictHint"));
        continue;
      }
      if (message === null) {
        warn(t("cli.telegram.noMessage"));
        continue;
      }
      say(t("cli.telegram.detected", { chat: describeChat(t, message), id: maskChatId(String(message.chat.id)) }));
      if (!(await yes(t("cli.telegram.useChat"), true))) continue;
      const chatId = String(message.chat.id);
      return { chatId, allowed: chatId.startsWith("-") ? await askAllowed(message.from === undefined ? "" : String(message.from.id)) : "" };
    }
  };

  /** Send the test message; true once the user saw it. */
  const testMessage = async (credentials: Credentials): Promise<boolean> => {
    for (;;) {
      say(t("cli.telegram.sendingTest", { id: maskChatId(credentials.chatId) }));
      try {
        await sendTestMessage({ client: client(credentials.token), chatId: credentials.chatId });
      } catch (error) {
        warn(failure(error));
        if (await yes(t("cli.telegram.retryTest"), true)) continue;
        return false;
      }
      if (await yes(t("cli.telegram.askArrived"), true)) return true;
      return false;
    }
  };

  const writeEnv = (changes: Record<(typeof TELEGRAM_KEYS)[number], string>): boolean => {
    try {
      const result = updateEnvFile({ file: deps.envFile, changes, now: now() });
      envWritten = true;
      say(result.created ? t("cli.telegram.envCreated", { file: result.file }) : t("cli.telegram.envWritten", { file: result.file, backup: result.backup ?? "" }));
      return true;
    } catch (error) {
      warn(t("cli.telegram.envFailed", { file: deps.envFile, reason: error instanceof Error ? error.message : "" }));
      return false;
    }
  };

  const restartAndVerify = async (): Promise<void> => {
    const services = deps.services;
    if (!deps.restart || services === null) {
      say(deps.restart ? t("cli.telegram.restartUnavailable") : t("cli.telegram.restartSkipped"));
      for (const command of services?.manualCommands(ENV_FILE_SERVICES, "unknown") ?? []) say(`  ${command}`);
      if (services === null) say(t("cli.telegram.restartManualGeneric"));
      return;
    }
    const manual: { compose: EnvFileService[]; ai: AiWorkerManager | "unknown" | null } = { compose: [], ai: null };
    const running = await services.runningServices();
    const since = now();
    let runnerBack = false;
    if (running === null) {
      warn(t("cli.telegram.dockerUnavailable"));
      manual.compose = [...ENV_FILE_SERVICES];
    } else {
      const targets = ENV_FILE_SERVICES.filter((service) => running.includes(service) || (service === "runner" && runnerStopped));
      if (targets.length === 0) say(t("cli.telegram.stackDown"));
      else {
        say(t("cli.telegram.recreating", { services: targets.join(", "), seconds: telegram.setup.restart_wait_seconds }));
        const result = await services.recreate(targets);
        if (result.ok) {
          say(t("cli.telegram.recreated", { services: targets.join(", ") }));
          if (targets.includes("runner")) {
            runnerStopped = false;
            runnerBack = true;
          }
        } else {
          warn(t("cli.telegram.recreateFailed", { reason: result.reason }));
          manual.compose = targets;
        }
      }
    }
    const worker = await services.aiWorker();
    if (worker === null) say(t("cli.telegram.aiWorkerNotRunning"));
    else {
      const result = await services.restartAiWorker(worker);
      if (result.ok) say(t("cli.telegram.aiWorkerRestarted"));
      else {
        warn(t("cli.telegram.aiWorkerFailed", { reason: result.reason }));
        manual.ai = worker;
      }
    }
    if (manual.compose.length > 0 || manual.ai !== null) {
      warn(t("cli.telegram.manualTitle"));
      for (const command of services.manualCommands(manual.compose, manual.ai)) warn(`  ${command}`);
    }
    if (runnerBack) {
      const deadline = since.getTime() + telegram.setup.poller_check_seconds * 1000;
      let seen = false;
      while (!seen && now().getTime() < deadline && !signal?.aborted) {
        seen = (await services.runnerLogSince(since))?.includes(POLLER_STARTED) ?? false;
        if (!seen) await sleep(LOG_POLL_MS, signal);
      }
      if (seen) say(t("cli.telegram.pollerOk"));
      else warn(t("cli.telegram.pollerMissing", { command: `docker compose -p ${services.settings.project} logs --tail 50 runner` }));
    }
  };

  const runDoctor = async (): Promise<void> => {
    if (deps.doctor === undefined) return;
    say(t("cli.telegram.doctorTitle"));
    const lines = await deps.doctor();
    if (lines === null) {
      warn(t("cli.telegram.doctorFailed"));
      return;
    }
    const icon = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
    for (const line of lines) say(`  ${icon[line.status]} ${line.title}: ${line.detail}`);
  };

  const finishEnabled = async (askDefault: boolean, ask: boolean): Promise<TelegramSetupOutcome> => {
    const enabled = ask ? await yes(t("cli.telegram.askEnable"), askDefault) : askDefault;
    const result = await deps.saveEnabled(enabled);
    if (result.status === "error") {
      warn(t("cli.notSaved"));
      return "failed";
    }
    say(enabled ? t("cli.telegram.enabledOn") : t("cli.telegram.enabledOff"));
    return "saved";
  };

  // ------------------------------------------------------------ main

  const main = async (): Promise<TelegramSetupOutcome> => {
    const endpoint = checkCredentialEndpoint("telegram", telegram.api_base_url, deps.env);
    if (endpoint.status === "refused") {
      warn(t("cli.telegram.endpointRefused", { reason: endpoint.message }));
      return "failed";
    }
    if (endpoint.status === "custom") warn(endpoint.message);

    let current: Credentials | null = null;
    let invalid = false;
    try {
      const env = loadTelegramEnv(deps.env);
      if (env !== null) current = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, allowed: env.TELEGRAM_ALLOWED_USER_IDS ?? "" };
    } catch {
      invalid = true;
    }

    if (current !== null) {
      let bot: string;
      try {
        const me = await client(current.token).getMe();
        bot = `@${me.username ?? me.id}`;
      } catch (error) {
        bot = failure(error);
      }
      say(t("cli.telegram.current", { bot, id: maskChatId(current.chatId) }));
      const choice = await choose(
        t("cli.telegram.askExisting"),
        { keep: t("cli.telegram.optKeep"), replace: t("cli.telegram.optReplace"), test: t("cli.telegram.optTest"), remove: t("cli.telegram.optRemove"), skip: t("cli.telegram.optSkip") },
        "keep",
      );
      if (choice === "skip") {
        await deps.skip();
        return "skipped";
      }
      if (choice === "keep") return finishEnabled(true, true);
      if (choice === "test") {
        await testMessage(current);
        return finishEnabled(true, true);
      }
      if (choice === "remove") {
        if (!(await yes(t("cli.telegram.askRemove"), false))) return "stopped";
        if (!writeEnv({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", TELEGRAM_ALLOWED_USER_IDS: "" })) return "failed";
        const outcome = await finishEnabled(false, false);
        await restartAndVerify();
        return outcome;
      }
    } else {
      if (invalid) warn(t("cli.telegram.currentInvalid"));
      for (const line of t("cli.telegram.intro").split("\n")) say(line);
      const start = await choose(t("cli.telegram.askStart"), { yes: t("cli.yes"), skip: t("cli.skip"), no: t("cli.no") }, "yes");
      if (start !== "yes") {
        await deps.skip();
        return "skipped";
      }
    }

    const { token, bot } = await askToken();
    let credentials: Credentials | null = null;
    while (credentials === null) {
      const chat = await askChat(token, bot);
      const candidate = { token, ...chat };
      if (await testMessage(candidate)) credentials = candidate;
      else if (!(await yes(t("cli.telegram.retryChat"), true))) throw new Stop();
    }
    say(t("cli.telegram.summary", { bot, id: maskChatId(credentials.chatId), allowed: credentials.allowed === "" ? t("cli.values.empty") : credentials.allowed }));
    if (!(await yes(t("cli.telegram.askWrite", { file: deps.envFile }), true))) {
      say(t("cli.telegram.nothingWritten"));
      return "stopped";
    }
    if (!writeEnv({ TELEGRAM_BOT_TOKEN: credentials.token, TELEGRAM_CHAT_ID: credentials.chatId, TELEGRAM_ALLOWED_USER_IDS: credentials.allowed })) return "failed";
    const outcome = await finishEnabled(true, true);
    await restartAndVerify();
    await runDoctor();
    say(t("cli.telegram.done"));
    return outcome;
  };

  try {
    return await main();
  } catch (error) {
    if (error instanceof Stop) {
      say(envWritten ? t("cli.telegram.stoppedAfterWrite") : t("cli.telegram.nothingWritten"));
      return "stopped";
    }
    throw error;
  } finally {
    await bringBackRunner();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
