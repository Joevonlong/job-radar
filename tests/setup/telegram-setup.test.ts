// @vitest-environment node
/**
 * `pnpm run setup --step telegram` end to end against a fake Bot API (a local HTTP server), a fake service control and a
 * temp `.env`: the token is never printed, `.env` only changes the three keys, the runner never competes for the first
 * message, and the restart (or the commands to do it by hand) follows.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { parseDocument } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { reloadConfig, setOnProfileSaved } from "@/lib/config";
import { runSetupCli, type CliIo } from "@/lib/setup/cli";
import { heldInterruptNote } from "@/lib/setup/interrupt-guard";
import { resetSetupStateCache, readSetupState } from "@/lib/setup/state";
import type { DoctorLine } from "@/lib/setup/telegram-setup";
import { maskChatId } from "@/lib/setup/telegram-setup";
import type { EnvFileService, ServiceControl, StepOutcome } from "@/lib/ops/services";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const GOOD_TOKEN = "123456:FAKE-good-telegram-token";
const OLD_TOKEN = "654321:FAKE-old-telegram-token";
const WRONG_TOKEN = "999999:FAKE-wrong-telegram-token";
const SECRETS = [GOOD_TOKEN, OLD_TOKEN, WRONG_TOKEN];

// ---------------------------------------------------------------- fake Bot API

interface FakeApi {
  url: string;
  /** Updates returned by the next getUpdates calls (one array per call; empty when used up). */
  updates: unknown[][];
  sent: Array<{ chat_id: string; text: string }>;
  calls: string[];
  /** Answer getUpdates with 409 (another poller) this many times. */
  conflicts: number;
  /** The body of every getUpdates call (offset, timeout). */
  polls: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

let api: FakeApi;

async function startFakeApi(): Promise<FakeApi> {
  const state: Omit<FakeApi, "url" | "close"> = { updates: [], sent: [], calls: [], conflicts: 0, polls: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      const token = decodeURIComponent(match?.[1] ?? "");
      const method = match?.[2] ?? "";
      state.calls.push(method);
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (token !== GOOD_TOKEN && token !== OLD_TOKEN) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const payload = (body === "" ? {} : JSON.parse(body)) as Record<string, unknown>;
      if (method === "getMe") return reply(200, { ok: true, result: { id: 777, is_bot: true, username: token === GOOD_TOKEN ? "radar_test_bot" : "old_bot" } });
      if (method === "sendMessage") {
        state.sent.push({ chat_id: String(payload.chat_id), text: String(payload.text) });
        return reply(200, { ok: true, result: { message_id: state.sent.length } });
      }
      if (method === "getUpdates") {
        state.polls.push(payload);
        if (state.conflicts > 0) {
          state.conflicts -= 1;
          return reply(409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" });
        }
        const next = state.updates.shift() ?? [];
        // a long poll that finds nothing waits a little (not the full timeout: the tests stay fast)
        if (next.length === 0) setTimeout(() => reply(200, { ok: true, result: [] }), 50);
        else reply(200, { ok: true, result: next });
        return;
      }
      reply(404, { ok: false, error_code: 404, description: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

const privateMessage = (updateId: number) => ({ update_id: updateId, message: { message_id: 1, date: 1, chat: { id: 4242424242, type: "private", first_name: "Joe" }, from: { id: 4242424242, first_name: "Joe" }, text: "hi" } });
const groupMessage = (updateId: number) => ({ update_id: updateId, message: { message_id: 2, date: 1, chat: { id: -1009876543210, type: "supergroup", title: "Job hunt" }, from: { id: 42, first_name: "Ann" }, text: "/start@radar_test_bot" } });

const buttonPress = (updateId: number) => ({ update_id: updateId, callback_query: { id: "cb1", from: { id: 4242424242 }, data: "status:1:interested" } });
const oldMessage = (updateId: number) => ({ update_id: updateId, message: { message_id: 9, date: 1_700_000_000, chat: { id: 31313131, type: "private", first_name: "Old" }, from: { id: 31313131, first_name: "Old" }, text: "/start" } });

// ---------------------------------------------------------------- fakes

interface FakeServices extends ServiceControl {
  calls: string[];
}

function fakeServices(options: { running?: string[] | null; recreate?: StepOutcome; runningAfterFailedRecreate?: string[]; aiWorker?: "launchd" | null; pollerLog?: boolean } = {}): FakeServices {
  const calls: string[] = [];
  let running = options.running === undefined ? ["db", "web", "runner", "jobspy"] : options.running;
  const settings = { project: "radar-test", platform: "darwin" as const, uid: 501, launchdLabel: "io.example.ai-worker", systemdUnit: "x.service", commandTimeoutMs: 1000, restartWaitSeconds: 5 };
  return {
    calls,
    settings,
    runningServices: async () => {
      calls.push("ps");
      return running;
    },
    stop: async (service: EnvFileService) => {
      calls.push(`stop ${service}`);
      return { ok: true, reason: "" };
    },
    start: async (service: EnvFileService) => {
      calls.push(`start ${service}`);
      return { ok: true, reason: "" };
    },
    recreate: async (services: readonly EnvFileService[]) => {
      calls.push(`recreate ${services.join(",")}`);
      if (options.recreate?.ok === false && options.runningAfterFailedRecreate) running = options.runningAfterFailedRecreate;
      return options.recreate ?? { ok: true, reason: "" };
    },
    ensureUp: async (services: readonly EnvFileService[]) => {
      calls.push(`up ${services.join(",")}`);
      return { ok: true, reason: "" };
    },
    aiWorker: async () => {
      calls.push("ai-worker?");
      return options.aiWorker === undefined ? "launchd" : options.aiWorker;
    },
    restartAiWorker: async (manager) => {
      calls.push(`restart ai-worker ${manager}`);
      return { ok: true, reason: "" };
    },
    runnerLogSince: async () => {
      calls.push("logs runner");
      return options.pollerLog === false ? "runner up\n" : "runner up\ntelegram poller started\n";
    },
    manualCommands: (services, ai) => [...(services.length > 0 ? [`docker compose -p radar-test up -d --no-deps --force-recreate ${services.join(" ")}`] : []), ...(ai === null ? [] : ["launchctl kickstart -k gui/501/io.example.ai-worker"])],
  };
}

interface Run extends CliIo {
  lines: string[];
  errors: string[];
  questions: string[];
}

/** Scripted answers; `abortAt` aborts the signal when that question (substring) is reached instead of answering. */
function io(answers: readonly string[], options: { abortWhen?: (questions: number) => boolean; controller?: AbortController } = {}): Run {
  const queue = [...answers];
  const lines: string[] = [];
  const errors: string[] = [];
  const questions: string[] = [];
  const answer = async (question: string): Promise<string | null> => {
    questions.push(question);
    lines.push(question);
    return queue.length > 0 ? (queue.shift() ?? "") : null;
  };
  return {
    lines,
    errors,
    questions,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    ask: answer,
    askSecret: answer,
    ...(options.controller ? { signal: options.controller.signal } : {}),
  };
}

let tmp: TempConfig;
let envFile: string;
const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS", "DATABASE_URL", "JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS"];

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none", JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1", ...extra };
}

const doctor = async (): Promise<DoctorLine[]> => [{ status: "ok", title: "Telegram credentials", detail: "set" }];

function setup(argv: string[], run: Run, env: NodeJS.ProcessEnv, services: ServiceControl | null) {
  return runSetupCli(["--step", "telegram", "--lang", "en", ...argv], run, env, { telegram: { services, doctor, envFile, sleep: async () => undefined } });
}

function expectNoSecret(run: Run): void {
  const text = [...run.lines, ...run.errors].join("\n");
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
  tmp = makeTempConfig({ user: "init" });
  // the Bot API of the test: the fake server, and a short wait for the first message
  const notifyFile = path.join(tmp.configDir, "notify.yaml");
  const doc = parseDocument(fs.readFileSync(notifyFile, "utf8"));
  doc.setIn(["telegram", "api_base_url"], api.url);
  doc.setIn(["telegram", "setup"], doc.createNode({ wait_for_message_seconds: 1, restart_wait_seconds: 5, poller_check_seconds: 1 }));
  fs.writeFileSync(notifyFile, doc.toString());
  reloadConfig("notify");
  envFile = path.join(tmp.root, ".env");
  fs.writeFileSync(path.join(tmp.root, ".env.example"), "# example\nPOSTGRES_PASSWORD=\n# ---- Telegram\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\nTELEGRAM_ALLOWED_USER_IDS=\n");
  api.updates = [];
  api.sent = [];
  api.calls = [];
  api.conflicts = 0;
  api.polls = [];
  resetSetupStateCache();
});
afterEach(() => {
  setOnProfileSaved(null);
  tmp.cleanup();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const envText = () => fs.readFileSync(envFile, "utf8");

describe("pnpm run setup --step telegram: a first setup", () => {
  it("token (wrong first), detected private chat, test message, .env written, push on, services restarted, nothing secret printed", async () => {
    api.updates = [[], [privateMessage(10)]];
    const services = fakeServices();
    // y start | bad format | wrong token | y retry | good token | a detect | y use chat | y arrived | y write | y enable
    const run = io(["y", "not-a-token", WRONG_TOKEN, "y", GOOD_TOKEN, "a", "y", "y", "y", "y"]);
    expect(await setup([], run, baseEnv(), services)).toBe(0);
    const out = run.lines.join("\n");
    expect(run.errors.join("\n")).toContain("That is not a bot token");
    expect(run.errors.join("\n")).toContain("Telegram rejected this token");
    expect(out).toContain("Token works: this is bot @radar_test_bot.");
    expect(out).toContain("Received from Joe (private chat), chat id •••4242.");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.chat_id).toBe("4242424242");
    // .env created from the example: the three keys set, everything else as it was, owner-only
    expect(envText()).toBe(`# example\nPOSTGRES_PASSWORD=\n# ---- Telegram\nTELEGRAM_BOT_TOKEN=${GOOD_TOKEN}\nTELEGRAM_CHAT_ID=4242424242\nTELEGRAM_ALLOWED_USER_IDS=\n`);
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(reloadConfig("notify").telegram.enabled).toBe(true);
    expect(readSetupState().state?.steps.telegram?.status).toBe("done");
    // a new bot: the runner does not poll it, so it is not stopped; web and runner recreated, ai-worker restarted
    expect(services.calls).not.toContain("stop runner");
    expect(services.calls).toContain("recreate web,runner");
    expect(services.calls).toContain("restart ai-worker launchd");
    expect(out).toContain("Runner log: telegram poller started.");
    expect(out).toContain("✅ Telegram credentials: set");
    expectNoSecret(run);
  });

  it("a group chat asks for the allowed user ids and offers the sender", async () => {
    api.updates = [[], [groupMessage(20)]];
    const run = io(["y", GOOD_TOKEN, "a", "y", "", "y", "y", "n"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(run.lines.join("\n")).toContain('Received from group "Job hunt" (sent by Ann), chat id -•••3210.');
    expect(run.questions.some((q) => q.includes("Allowed user ids") && q.includes("[42]"))).toBe(true);
    expect(envText()).toContain("TELEGRAM_CHAT_ID=-1009876543210\nTELEGRAM_ALLOWED_USER_IDS=42\n");
    expect(reloadConfig("notify").telegram.enabled).toBe(false);
  });

  it("no message in time: type the chat id instead", async () => {
    const run = io(["y", GOOD_TOKEN, "a", "m", "12345", "y", "y", "y"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(run.errors.join("\n")).toContain("No message arrived in time.");
    expect(envText()).toContain("TELEGRAM_CHAT_ID=12345\n");
  });

  it("another poller (409): says so and falls back to typing the id", async () => {
    api.conflicts = 1;
    const run = io(["y", GOOD_TOKEN, "a", "m", "12345", "y", "y", "y"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(run.errors.join("\n")).toContain("another program is reading this bot's messages");
  });

  it("declining the write leaves .env alone", async () => {
    fs.writeFileSync(envFile, "KEEP=1\n");
    const run = io(["y", GOOD_TOKEN, "m", "12345", "y", "n"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(envText()).toBe("KEEP=1\n");
    expect(run.lines.join("\n")).toContain(".env was not changed.");
  });

  it("s skips the step and writes nothing", async () => {
    const run = io(["s"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(readSetupState().state?.steps.telegram?.status).toBe("skipped");
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("--no-restart touches no service and prints the commands", async () => {
    const services = fakeServices();
    const run = io(["y", GOOD_TOKEN, "m", "12345", "y", "y", "y"]);
    expect(await setup(["--no-restart"], run, baseEnv(), services)).toBe(0);
    expect(services.calls.filter((call) => call !== "ps")).toEqual([]);
    expect(run.lines.join("\n")).toContain("docker compose -p radar-test up -d --no-deps --force-recreate web runner");
  });

  it("a failed restart prints the manual commands", async () => {
    const services = fakeServices({ recreate: { ok: false, reason: "container runner is unhealthy" } });
    const run = io(["y", GOOD_TOKEN, "m", "12345", "y", "y", "y"]);
    expect(await setup([], run, baseEnv(), services)).toBe(0);
    const errors = run.errors.join("\n");
    expect(errors).toContain("The restart failed: container runner is unhealthy");
    expect(errors).toContain("docker compose -p radar-test up -d --no-deps --force-recreate web runner");
    // nothing went down: nothing to bring back
    expect(services.calls.some((call) => call.startsWith("up "))).toBe(false);
  });

  it("a recreate cut short that left web removed brings web back (and the commands are still printed)", async () => {
    const services = fakeServices({ recreate: { ok: false, reason: "docker compose up timed out" }, runningAfterFailedRecreate: ["db", "runner", "jobspy"] });
    const run = io(["y", GOOD_TOKEN, "m", "12345", "y", "y", "y"]);
    expect(await setup([], run, baseEnv(), services)).toBe(0);
    expect(services.calls).toContain("up web");
    expect(run.lines.join("\n")).toContain("web running again.");
    expect(run.errors.join("\n")).toContain("docker compose -p radar-test up -d --no-deps --force-recreate web runner");
  });

  it("an existing .env keeps its other lines and order and gets a backup", async () => {
    fs.writeFileSync(envFile, "A=1\nTELEGRAM_CHAT_ID=1\n# comment\nB=2\n", { mode: 0o644 });
    const run = io(["y", GOOD_TOKEN, "m", "12345", "y", "y", "y"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(envText()).toBe(`A=1\nTELEGRAM_CHAT_ID=12345\n# comment\nB=2\nTELEGRAM_BOT_TOKEN=${GOOD_TOKEN}\nTELEGRAM_ALLOWED_USER_IDS=\n`);
    const backups = fs.readdirSync(tmp.root).filter((name) => name.startsWith(".env.backup-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp.root, backups[0] ?? ""), "utf8")).toBe("A=1\nTELEGRAM_CHAT_ID=1\n# comment\nB=2\n");
    // the copy holds the old values: the command says to delete it
    expect(run.errors.join("\n")).toContain(`The backup ${path.join(tmp.root, backups[0] ?? "")} still holds the previous values, the old token among them`);
  });
});

describe("the runner and the first message", () => {
  const sameBot = () => baseEnv({ TELEGRAM_BOT_TOKEN: GOOD_TOKEN, TELEGRAM_CHAT_ID: "111" });

  it("the token the runner polls: the runner is stopped before detection and recreated with the new values", async () => {
    api.updates = [[], [privateMessage(30)]];
    const services = fakeServices();
    // r replace | token | a detect | y use | y arrived | y write | y enable
    const run = io(["r", GOOD_TOKEN, "a", "y", "y", "y", "y"]);
    expect(await setup([], run, sameBot(), services)).toBe(0);
    const stop = services.calls.indexOf("stop runner");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(services.calls.indexOf("recreate web,runner")).toBeGreaterThan(stop);
    expect(services.calls).not.toContain("start runner");
    expectNoSecret(run);
  });

  it("quitting after the runner was stopped starts it again, .env untouched", async () => {
    const services = fakeServices();
    // r replace | token | a detect -> nothing arrives | q quit
    const run = io(["r", GOOD_TOKEN, "a", "q"]);
    expect(await setup([], run, sameBot(), services)).toBe(0);
    expect(services.calls).toContain("stop runner");
    expect(services.calls[services.calls.length - 1]).toBe("start runner");
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("Ctrl-C while waiting for the message starts the runner again", async () => {
    const controller = new AbortController();
    const services = fakeServices();
    const run = io(["r", GOOD_TOKEN, "a"], { controller });
    const done = setup([], run, sameBot(), services);
    // abort once the wait has started
    for (let i = 0; i < 100 && !run.lines.some((line) => line.startsWith("Waiting up to")); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    // while the runner is down a further Ctrl-C must not end the command (scripts/setup.ts asks the guard)
    expect(heldInterruptNote()).toContain("Still bringing the services back");
    controller.abort();
    expect(await done).toBe(0);
    expect(services.calls[services.calls.length - 1]).toBe("start runner");
    expect(heldInterruptNote()).toBeNull();
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("a button press waiting for the stopped runner is never confirmed; the message after it is used", async () => {
    // already waiting: a button press (for the runner); then it is still there, and a new message follows it
    api.updates = [[buttonPress(50)], [buttonPress(50), privateMessage(51)]];
    const services = fakeServices();
    const run = io(["r", GOOD_TOKEN, "a", "y", "y", "y", "y"]);
    expect(await setup([], run, baseEnv({ TELEGRAM_BOT_TOKEN: GOOD_TOKEN, TELEGRAM_CHAT_ID: "111" }), services)).toBe(0);
    expect(run.lines.join("\n")).toContain("Received from Joe (private chat), chat id •••4242.");
    // no getUpdates ever confirmed update 50 (an offset above it would): the runner gets the press after its restart
    expect(api.polls.every((poll) => poll.offset === undefined || Number(poll.offset) <= 50)).toBe(true);
    // with the press at the head of the queue a long poll would return at once: it asks again without waiting
    expect(api.polls[1]?.timeout).toBe(0);
    expect(services.calls).toContain("stop runner");
  });

  it("messages ahead of a button press are confirmed, the press is not", async () => {
    api.updates = [[oldMessage(60), buttonPress(61)], [buttonPress(61), privateMessage(62)]];
    const run = io(["y", GOOD_TOKEN, "a", "y", "y", "y", "n"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(api.polls[1]?.offset).toBe(61);
    expect(api.polls.every((poll) => poll.offset === undefined || Number(poll.offset) <= 61)).toBe(true);
    expect(envText()).toContain("TELEGRAM_CHAT_ID=4242424242\n");
  });

  it("a message sent before the prompt is only offered when no new one came, clearly marked, and not taken on Enter", async () => {
    api.updates = [[oldMessage(70)]];
    // y start | token | a detect | Enter (= no) on the earlier chat | m type it | id | y arrived | y write | n enable
    const run = io(["y", GOOD_TOKEN, "a", "", "m", "12345", "y", "y", "n"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(run.errors.join("\n")).toContain("No new message arrived. A message was already waiting from before you were asked (sent 2023-11-14 22:13 UTC): Old (private chat), chat id •••3131.");
    expect(run.questions.some((q) => q.startsWith("Use this earlier chat anyway?") && q.includes("[n]"))).toBe(true);
    expect(envText()).toContain("TELEGRAM_CHAT_ID=12345\n");
  });

  it("the earlier message can still be taken on purpose", async () => {
    api.updates = [[oldMessage(71)]];
    const run = io(["y", GOOD_TOKEN, "a", "y", "y", "y", "n"]);
    expect(await setup([], run, baseEnv(), fakeServices())).toBe(0);
    expect(envText()).toContain("TELEGRAM_CHAT_ID=31313131\n");
  });

  it("another bot than the runner's: the runner keeps running", async () => {
    api.updates = [[], [privateMessage(40)]];
    const services = fakeServices();
    const run = io(["r", GOOD_TOKEN, "a", "y", "y", "y", "y"]);
    expect(await setup([], run, baseEnv({ TELEGRAM_BOT_TOKEN: OLD_TOKEN, TELEGRAM_CHAT_ID: "111" }), services)).toBe(0);
    expect(services.calls).not.toContain("stop runner");
  });
});

describe("an existing configuration", () => {
  const configured = () => baseEnv({ TELEGRAM_BOT_TOKEN: OLD_TOKEN, TELEGRAM_CHAT_ID: "5551234" });

  it("shows the bot and the masked chat id; k keeps everything", async () => {
    const services = fakeServices();
    const run = io(["k", "y"]);
    expect(await setup([], run, configured(), services)).toBe(0);
    expect(run.lines.join("\n")).toContain("Telegram is set up: bot @old_bot, chat •••1234.");
    expect(fs.existsSync(envFile)).toBe(false);
    expect(services.calls.filter((call) => call !== "ps")).toEqual([]);
    expect(reloadConfig("notify").telegram.enabled).toBe(true);
    expectNoSecret(run);
  });

  it("t sends a test message only", async () => {
    const run = io(["t", "y", "y"]);
    expect(await setup([], run, configured(), fakeServices())).toBe(0);
    expect(api.sent.map((m) => m.chat_id)).toEqual(["5551234"]);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("d removes the three keys (backup kept), switches the push off and restarts", async () => {
    fs.writeFileSync(envFile, `X=1\nTELEGRAM_BOT_TOKEN=${OLD_TOKEN}\nTELEGRAM_CHAT_ID=5551234\nTELEGRAM_ALLOWED_USER_IDS=1\n`);
    const services = fakeServices();
    const run = io(["d", "y"]);
    expect(await setup([], run, configured(), services)).toBe(0);
    expect(envText()).toBe("X=1\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\nTELEGRAM_ALLOWED_USER_IDS=\n");
    expect(reloadConfig("notify").telegram.enabled).toBe(false);
    expect(services.calls).toContain("recreate web,runner");
    expectNoSecret(run);
  });

  it("a refused custom Bot API host stops before any request", async () => {
    const env = configured();
    delete env.JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS;
    const run = io([]);
    expect(await setup([], run, env, fakeServices())).toBe(0);
    expect(run.errors.join("\n")).toContain("Not set up:");
    expect(api.calls).toEqual([]);
  });
});

describe("maskChatId", () => {
  it("keeps the sign and the last four digits", () => {
    expect(maskChatId("4242424242")).toBe("•••4242");
    expect(maskChatId("-1009876543210")).toBe("-•••3210");
    expect(maskChatId("123")).toBe("•••");
  });
});
