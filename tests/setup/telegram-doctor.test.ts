// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RunCommandOptions } from "@/lib/ops/doctor/probes";
import { doctorChildEnv, telegramDoctor } from "@/lib/setup/cli";

const OLD = { TELEGRAM_BOT_TOKEN: "654321:FAKE-old-doctor-token", TELEGRAM_CHAT_ID: "5551234", TELEGRAM_ALLOWED_USER_IDS: "42" };

describe("the doctor after writing .env", () => {
  it("runs without the Telegram keys this process loaded from the old .env, so the child reads the new one", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin", COMPOSE_PROJECT_NAME: "radar", ...OLD };
    let seen: RunCommandOptions | undefined;
    let argv: readonly string[] = [];
    const lines = await telegramDoctor("en", 1000, env, async (_command, args, _timeoutMs, options) => {
      seen = options;
      argv = args;
      return { kind: "ran", exitCode: 0, stdout: JSON.stringify({ results: [{ status: "ok", title: "Telegram", detail: "set" }] }), stderr: "" };
    });
    expect(lines).toEqual([{ status: "ok", title: "Telegram", detail: "set" }]);
    expect(argv).toContain("--env-file-if-exists=.env");
    expect(seen?.env).toEqual({ NODE_ENV: "test", PATH: "/usr/bin", COMPOSE_PROJECT_NAME: "radar" });
    // empty values count as set for --env-file-if-exists too: they go as well
    expect(Object.keys(doctorChildEnv({ NODE_ENV: "test", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }))).toEqual(["NODE_ENV"]);
    // the setup's own environment is left as it was
    expect(env.TELEGRAM_BOT_TOKEN).toBe(OLD.TELEGRAM_BOT_TOKEN);
  });

  it("an unreadable answer is no result", async () => {
    expect(await telegramDoctor("en", 1000, { NODE_ENV: "test" }, async () => ({ kind: "ran", exitCode: 1, stdout: "not json", stderr: "" }))).toBeNull();
    expect(await telegramDoctor("en", 1000, { NODE_ENV: "test" }, async () => ({ kind: "missing" }))).toBeNull();
  });
});
