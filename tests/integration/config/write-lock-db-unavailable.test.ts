import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";

import { ConfigError, layeredConfigFingerprint, loadConfig, resetConfigCache, withFileLock, withConfigWriteLock, writeConfig, writeConfigText } from "@/lib/config";
import { acquireConfigWriteLock, DbUnavailable } from "@/lib/db/config-write-lock";
import { getTranslator } from "@/lib/i18n/node";
import { saveProfile } from "@/lib/profile/service";
import { preferencesConfigToDraft } from "@/lib/profile/draft";
import { ensurePendingSetupFile, markStep, resetSetupStateCache } from "@/lib/setup/state";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { childEnv, NOTIFY_V1, prepareInstall, REPO, resultOf, runScript, startWriter, stopChildren, textHash } from "./write-lock-helpers";

/** No database: nothing is written, and each caller says so in its own way. */
const UNREACHABLE = "postgres://nobody:secretpw@127.0.0.1:1/jobradar_test_unreachable";

let temp: TempConfig;
let savedUrl: string | undefined;

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      out[path.relative(dir, file)] = fs.readFileSync(file, "utf8");
    }
  }
  return out;
}
const everything = (): Record<string, Record<string, string>> => ({ config: snapshot(temp.configDir), profile: snapshot(temp.profileDir) });

beforeEach(() => {
  temp = makeTempConfig();
  prepareInstall(temp, 2);
  savedUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = UNREACHABLE;
  resetConfigCache();
  resetSetupStateCache();
});

afterEach(async () => {
  await stopChildren();
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  temp.cleanup();
});

describe("the lock client", { timeout: 60_000 }, () => {
  it("connection refused: DbUnavailable, with no URL in the message", async () => {
    const error = await acquireConfigWriteLock(UNREACHABLE, { waitSeconds: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbUnavailable);
    expect(String((error as Error).message)).not.toContain("secretpw");
  });

  it("a wrong password on a server that answers: DbUnavailable", async () => {
    const url = new URL(inject("testDatabaseUrl"));
    url.username = "nobody_at_all";
    url.password = "secretpw";
    await expect(acquireConfigWriteLock(url.toString(), { waitSeconds: 1 })).rejects.toBeInstanceOf(DbUnavailable);
  });
});

describe("saves in the web", { timeout: 60_000 }, () => {
  it("writeConfig, the editor, the wizard's setup file and its step mark: db_unavailable, files untouched", async () => {
    const before = everything();
    const kindOf = async (work: () => Promise<unknown>): Promise<string> => {
      const error = await work().then(() => null, (e: unknown) => e);
      return error instanceof ConfigError ? error.kind : String(error);
    };
    expect(await kindOf(() => writeConfig("notify", { ...loadConfig("notify"), public_base_url: "https://a.example.com" }))).toBe("db_unavailable");
    const text = fs.readFileSync(path.join(temp.configDir, "search.yaml"), "utf8");
    expect(await kindOf(() => writeConfigText("search", `${text}\n# edited\n`, { baseHash: layeredConfigFingerprint("search"), baseLayer: "user", maxBytes: 1_000_000, backupsKeep: 5 }))).toBe("db_unavailable");
    expect(await kindOf(() => withFileLock(path.join(temp.configDir, "x.yaml"), () => withConfigWriteLock(async () => 1)))).toBe("db_unavailable");
    expect(await ensurePendingSetupFile()).toEqual({ ok: false, formError: "dbUnavailable" });
    expect(await markStep("market", "done")).toEqual({ ok: false, reason: "db_unavailable" });
    expect(await saveProfile("preferences", preferencesConfigToDraft(loadConfig("preferences")))).toMatchObject({ status: "error", formError: "dbUnavailable" });
    expect(everything()).toEqual(before);
  });

  it("the same in a process of its own", async () => {
    const before = everything();
    const save = startWriter({ op: "save", name: "notify", patch: { public_base_url: "https://a.example.com" }, baseHash: textHash(temp, "notify.yaml") }, childEnv(temp, UNREACHABLE));
    expect(await resultOf(save)).toMatchObject({ status: "error", kind: "db_unavailable" });
    expect(everything()).toEqual(before);
  });
});

describe("host commands", { timeout: 60_000 }, () => {
  it("config:migrate --write exits 1 with the hint and writes nothing; the preview still works without the database", () => {
    fs.writeFileSync(path.join(temp.configDir, "notify.yaml"), NOTIFY_V1);
    const before = everything();
    const env = childEnv(temp, UNREACHABLE);
    const write = runScript("config-migrate.ts", ["--write"], env);
    expect(write.status).toBe(1);
    expect(write.out).toContain(getTranslator("configOps", "cli")("dbRequired"));
    expect(write.out).not.toContain("secretpw");
    expect(everything()).toEqual(before);
    const preview = runScript("config-migrate.ts", [], env);
    expect(preview.status).toBe(0);
    expect(preview.out).toContain("notify.yaml");
    expect(everything()).toEqual(before);
  });

  it("config:init exits 1 with the hint, no file appears; nothing missing needs no database", () => {
    fs.rmSync(path.join(temp.configDir, "notify.yaml"));
    const before = everything();
    const env = childEnv(temp, UNREACHABLE);
    const init = runScript("config-init.ts", [], env);
    expect(init.status).toBe(1);
    expect(init.out).toContain(getTranslator("configOps", "cli")("dbRequired"));
    expect(init.out).not.toContain("secretpw");
    expect(everything()).toEqual(before);

    fs.copyFileSync(path.join(temp.defaultsDir, "notify.yaml"), path.join(temp.configDir, "notify.yaml"));
    expect(runScript("config-init.ts", [], env).status).toBe(0);
  });

  it("config:init --env-only writes only .env, without a database", () => {
    // a disposable app: the command looks for compose.yaml and .env next to its own package.json
    const output = path.join(temp.root, "scripts/config-init.mjs");
    fs.writeFileSync(path.join(temp.root, "package.json"), '{"name":"job-radar","type":"module"}');
    fs.writeFileSync(path.join(temp.root, "compose.yaml"), "services: {}\n");
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(temp.root, "node_modules"), "dir");
    buildSync({ entryPoints: [path.join(REPO, "scripts/config-init.ts")], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: path.join(REPO, "tsconfig.json") });
    // the only thing it asks Docker: is there a database volume yet?
    const bin = path.join(temp.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), '#!/bin/sh\necho "Error: No such volume" >&2\nexit 1\n', { mode: 0o755 });
    fs.rmSync(path.join(temp.configDir, "notify.yaml"));
    const before = everything();
    const env = childEnv(temp, "");
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, [output, "--env-only"], { cwd: temp.root, env: { ...env, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(everything()).toEqual(before);
    expect(fs.readFileSync(path.join(temp.root, ".env"), "utf8")).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]+$/m);
  });
});
