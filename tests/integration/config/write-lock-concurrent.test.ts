import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { parse } from "yaml";

import { currentConfigVersion, hashConfigText, loadConfig, resetConfigCache } from "@/lib/config";
import { getTranslator } from "@/lib/i18n/node";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { createIsolatedDb, type IsolatedDb } from "../../helpers/isolated-db";
import { childEnv, connect, lockHolder, lockSessionsOf, makePause, NOTIFY_V1, prepareInstall, resultOf, setConfigValue, startScript, startWriter, stopChildren, textHash, waitForWaiter } from "./write-lock-helpers";

/**
 * Two writers in two processes on the real lock: one is stopped inside it, the other asks for it. `lock_wait_seconds` is
 * far longer than the test (unless the test is about running out of it).
 */
const URL_A = "https://a.example.com";
const URL_B = "https://b.example.com";

let iso: IsolatedDb;
let sql: Sql;
let temp: TempConfig;

const notify = (): string => path.join(temp.configDir, "notify.yaml");
const notifyText = (): string => fs.readFileSync(notify(), "utf8");
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => childEnv(temp, iso.url, extra);
const baseUrlOf = (text: string): unknown => (parse(text) as { public_base_url?: unknown }).public_base_url;
const versionOf = (text: string): unknown => (parse(text) as { config_version?: unknown }).config_version;
/** The v1 file with its public URL replaced: what the advanced editor would save over an old file (it wants the version written down). */
const v1With = (url: string): string => `config_version: 1\n${NOTIFY_V1.replace(/^public_base_url: .*$/m, `public_base_url: "${url}"`)}`;

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "lockpair");
  sql = connect(iso.url);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await iso?.drop();
});

beforeEach(() => {
  temp = makeTempConfig();
  prepareInstall(temp, 30);
  fs.writeFileSync(notify(), NOTIFY_V1);
  resetConfigCache();
});

afterEach(async () => {
  await stopChildren();
  temp.cleanup();
});

describe("two writers", { timeout: 60_000 }, () => {
  it("migrator first, then a form save: the save waits and is refused as stale against the migrated file", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const migrator = startScript("config-migrate.ts", ["--write"], env(pause.env));
    await pause.waitReached(migrator);
    const save = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: textHash(temp, "notify.yaml") }, env());
    await waitForWaiter(sql, save);
    await sleep(300);
    expect(save.proc.exitCode).toBeNull();
    expect(notifyText()).toBe(NOTIFY_V1);

    pause.go();
    expect(await migrator.exited).toBe(0);
    expect(await resultOf(save)).toMatchObject({ status: "error", kind: "stale" });
    expect(versionOf(notifyText())).toBe(currentConfigVersion("notify"));
    expect(baseUrlOf(notifyText())).toBe(baseUrlOf(NOTIFY_V1));
  });

  it("form save first, then the migrator: it plans again in the lock and leaves the saved file alone", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const save = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: textHash(temp, "notify.yaml") }, env(pause.env));
    await pause.waitReached(save);
    const migrator = startScript("config-migrate.ts", ["--write"], env());
    await waitForWaiter(sql, migrator);
    expect(notifyText()).toBe(NOTIFY_V1);

    pause.go();
    expect(await resultOf(save)).toEqual({ status: "saved" });
    const saved = notifyText();
    expect(baseUrlOf(saved)).toBe(URL_A);
    expect(await migrator.exited).toBe(0);
    expect(migrator.output()).toContain("left alone");
    expect(notifyText()).toBe(saved);
  });

  it("migrator first, then the editor: the editor waits and is refused as stale", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const migrator = startScript("config-migrate.ts", ["--write"], env(pause.env));
    await pause.waitReached(migrator);
    const editor = startWriter({ op: "edit", name: "notify", text: v1With(URL_A), baseHash: hashConfigText(NOTIFY_V1), baseLayer: "user" }, env());
    await waitForWaiter(sql, editor);
    pause.go();
    expect(await migrator.exited).toBe(0);
    expect(await resultOf(editor)).toMatchObject({ status: "error", kind: "stale" });
    expect(baseUrlOf(notifyText())).toBe(baseUrlOf(NOTIFY_V1));
    expect(versionOf(notifyText())).toBe(currentConfigVersion("notify"));
  });

  it("editor first, then the migrator: the migrator's new plan in the lock includes the editor's change", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const editor = startWriter({ op: "edit", name: "notify", text: v1With(URL_A), baseHash: hashConfigText(NOTIFY_V1), baseLayer: "user" }, env(pause.env));
    await pause.waitReached(editor);
    const migrator = startScript("config-migrate.ts", ["--write"], env());
    await waitForWaiter(sql, migrator);
    pause.go();
    expect(await resultOf(editor)).toEqual({ status: "saved" });
    expect(await migrator.exited).toBe(0);
    expect(baseUrlOf(notifyText())).toBe(URL_A);
    expect(versionOf(notifyText())).toBe(currentConfigVersion("notify"));
    resetConfigCache();
    expect(loadConfig("notify").public_base_url).toBe(URL_A);
    // the backup holds the editor's text: what the migrator really replaced
    const backups = fs.readdirSync(path.join(temp.configDir, ".backup")).filter((name) => name !== "editor");
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(temp.configDir, ".backup", backups[0] ?? "", "notify.yaml"), "utf8")).toBe(v1With(URL_A));
  });

  it("two migrators: the second waits, then has nothing left to write", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const first = startScript("config-migrate.ts", ["--write"], env(pause.env));
    await pause.waitReached(first);
    const second = startScript("config-migrate.ts", ["--write"], env());
    await waitForWaiter(sql, second);
    pause.go();
    expect(await first.exited).toBe(0);
    const migrated = notifyText();
    expect(versionOf(migrated)).toBe(currentConfigVersion("notify"));
    expect(await second.exited).toBe(0);
    expect(second.output()).toContain("left alone");
    expect(notifyText()).toBe(migrated);
    expect(fs.readdirSync(path.join(temp.configDir, ".backup")).filter((name) => name !== "editor")).toHaveLength(1);
  });

  it("two form saves from the same base: the second is refused as stale", async () => {
    const base = textHash(temp, "notify.yaml");
    const pause = makePause(temp.root, "after-hash-check");
    const first = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: base }, env(pause.env));
    await pause.waitReached(first);
    const second = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_B }, baseHash: base }, env());
    await waitForWaiter(sql, second);
    pause.go();
    expect(await resultOf(first)).toEqual({ status: "saved" });
    expect(await resultOf(second)).toMatchObject({ status: "error", kind: "stale" });
    expect(baseUrlOf(notifyText())).toBe(URL_A);
  });

  it("the lock is one for all files: a save of another file waits as well", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const first = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: textHash(temp, "notify.yaml") }, env(pause.env));
    await pause.waitReached(first);
    const other = startWriter({ op: "save", name: "search", patch: { locations: ["Lock Town"] } }, env());
    await waitForWaiter(sql, other);
    pause.go();
    expect(await resultOf(first)).toEqual({ status: "saved" });
    expect(await resultOf(other)).toEqual({ status: "saved" });
  });
});

describe("waiting longer than lock_wait_seconds", { timeout: 60_000 }, () => {
  beforeEach(() => {
    setConfigValue(temp, "schedule.yaml", ["config_writes"], { backups_keep: 5, lock_wait_seconds: 2 });
    resetConfigCache();
  });

  it("a form save, the editor and the commands report busy and name the holder; the files stay as they were", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const holder = startWriter({ op: "edit", name: "notify", text: v1With(URL_A), baseHash: hashConfigText(NOTIFY_V1), baseLayer: "user" }, env(pause.env));
    await pause.waitReached(holder);
    const named = `job-radar config-write pid=${holder.pid} host=`;
    expect(await lockHolder(sql)).toBe((await lockSessionsOf(sql, holder.pid))[0]);

    const searchBefore = fs.readFileSync(path.join(temp.configDir, "search.yaml"), "utf8");
    fs.rmSync(path.join(temp.configDir, "resume.yaml"));
    const started = Date.now();
    const [save, editor, migrate, init] = [
      startWriter({ op: "save", name: "search", patch: { locations: ["Lock Town"] } }, env()),
      startWriter({ op: "edit", name: "search", text: `${searchBefore}\n# edited\n`, baseHash: hashConfigText(searchBefore), baseLayer: "user" }, env()),
      startScript("config-migrate.ts", ["--write"], env()),
      startScript("config-init.ts", [], env()),
    ];

    const saved = await resultOf(save);
    expect(saved).toMatchObject({ status: "error", kind: "busy" });
    expect(saved.detail).toContain(named);
    const edited = await resultOf(editor);
    expect(edited).toMatchObject({ status: "error", kind: "busy" });
    expect(edited.detail).toContain(named);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);

    const t = getTranslator("configOps", "cli");
    expect(await migrate.exited).toBe(2);
    expect(migrate.output()).toContain(named);
    expect(migrate.output()).toContain(t("busy", { holder: named }).split(named)[0]);
    expect(await init.exited).toBe(1);
    expect(init.output()).toContain(named);

    expect(notifyText()).toBe(NOTIFY_V1);
    expect(fs.readFileSync(path.join(temp.configDir, "search.yaml"), "utf8")).toBe(searchBefore);
    expect(fs.existsSync(path.join(temp.configDir, "resume.yaml"))).toBe(false);
    // no migrator's backup of a file it never got to write (the holder's own editor backup is in .backup/editor)
    expect(fs.readdirSync(path.join(temp.configDir, ".backup")).filter((name) => name !== "editor")).toEqual([]);

    pause.go();
    expect(await resultOf(holder)).toEqual({ status: "saved" });
    expect(baseUrlOf(notifyText())).toBe(URL_A);
  });
});

describe("config:init and a save that creates the same missing file", { timeout: 60_000 }, () => {
  const shippedText = (): string => fs.readFileSync(path.join(temp.defaultsDir, "notify.yaml"), "utf8");

  beforeEach(() => {
    fs.rmSync(notify());
    resetConfigCache();
  });

  it("init first: a save opened on the default is refused as stale, init's copy stays", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const init = startScript("config-init.ts", [], env(pause.env));
    await pause.waitReached(init);
    const editor = startWriter({ op: "edit", name: "notify", text: `${shippedText()}\n# edited\n`, baseHash: hashConfigText(shippedText()), baseLayer: "default" }, env());
    await waitForWaiter(sql, editor);
    expect(fs.existsSync(notify())).toBe(false);
    pause.go();
    expect(await init.exited).toBe(0);
    expect(await resultOf(editor)).toMatchObject({ status: "error", kind: "stale" });
    expect(notifyText()).toBe(shippedText());
  });

  it("the save first: init waits and does not overwrite what the save wrote", async () => {
    const text = `${shippedText()}\n# edited\n`;
    const pause = makePause(temp.root, "after-hash-check");
    const editor = startWriter({ op: "edit", name: "notify", text, baseHash: hashConfigText(shippedText()), baseLayer: "default" }, env(pause.env));
    await pause.waitReached(editor);
    const init = startScript("config-init.ts", [], env());
    await waitForWaiter(sql, init);
    pause.go();
    expect(await resultOf(editor)).toEqual({ status: "saved" });
    expect(await init.exited).toBe(0);
    expect(notifyText()).toBe(text);
  });
});
