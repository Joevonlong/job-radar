// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import {
  ConfigError,
  ensureProfileFiles,
  hashConfigText,
  loadConfig,
  readProfileText,
  reloadConfig,
  resetConfigCache,
  setOnProfileSaved,
  writeConfig,
  type ProfileName,
} from "@/lib/config";

import { atomicWrite, withFileLock } from "@/lib/config/write";
import { freezeConfig, withConfigWriteLock, WRITE_LOCK_FILE } from "@/lib/config/write-lock";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => {
  setOnProfileSaved(null);
  vi.unstubAllEnvs();
  tmp.cleanup();
});

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), "utf8");

describe("writeConfig keeps factory defaults out of the user file", () => {
  /** A user file written by an older version: the keys the schema defaults are missing from it. */
  function userFileWithout(file: string, drop: (doc: Record<string, unknown>) => void): void {
    const doc = parse(read(tmp.configDir, file)) as Record<string, unknown>;
    drop(doc);
    fs.writeFileSync(path.join(tmp.configDir, file), stringify(doc));
    resetConfigCache();
  }

  it("a save does not add schema-default keys the file lacked (ai tasks, schedule backup)", async () => {
    userFileWithout("ai.yaml", (doc) => {
      delete (doc.tasks as Record<string, unknown>).salary_lookup;
    });
    userFileWithout("schedule.yaml", (doc) => {
      const backup = doc.backup as Record<string, unknown>;
      delete backup.config_archive;
      delete backup.max_age_hours;
    });
    const ai = loadConfig("ai");
    expect(ai.tasks.salary_lookup.order?.length).toBeGreaterThan(0);
    await writeConfig("ai", ai, { baseHash: hashConfigText(read(tmp.configDir, "ai.yaml")) });
    expect(read(tmp.configDir, "ai.yaml")).not.toContain("salary_lookup");

    const schedule = loadConfig("schedule");
    await writeConfig("schedule", { ...schedule, timezone: "Asia/Tokyo" });
    const saved = parse(read(tmp.configDir, "schedule.yaml")) as { timezone: string; backup: Record<string, unknown> };
    expect(saved.timezone).toBe("Asia/Tokyo");
    expect(saved.backup).not.toHaveProperty("config_archive");
    expect(saved.backup).not.toHaveProperty("max_age_hours");
  });

  it("a key the file lacked is written once its value differs from the default", async () => {
    userFileWithout("ai.yaml", (doc) => {
      delete (doc.tasks as Record<string, unknown>).salary_lookup;
    });
    const ai = loadConfig("ai");
    await writeConfig("ai", { ...ai, tasks: { ...ai.tasks, salary_lookup: { order: ["anthropic"] } } });
    expect((parse(read(tmp.configDir, "ai.yaml")) as { tasks: Record<string, unknown> }).tasks.salary_lookup).toEqual({ order: ["anthropic"] });
    expect(loadConfig("ai").tasks.salary_lookup.order).toEqual(["anthropic"]);
  });

  it("a key the file already had stays, even when the save leaves it at the default", async () => {
    userFileWithout("schedule.yaml", (doc) => {
      (doc.backup as Record<string, unknown>).max_age_hours = 30;
      delete (doc.backup as Record<string, unknown>).keep_system;
    });
    const before = parse(read(tmp.configDir, "schedule.yaml")) as { backup: Record<string, unknown> };
    expect(before.backup.max_age_hours).toBe(30);
    await writeConfig("schedule", loadConfig("schedule"));
    const after = parse(read(tmp.configDir, "schedule.yaml")) as { backup: Record<string, unknown> };
    expect(Object.keys(after.backup)).toEqual(Object.keys(before.backup));
  });

  it("keeps the user's own keys and values the form does not touch", async () => {
    userFileWithout("ai.yaml", (doc) => {
      delete (doc.tasks as Record<string, unknown>).salary_lookup;
      (doc.tasks as Record<string, unknown>).translate = { order: ["api"] };
    });
    const ai = loadConfig("ai");
    await writeConfig("ai", { ...ai, max_output_tokens: ai.max_output_tokens + 1 });
    const saved = parse(read(tmp.configDir, "ai.yaml")) as { tasks: { translate: unknown }; max_output_tokens: number };
    expect(saved.tasks.translate).toEqual({ order: ["api"] });
    expect(saved.max_output_tokens).toBe(ai.max_output_tokens + 1);
  });

  it("with no user file yet, the save starts from the shipped text and adds no schema-default keys", async () => {
    const empty = makeTempConfig({ user: "empty" });
    try {
      const shipped = parse(fs.readFileSync(path.join(empty.defaultsDir, "ai.yaml"), "utf8")) as { tasks: Record<string, unknown> };
      delete shipped.tasks.salary_lookup;
      fs.writeFileSync(path.join(empty.defaultsDir, "ai.yaml"), stringify(shipped));
      resetConfigCache();
      const ai = loadConfig("ai");
      await writeConfig("ai", ai);
      expect(fs.readFileSync(path.join(empty.configDir, "ai.yaml"), "utf8")).not.toContain("salary_lookup");
      expect(fs.statSync(path.join(empty.configDir, "ai.yaml")).mode & 0o777).toBe(0o600);
    } finally {
      empty.cleanup();
      tmp = makeTempConfig();
    }
  });
});

describe("writeConfig", () => {
  it("saving ai.yaml does not invent an empty tasks.breakdown", async () => {
    const ai = loadConfig("ai");
    expect(ai.tasks.breakdown).toEqual({});
    expect(read(tmp.configDir, "ai.yaml")).not.toMatch(/^\s+breakdown:/m);
    await writeConfig("ai", ai);
    expect(read(tmp.configDir, "ai.yaml")).not.toMatch(/^\s+breakdown:/m);
  });

  it("leaves the arrays it did not change as they were written", async () => {
    const notify = loadConfig("notify");
    const flowLines = read(tmp.configDir, "notify.yaml").split("\n").filter((line) => /^\s*[\w_]+: \[.*\]\s*(#.*)?$/.test(line));
    expect(flowLines.length).toBeGreaterThan(0);
    await writeConfig("notify", { ...notify, max_per_cycle: notify.max_per_cycle + 1 });
    const after = read(tmp.configDir, "notify.yaml").split("\n");
    for (const line of flowLines) expect(after).toContain(line);
  });

  it("writes the new value, keeps comments, and refreshes the cache", async () => {
    const before = read(tmp.configDir, "notify.yaml");
    const notify = loadConfig("notify");
    const returned = await writeConfig("notify", { ...notify, push_min_score: 82, quiet_hours: { ...notify.quiet_hours, start: "23:00" } });
    expect(returned.push_min_score).toBe(82);
    expect(loadConfig("notify").push_min_score).toBe(82);

    const after = read(tmp.configDir, "notify.yaml");
    // every comment line of the original is still there
    for (const line of before.split("\n").filter((l) => l.trim().startsWith("#"))) expect(after).toContain(line.trim());
    // inline comments survive
    expect(after).toContain("# 告警（通道熔断、预算、登录失效等）不受静默时段限制");
    expect(after).toContain("# M3 配好 bot 后再打开");
    expect(parse(after)).toMatchObject({ push_min_score: 82, quiet_hours: { start: "23:00", end: "07:00" } });

    resetConfigCache();
    expect(reloadConfig("notify").push_min_score).toBe(82);
  });

  it("keeps comments when lists grow, shrink and change", async () => {
    const search = loadConfig("search");
    await writeConfig("search", {
      ...search,
      locations: ["Berlin", "München", "Hamburg"],
      keyword_groups: { ...search.keyword_groups, german: ["KI Engineer"], extra: ["Prompt Engineer"] },
    });
    const text = read(tmp.configDir, "search.yaml");
    expect(text).toContain("# 工程类");
    expect(text).toContain("# 德语岗位名");
    expect(text).toContain("# 每个关键词组、每个城市最多取多少条");
    expect(parse(text)).toMatchObject({
      locations: ["Berlin", "München", "Hamburg"],
      keyword_groups: { german: ["KI Engineer"], extra: ["Prompt Engineer"] },
    });

    const shrunk = loadConfig("search");
    await writeConfig("search", { ...shrunk, locations: ["Berlin"] });
    expect((parse(read(tmp.configDir, "search.yaml")) as { locations: string[] }).locations).toEqual(["Berlin"]);
    expect(read(tmp.configDir, "search.yaml")).toContain("# 工程类");
  });

  it("round-trips: file written equals what loadConfig returns after a reload", async () => {
    const channels = loadConfig("channels");
    const first = channels.ats_boards[0];
    if (!first) throw new Error("no ats boards");
    const updated = { ...channels, ats_boards: [{ ...first, enabled: false }, ...channels.ats_boards.slice(1)] };
    await writeConfig("channels", updated);
    resetConfigCache();
    expect(loadConfig("channels")).toEqual(updated);
    const text = read(tmp.configDir, "sources.yaml");
    expect(text).toContain("# ATS 公司清单");
    expect(text).toContain("# 来源清单：");
  });

  it("rejects invalid values with field paths and leaves the file and cache untouched", async () => {
    const before = read(tmp.configDir, "ai.yaml");
    const ai = loadConfig("ai");
    const bad = { ...ai, monthly_api_budget_usd: -1, per_cycle_limit: 0 };
    const err = await writeConfig("ai", bad).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.path).sort()).toEqual(["monthly_api_budget_usd", "per_cycle_limit"]);
    expect(read(tmp.configDir, "ai.yaml")).toBe(before);
    expect(loadConfig("ai").monthly_api_budget_usd).toBe(10);
  });

  it("rejects unknown keys", async () => {
    const notify = loadConfig("notify");
    await expect(writeConfig("notify", { ...notify, surprise: true } as typeof notify)).rejects.toThrow(/unknown key/);
  });

  it("leaves no temp files behind (success and failure)", async () => {
    const notify = loadConfig("notify");
    await writeConfig("notify", { ...notify, max_per_cycle: 5 });
    await writeConfig("notify", { ...notify, max_per_cycle: -5 }).catch(() => undefined);
    // .backup/ holds the copy of the file before the save, not a leftover
    const leftovers = fs.readdirSync(tmp.configDir).filter((f) => f !== ".backup" && (f.endsWith(".tmp") || f.startsWith(".")));
    expect(leftovers).toEqual([]);
  });

  it("writes config files with mode 0600 (they can hold tokens), also when the file was 0644 before", async () => {
    const notify = loadConfig("notify");
    const file = path.join(tmp.configDir, "notify.yaml");
    fs.chmodSync(file, 0o644);
    await writeConfig("notify", { ...notify, max_per_cycle: 6 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps a copy of the file it overwrites in .backup/editor (a lost update can be taken back)", async () => {
    const notify = loadConfig("notify");
    const before = read(tmp.configDir, "notify.yaml");
    await writeConfig("notify", { ...notify, max_per_cycle: 8 });
    const root = path.join(tmp.configDir, ".backup", "editor");
    const copies = fs.readdirSync(root).map((dir) => path.join(root, dir, "notify.yaml")).filter((file) => fs.existsSync(file));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(copies[0] as string, "utf8")).toBe(before);
    expect(fs.statSync(copies[0] as string).mode & 0o777).toBe(0o600);
  });

  it("does not keep a copy when nothing changed", async () => {
    await writeConfig("notify", loadConfig("notify"));
    expect(fs.existsSync(path.join(tmp.configDir, ".backup"))).toBe(false);
  });

  it("baseHash: two saves opened on the same text race; the second one is refused as stale and changes nothing", async () => {
    const notify = loadConfig("notify");
    const opened = hashConfigText(read(tmp.configDir, "notify.yaml"));
    const results = await Promise.allSettled([
      writeConfig("notify", { ...notify, max_per_cycle: 5 }, { baseHash: opened }),
      writeConfig("notify", { ...notify, max_per_cycle: 6 }, { baseHash: opened }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const refused = results[1];
    expect(refused?.status === "rejected" && refused.reason instanceof ConfigError && refused.reason.kind).toBe("stale");
    expect(reloadConfig("notify").max_per_cycle).toBe(5);
    expect(fs.readdirSync(tmp.configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("baseHash: a file changed while the save waited for the lock is not overwritten", async () => {
    const notify = loadConfig("notify");
    const file = path.join(tmp.configDir, "notify.yaml");
    const opened = hashConfigText(read(tmp.configDir, "notify.yaml"));
    let pending: Promise<unknown> = Promise.resolve();
    await withFileLock(file, async () => {
      pending = writeConfig("notify", { ...notify, max_per_cycle: 9 }, { baseHash: opened }).catch((error: unknown) => error);
      // someone else saves while the lock is held
      fs.writeFileSync(file, `${read(tmp.configDir, "notify.yaml")}\n# edited elsewhere\n`);
    });
    const outcome: unknown = await pending;
    expect(outcome instanceof ConfigError && outcome.kind).toBe("stale");
    expect(read(tmp.configDir, "notify.yaml")).toContain("# edited elsewhere");
  });

  it("baseHash: the current hash saves; no baseHash (the setup wizard) always saves", async () => {
    const notify = loadConfig("notify");
    await writeConfig("notify", { ...notify, max_per_cycle: 4 }, { baseHash: hashConfigText(read(tmp.configDir, "notify.yaml")) });
    expect(reloadConfig("notify").max_per_cycle).toBe(4);
    await writeConfig("notify", { ...notify, max_per_cycle: 3 });
    expect(reloadConfig("notify").max_per_cycle).toBe(3);
  });

  it("replaces the file atomically (same directory temp + rename, old content never truncated)", async () => {
    const notify = loadConfig("notify");
    const file = path.join(tmp.configDir, "notify.yaml");
    const inode = fs.statSync(file).ino;
    await writeConfig("notify", { ...notify, max_per_cycle: 7 });
    // rename replaces the inode; an in-place truncating write would keep it
    expect(fs.statSync(file).ino).not.toBe(inode);
  });
});

describe("lists keep their comments with their entries", () => {
  /** A sources.yaml whose company list is exactly the text given (the rest comes from the shipped values, written without comments). */
  function withBoards(list: string): void {
    const { ats_boards: _ignored, ...rest } = loadConfig("channels");
    void _ignored;
    fs.writeFileSync(path.join(tmp.configDir, "sources.yaml"), `${stringify(rest)}\nats_boards:\n${list}`);
    resetConfigCache();
  }
  const board = (name: string): string => `  - { name: "${name}", ats: lever, token: "${name.toLowerCase()}", enabled: true }\n`;
  const lines = (): string[] => read(tmp.configDir, "sources.yaml").split("\n");

  it("deleting a company does not move the group comment of the companies after it", async () => {
    withBoards(`  # group one\n${board("A")}${board("B")}  # group two\n${board("C")}${board("D")}`);
    const current = loadConfig("channels");
    await writeConfig("channels", { ...current, ats_boards: current.ats_boards.filter((b) => b.name !== "B") });
    const at = (needle: string): number => lines().findIndex((line) => line.includes(needle));
    expect([at("# group one"), at('name: "A"'), at("# group two"), at('name: "C"'), at('name: "D"')]).toEqual([...Array(5).keys()].map((n) => at("# group one") + n));
    expect(at('name: "B"')).toBe(-1);
  });

  it("the group comment of a deleted first entry moves to the entry after it", async () => {
    withBoards(`  # group one\n${board("A")}${board("B")}`);
    const current = loadConfig("channels");
    await writeConfig("channels", { ...current, ats_boards: current.ats_boards.filter((b) => b.name !== "A") });
    const out = lines();
    expect(out.findIndex((line) => line.includes("# group one"))).toBe(out.findIndex((line) => line.includes('name: "B"')) - 1);
  });

  it("an edited entry keeps its comment, a new one in the middle gets none, and a reorder carries comments along", async () => {
    withBoards(`  # group one\n${board("A")}  # group two\n${board("C")}`);
    const current = loadConfig("channels");
    const [a, c] = current.ats_boards;
    if (!a || !c) throw new Error("fixture");
    await writeConfig("channels", { ...current, ats_boards: [{ ...a, enabled: false }, { name: "B", ats: "lever", token: "b", enabled: true }, c] });
    const out = lines();
    const at = (needle: string): number => out.findIndex((line) => line.includes(needle));
    expect(at("# group one")).toBe(at('name: "A"') - 1);
    expect(at("# group two")).toBe(at('name: "C"') - 1);
    expect(at('name: "B"')).toBeLessThan(at("# group two"));
    expect(out[at('name: "A"')]).toContain("enabled: false");
  });
});

describe("profile files", () => {
  it.each([
    { name: "me", frozen: false },
    { name: "preferences", frozen: false },
    { name: "me", frozen: true },
    { name: "preferences", frozen: true },
  ] as const)("first saves edit the $name template document and keep its comments: token-authorized=$frozen", async ({ name, frozen }) => {
    if (frozen) {
      const token = "1".repeat(32);
      await freezeConfig("a".repeat(40), token);
      vi.stubEnv("JOB_RADAR_UPGRADE_FREEZE_TOKEN", token);
    }
    const source = path.join(tmp.defaultsDir, "profile.example", `${name}.yaml`);
    const template = `# Keep this template header\n${fs.readFileSync(source, "utf8")}`;
    fs.writeFileSync(source, template);
    const value = name === "me" ? { ...loadConfig("me"), city: "Sample City" } : { ...loadConfig("preferences"), salary_floor_year: loadConfig("preferences").salary_floor_year + 1 };
    expect(fs.existsSync(path.join(tmp.profileDir, `${name}.yaml`))).toBe(false);

    await writeConfig(name, value, { baseHash: hashConfigText(readProfileText(name)) });

    const text = read(tmp.profileDir, `${name}.yaml`);
    for (const comment of template.split("\n").filter((line) => line.trim().startsWith("#"))) expect(text).toContain(comment.trim());
    for (const flow of template.split("\n").filter((line) => /^\s*[\w_]+: \[.*\]\s*(#.*)?$/.test(line))) expect(text).toContain(flow);
    expect(reloadConfig(name)).toEqual(value);
    expect(fs.readFileSync(source, "utf8")).toBe(template);
    expect(fs.statSync(path.join(tmp.profileDir, `${name}.yaml`)).mode & 0o777).toBe(0o600);
  });

  it("does not acquire a directory lock when every profile file already exists", async () => {
    await ensureProfileFiles();
    let entered = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = withConfigWriteLock(path.join(tmp.profileDir, "me.yaml"), async () => { entered(); await gate; });
    await ready;
    try {
      expect((await ensureProfileFiles()).every((r) => !r.created)).toBe(true);
    } finally { release(); await holding; }
  });

  it("releases the directory lock before waiting for the profile snapshot hook", async () => {
    await ensureProfileFiles();
    let entered = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lockedDuringHook = true;
    setOnProfileSaved(async () => {
      lockedDuringHook = fs.existsSync(path.join(tmp.profileDir, WRITE_LOCK_FILE));
      entered(); await gate;
    });
    const writing = writeConfig("me", { ...loadConfig("me"), summary: "Updated profile." });
    await ready;
    try {
      expect(lockedDuringHook).toBe(false);
      await atomicWrite(path.join(tmp.profileDir, "other.yaml"), "saved: true\n");
      expect(read(tmp.profileDir, "me.yaml")).toContain("Updated profile.");
    } finally { release(); await writing; }
  });

  it("ensureProfileFiles copies the templates and never overwrites", async () => {
    const first = await ensureProfileFiles();
    expect(first.map((r) => [r.name, r.created])).toEqual([
      ["me", true],
      ["preferences", true],
      ["stories", true],
    ]);
    expect(read(tmp.profileDir, "me.yaml")).toBe(read(path.join(tmp.defaultsDir, "profile.example"), "me.yaml"));

    fs.writeFileSync(path.join(tmp.profileDir, "me.yaml"), "# my own edits\n");
    const second = await ensureProfileFiles();
    expect(second.every((r) => !r.created)).toBe(true);
    expect(read(tmp.profileDir, "me.yaml")).toBe("# my own edits\n");
  });

  it("loads the copied profile and calls the onProfileSaved hook on write", async () => {
    await ensureProfileFiles();
    const calls: Array<{ kind: ProfileName; text: string }> = [];
    setOnProfileSaved(async (kind, text) => {
      calls.push({ kind, text });
    });

    const prefs = loadConfig("preferences");
    expect(prefs.salary_floor_year).toBe(70000);
    await writeConfig("preferences", { ...prefs, salary_floor_year: 75000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("preferences");
    expect(calls[0]?.text).toBe(read(tmp.profileDir, "preferences.yaml"));
    expect(calls[0]?.text).toContain("salary_floor_year: 75000");
    expect(calls[0]?.text).toContain("# 我要什么（模板）");

    const me = loadConfig("me");
    await writeConfig("me", { ...me, summary: "Short summary." });
    expect(calls.map((c) => c.kind)).toEqual(["preferences", "me"]);
  });

  it("an empty `[]` list that gains entries is written as a block list, one entry per line", async () => {
    const interests = loadConfig("interests");
    await writeConfig("interests", {
      ...interests,
      watched_companies: ["Acme", "Beta"],
      views: [{ id: "berlin", name: "Berlin", default: false, filters: { city: "Berlin", high: true } }],
    });
    const after = read(tmp.configDir, "interests.yaml");
    expect(after).toMatch(/\nwatched_companies:\n {2}- Acme\n {2}- Beta\n/);
    expect(after).toMatch(/\nviews:\n {2}- id: berlin\n/);
    expect(after).toContain("# 关注公司"); // the comment above the key stays
    expect(parse(after)).toMatchObject({ watched_companies: ["Acme", "Beta"], views: [{ id: "berlin", filters: { city: "Berlin", high: true } }] });
  });

  it("saving a view changes only that view: padded flow maps stay padded and defaulted empty keys are not added", async () => {
    const before = read(tmp.configDir, "interests.yaml");
    expect(before).toMatch(/rough_fx: \{ USD:/);
    const interests = loadConfig("interests");
    await writeConfig("interests", { ...interests, views: [...interests.views, { id: "uat", name: "UAT", default: false, filters: { q: "Berlin" } }] });
    const after = read(tmp.configDir, "interests.yaml");
    expect(after).toMatch(/rough_fx: \{ USD:/);
    expect(after).not.toMatch(/exclude: \[\]/);
    // everything outside the new view is byte-identical
    const unchanged = (text: string) => text.slice(0, text.indexOf("\nviews:"));
    expect(unchanged(after)).toBe(unchanged(before));
    expect(loadConfig("interests").views.at(-1)).toMatchObject({ id: "uat" });
  });

  it("does not call the hook for non-profile configs or for rejected writes", async () => {
    await ensureProfileFiles();
    let count = 0;
    setOnProfileSaved(async () => {
      count += 1;
    });
    const notify = loadConfig("notify");
    await writeConfig("notify", { ...notify, max_per_cycle: 3 });
    const me = loadConfig("me");
    await writeConfig("me", { ...me, years_experience: -1 }).catch(() => undefined);
    expect(count).toBe(0);
  });

  it("writes a profile file that does not exist yet (creating the directory)", async () => {
    const me = parse(read(path.join(tmp.defaultsDir, "profile.example"), "me.yaml")) as Parameters<typeof writeConfig<"me">>[1];
    await writeConfig("me", { ...me, city: "München" });
    expect(parse(read(tmp.profileDir, "me.yaml"))).toMatchObject({ city: "München" });
    expect(loadConfig("me").city).toBe("München");
  });
});
