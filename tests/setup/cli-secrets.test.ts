// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfigPath, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { parseAnswers } from "@/lib/setup/answers";
import { runSetupCli, type CliIo } from "@/lib/setup/cli";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { saveSourcesStep } from "@/lib/setup/steps/sources";
import { saveTelegramStep } from "@/lib/setup/steps/telegram";
import { loadSetupView } from "@/lib/setup/view";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const ANSWERS = path.resolve(import.meta.dirname, "../fixtures/setup/answers.yaml");
/** Fake secrets: none of them may ever show up in a page view, an action result or the command's output. */
const SECRETS = {
  TELEGRAM_BOT_TOKEN: "123456:FAKE-telegram-secret",
  TELEGRAM_CHAT_ID: "987654321",
  ANTHROPIC_API_KEY: "sk-ant-FAKE-anthropic-secret",
  DEEPSEEK_API_KEY: "sk-FAKE-deepseek-secret",
  JSEARCH_API_KEY: "FAKE-jsearch-secret",
  GMAIL_APP_PASSWORD: "FAKE-gmail-app-password",
} as const;

let tmp: TempConfig;
const saved = new Map<string, string | undefined>();

function io(answers: readonly string[] = []): CliIo & { lines: string[]; errors: string[] } {
  const queue = [...answers];
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    ask: async (question) => {
      lines.push(question);
      return queue.length > 0 ? (queue.shift() ?? "") : null;
    },
  };
}

beforeEach(() => {
  for (const key of [...Object.keys(SECRETS), "DATABASE_URL"]) saved.set(key, process.env[key]);
  Object.assign(process.env, SECRETS);
  // a port nothing listens on: the command runs without a database, as on a host before `docker compose up`
  process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
  tmp = makeTempConfig({ user: "empty" });
  resetSetupStateCache();
});
afterEach(() => {
  setOnProfileSaved(null);
  tmp.cleanup();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function expectNoSecret(text: string): void {
  for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
}

describe("secrets never leave the server", () => {
  it("the page view names the variables and says whether they are set, nothing more", async () => {
    const view = await loadSetupView({ locale: "en", acceptLanguage: null });
    const json = JSON.stringify(view);
    expectNoSecret(json);
    expect(view.telegram.status.env.slice(0, 2)).toEqual([
      { name: "TELEGRAM_BOT_TOKEN", present: true },
      { name: "TELEGRAM_CHAT_ID", present: true },
    ]);
    expect(view.telegram.status.env.map((e) => e.name)).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS"]);
    expect(view.telegram.status.command).toBe("pnpm run setup --step telegram");
    expect(view.ai.providers.find((p) => p.id === "anthropic")?.key).toEqual({ name: "ANTHROPIC_API_KEY", present: true });
    expect(view.ai.providers.find((p) => p.id === "mimo")?.key).toEqual({ name: "MIMO_API_KEY", present: process.env.MIMO_API_KEY !== undefined && process.env.MIMO_API_KEY.trim() !== "" });
    expect(json).toContain("JSEARCH_API_KEY");
  });

  it("step results carry no value", async () => {
    expectNoSecret(JSON.stringify(await saveTelegramStep({ enabled: true })));
    expectNoSecret(JSON.stringify(await saveSourcesStep({ channels: { jsearch: true }, boards: [] })));
  });

  it("pnpm run setup --status --json lists states and names only", async () => {
    const out = io();
    expect(await runSetupCli(["--status", "--json", "--lang", "en"], out)).toBe(0);
    const text = out.lines.join("\n");
    expectNoSecret(text);
    const report = JSON.parse(text) as { pending: boolean; steps: Record<string, string | null>; readiness: Array<{ id: string; status: string }> };
    expect(report.pending).toBe(true);
    expect(Object.keys(report.steps)).toEqual(["language", "market", "profile", "targets", "sources", "ai", "telegram", "review"]);
    expect(report.readiness.map((r) => r.id)).toEqual(["profile", "channels", "ai", "runner", "aiWorker"]);
  });
});

describe("pnpm run setup --status", () => {
  const files = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

  it("is read-only: a fresh install gets no config or profile file written", async () => {
    expect(files(tmp.configDir)).toEqual([]);
    expect(files(tmp.profileDir)).toEqual([]);
    for (const args of [["--status"], ["--status", "--json"]]) {
      expect(await runSetupCli(args, io())).toBe(0);
      expect(files(tmp.configDir)).toEqual([]);
      expect(files(tmp.profileDir)).toEqual([]);
    }
  });
});

describe("pnpm run setup", () => {
  it("--answers on an empty directory writes every step and completes the setup", async () => {
    const out = io();
    expect(await runSetupCli(["--answers", ANSWERS, "--lang", "en"], out)).toBe(0);
    expectNoSecret([...out.lines, ...out.errors].join("\n"));
    expect(out.lines).toContain("Setup marked complete.");
    const status = readSetupState();
    expect(status).toMatchObject({ pending: false, state: { completed_by: "cli" } });
    expect(Object.values(status.state?.steps ?? {}).every((s) => s?.status === "done")).toBe(true);
    expect(reloadConfig("preferences")).toMatchObject({ market: { pack: "generic", country: "NL" }, locations: ["Amsterdam", "Utrecht"], target_titles: ["Machine Learning Engineer", "Data Engineer"], salary_floor_year: 65000 });
    expect(reloadConfig("me")).toMatchObject({ summary: "Backend engineer moving into applied machine learning.", years_experience: 7, languages: [{ en: "C1" }, { nl: "A2" }] });
    expect(reloadConfig("search").keyword_groups).toEqual({ targets: ["Machine Learning Engineer", "Data Engineer"] });
    expect(reloadConfig("schedule").timezone).toBe("Europe/Amsterdam");
    expect(reloadConfig("channels").ats_boards.some((b) => b.token === "exampleco")).toBe(true);
    expect(reloadConfig("ai").order).toEqual(["claude-cli", "codex-cli", "api"]);
    expect(reloadConfig("notify").telegram.enabled).toBe(false);
  });

  it("--step runs one step only; a missing section is recorded as skipped", async () => {
    const out = io();
    expect(await runSetupCli(["--answers", ANSWERS, "--step", "market"], out)).toBe(0);
    expect(readSetupState()).toMatchObject({ pending: true, state: { steps: { market: { status: "done" } } } });
    const partial = path.join(tmp.root, "partial.yaml");
    fs.writeFileSync(partial, "language: { ui_locale: zh }\nfinish: { complete: false }\n");
    expect(await runSetupCli(["--answers", partial], io())).toBe(0);
    const steps = readSetupState().state?.steps;
    expect(steps?.language?.status).toBe("done");
    expect(steps?.ai?.status).toBe("skipped");
    expect(readSetupState().pending).toBe(true);
  });

  it("an invalid answers file is refused with the problem, nothing written", async () => {
    const bad = path.join(tmp.root, "bad.yaml");
    fs.writeFileSync(bad, "market: { pack: generic, timezone: 5 }\nsurprise: true\n");
    const out = io();
    expect(await runSetupCli(["--answers", bad, "--lang", "en"], out)).toBe(2);
    expect(out.errors[0]).toBe("The answers file is not valid:");
    expect(out.errors.join("\n")).toMatch(/surprise|market\.timezone/);
    expect(readSetupState().state?.steps ?? {}).toEqual({});
  });

  it("a step that fails is reported with its field and the setup is not completed", async () => {
    const bad = path.join(tmp.root, "bad-zone.yaml");
    fs.writeFileSync(bad, "market: { pack: generic, country: NL, currency: EUR, home_language: nl, locations: [Amsterdam], timezone: Mars/Olympus }\n");
    const out = io();
    expect(await runSetupCli(["--answers", bad, "--lang", "en"], out)).toBe(1);
    expect(out.errors.join("\n")).toContain("timezone: Not a known time zone");
    expect(readSetupState().pending).toBe(true);
  });

  it("--complete marks the setup done without changing any configuration", async () => {
    const before = fs.readFileSync(path.join(tmp.defaultsDir, "ai.yaml"), "utf8");
    const out = io();
    expect(await runSetupCli(["--complete", "--lang", "en"], out)).toBe(0);
    expect(out.lines).toContain("Setup marked complete.");
    expect(readSetupState()).toMatchObject({ pending: false, state: { completed_by: "cli" } });
    expect(fs.readFileSync(getConfigPath("ai"), "utf8")).toBe(before);
  });

  it("interactive: Enter keeps the shown value, the answers are saved, Chinese with --lang zh", async () => {
    const out = io(["en", "", "", "y"]);
    expect(await runSetupCli(["--step", "language", "--lang", "zh"], out)).toBe(0);
    expect(out.lines.join("\n")).toContain("界面语言");
    expect(out.lines).toContain("已保存。");
    expect(readSetupState().state?.steps.language?.status).toBe("done");
  });

  it("interactive: s skips, the end of the input stops without an error", async () => {
    // Telegram is configured (fake values): the step shows it and offers keep / replace / test / remove / skip. The Bot API
    // is not reachable here; the failure is reported without the token.
    const offline = async (): Promise<never> => {
      throw new TypeError("fetch failed");
    };
    const skip = io(["s"]);
    expect(await runSetupCli(["--step", "telegram", "--lang", "en"], skip, process.env, { telegram: { fetch: offline, services: null, envFile: path.join(tmp.root, ".env") } })).toBe(0);
    expect(readSetupState().state?.steps.telegram?.status).toBe("skipped");
    expect(skip.lines.join("\n")).toContain("Could not reach api.telegram.org");
    expectNoSecret([...skip.lines, ...skip.errors].join("\n"));
    const end = io([]);
    expect(await runSetupCli(["--step", "ai", "--lang", "en"], end)).toBe(0);
    expect(end.lines.join("\n")).toContain("Stopped.");
  });

  it("bad arguments and unknown steps exit with 2", async () => {
    expect(await runSetupCli(["--nope"], io())).toBe(2);
    expect(await runSetupCli(["--step", "dance"], io())).toBe(2);
  });
});

describe("the answers file", () => {
  it("the shipped example parses", () => {
    expect(parseAnswers(parse(fs.readFileSync(ANSWERS, "utf8"))).ok).toBe(true);
  });

  it("is strict about unknown keys and values", () => {
    expect(parseAnswers({ telegram: { enabled: "yes" } }).ok).toBe(false);
    expect(parseAnswers({ targets: { seniority: "guru" } }).ok).toBe(false);
    expect(parseAnswers({ ai: { providers: { gpt: { enabled: true } } } }).ok).toBe(false);
    expect(parseAnswers(null)).toMatchObject({ ok: true, answers: { finish: { complete: true, run_first_cycle: false } } });
  });
});
