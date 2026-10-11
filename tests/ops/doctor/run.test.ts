// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ALL_CHECKS, checkTitle, renderJson, renderText, runDoctor, selectChecks, SkipCheck, type DoctorCheck } from "@/lib/ops/doctor";

import { GROUPS, makeContext, NOW } from "./helpers";

describe("runDoctor on a healthy system", () => {
  it("reports every check ok and exits 0", async () => {
    const report = await runDoctor(makeContext());
    const problems = report.checks.filter((c) => c.status !== "ok");
    expect(problems).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.worst).toBe("ok");
    expect(report.summary).toEqual({ ok: report.checks.length, warn: 0, fail: 0 });
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it("has unique result ids and groups, and covers every item of the spec", async () => {
    const report = await runDoctor(makeContext());
    const ids = report.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "docker.daemon", "compose.db", "compose.web", "compose.runner", "compose.jobspy", "web.http", "db.connect", "db.migrations",
      "runner.heartbeat", "aiworker.launchd", "aiworker.heartbeat", "ai.claude", "ai.codex", "telegram.credentials", "telegram.allowed_users", "telegram.enabled",
      "network.public_url", "tailscale.status", "tailscale.serve", "backup.recent", "disk.backups", "channels.linkedin", "budget.paid",
      "cycle.last", "cycle.next", "ai.backlog", "ai.profile", "host.power",
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(report.checks.every((c) => GROUPS.includes(c.group))).toBe(true);
    // sorted by group in display order
    const positions = report.checks.map((c) => GROUPS.indexOf(c.group));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("the shipped check list has no duplicate ids", () => {
    const ids = ALL_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("makes the shared reads once (docker, sources, claude)", async () => {
    const ctx = makeContext();
    await runDoctor(ctx);
    const calls = ctx.probes.run.mock.calls.map((c) => [c[0], ...c[1]].join(" "));
    expect(calls.filter((c) => c.startsWith("docker compose")).length).toBe(1);
    expect(calls.filter((c) => c === "claude auth status").length).toBe(1);
    expect(calls.filter((c) => c === "tailscale status --json").length).toBe(1);
    expect(ctx.probes.sources).toHaveBeenCalledTimes(1);
    expect(ctx.probes.dbPing).toHaveBeenCalledTimes(1);
  });
});

describe("runDoctor exit codes", () => {
  const warnCheck: DoctorCheck = { id: "t.warn", group: "host", run: async () => ({ id: "t.warn", group: "host", title: "t", status: "warn", detail: "d", hint: "h" }) };
  const failCheck: DoctorCheck = { id: "t.fail", group: "host", run: async () => ({ id: "t.fail", group: "host", title: "t", status: "fail", detail: "d", hint: "h" }) };
  const okCheck: DoctorCheck = { id: "t.ok", group: "host", run: async () => ({ id: "t.ok", group: "host", title: "t", status: "ok", detail: "d" }) };

  it("is the worst result: 0 ok, 1 warn, 2 fail", async () => {
    const ctx = makeContext();
    expect((await runDoctor(ctx, [okCheck])).exitCode).toBe(0);
    expect((await runDoctor(ctx, [okCheck, warnCheck])).exitCode).toBe(1);
    expect((await runDoctor(ctx, [warnCheck, failCheck, okCheck])).exitCode).toBe(2);
  });

  it("turns a throwing check into a failure and keeps going", async () => {
    const boom: DoctorCheck = { id: "t.boom", group: "host", run: async () => { throw new Error("connect failed for postgres://user:secret@127.0.0.1:5433/db"); } };
    const report = await runDoctor(makeContext(), [boom, okCheck]);
    expect(report.exitCode).toBe(2);
    const crashed = report.checks.find((c) => c.id === "t.boom");
    expect(crashed?.status).toBe("fail");
    expect(crashed?.detail).toContain("检查本身出错");
    expect(crashed?.detail).not.toContain("secret");
    expect(report.checks.find((c) => c.id === "t.ok")?.status).toBe("ok");
  });

  it("turns SkipCheck into a warning, not a failure", async () => {
    const skipped: DoctorCheck = { id: "t.skip", group: "host", run: async () => { throw new SkipCheck("数据库连不上"); } };
    const report = await runDoctor(makeContext(), [skipped]);
    expect(report.checks[0]).toMatchObject({ status: "warn", detail: "跳过：数据库连不上" });
    expect(report.exitCode).toBe(1);
  });
});

describe("runDoctor when the database is down", () => {
  it("fails db.connect once and skips the checks that need it", async () => {
    const ctx = makeContext({ probes: { dbPing: async () => false } });
    const report = await runDoctor(ctx);
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get("db.connect")?.status).toBe("fail");
    for (const id of ["db.migrations", "runner.heartbeat", "aiworker.heartbeat", "cycle.last", "ai.backlog", "budget.all", "channels.each"]) {
      expect(byId.get(id)?.status, id).toBe("warn");
      expect(byId.get(id)?.detail, id).toContain("跳过");
    }
    expect(ctx.probes.sources).not.toHaveBeenCalled();
    expect(report.exitCode).toBe(2);
  });
});

describe("rendering", () => {
  it("prints one line per check, a fix hint under problems, and a summary", async () => {
    const ctx = makeContext({ commands: { "docker info --format {{.ServerVersion}}": { kind: "ran", exitCode: 1, stdout: "", stderr: "Cannot connect" } } });
    const report = await runDoctor(ctx);
    const text = renderText(report, { timeZone: "Europe/Berlin", t: ctx.t });
    expect(text).toContain("Job Radar 健康检查  2026-10-07 14:00 Europe/Berlin");
    expect(text).toContain("❌ Docker 在运行 — Docker 没有在运行");
    expect(text).toContain("↳ 怎么办：open -a Docker");
    expect(text).toMatch(/合计：\d+ ✅  \d+ ⚠️\s+1 ❌/);
    expect(text).toContain("（退出码 2）");
    expect(text).not.toContain("ABC-test_token");
  });

  it("--json is the report", async () => {
    const report = await runDoctor(makeContext());
    const parsed = JSON.parse(renderJson(report)) as typeof report;
    expect(parsed.exitCode).toBe(0);
    expect(parsed.checks).toHaveLength(report.checks.length);
    expect(Object.keys(parsed.checks[0] ?? {}).sort()).toEqual(["detail", "group", "id", "status", "title"]);
  });
});

describe("--only", () => {
  it("keeps the results whose id starts with a prefix and runs only the checks that can produce them", async () => {
    const ctx = makeContext();
    const report = await runDoctor(ctx, ALL_CHECKS, { only: ["compose.db", "tailscale"] });
    expect(report.checks.map((c) => c.id).sort()).toEqual(["compose.db", "tailscale.serve", "tailscale.status"]);
    expect(ctx.probes.sources).not.toHaveBeenCalled();
  });
  it("selectChecks matches on the first segment of the id", () => {
    expect(selectChecks(["compose"]).map((c) => c.id)).toEqual(["compose.services", "compose.project"]);
    expect(selectChecks(["disk.backups"]).map((c) => c.id)).toEqual(["disk.free", "disk.docker_location", "disk.internal"]);
    expect(selectChecks(["zzz"])).toEqual([]);
    expect(selectChecks([]).length).toBe(ALL_CHECKS.length);
  });
});

describe("the report's language", () => {
  it("renders titles, details, hints, groups and the summary in English, with the same ids and statuses", async () => {
    const broken = { commands: { "docker info --format {{.ServerVersion}}": { kind: "ran" as const, exitCode: 1, stdout: "", stderr: "Cannot connect" } } };
    const zh = await runDoctor(makeContext(broken));
    // English settings, so the i18n.config line does not name 中文 (an interface language is shown by its own name)
    const ctx = makeContext({ ...broken, locale: "en", language: (raw) => Object.assign(raw, { ui: { default_locale: "en" }, ai: { output: "en", summary_also: [] }, translation: { target: "en" } }) });
    const en = await runDoctor(ctx);
    expect(en.locale).toBe("en");
    expect(zh.locale).toBe("zh");
    expect(en.checks.map((c) => [c.id, c.status])).toEqual(zh.checks.map((c) => [c.id, c.status]));
    const text = renderText(en, { timeZone: "Europe/Berlin", t: ctx.t });
    expect(text).toContain("Job Radar health check  2026-10-07 14:00 Europe/Berlin");
    expect(text).toContain("❌ Docker is running — Docker is not running");
    expect(text).toContain("↳ What to do: open -a Docker");
    expect(text).toMatch(/Total: \d+ ✅  \d+ ⚠️\s+1 ❌  —  there are problems to fix \(exit code 2\)/);
    expect(text).toContain("Runtime");
    expect(text).not.toMatch(/[一-鿿]/);
  });

  it("every check has a title in every language", () => {
    for (const locale of ["en", "zh"] as const) {
      const ctx = makeContext({ locale });
      for (const check of ALL_CHECKS) expect(checkTitle(ctx, check.id), `${locale}: ${check.id}`).not.toBe(check.id);
    }
  });

  it("i18n.config shows the four language settings; an unreadable language.yaml is a warning", async () => {
    const zh = await runDoctor(makeContext(), ALL_CHECKS, { only: ["i18n"] });
    expect(zh.checks).toHaveLength(1);
    expect(zh.checks[0]).toMatchObject({ id: "i18n.config", status: "ok" });
    expect(zh.checks[0]?.detail).toBe("界面 中文 (zh) · AI 输出 中文 (zh)（摘要另附 English (en)） · 翻译成 中文 (zh) · Telegram 中文 (zh) · 命令行 中文 (zh)");
    const en = makeContext({ locale: "en", language: (raw) => Object.assign(raw, { ai: { output: "de", summary_also: [] }, cli: { locale: "en" } }) });
    expect((await runDoctor(en, ALL_CHECKS, { only: ["i18n"] })).checks[0]?.detail).toBe("Interface 中文 (zh) · AI output German (de) · translated into 中文 (zh) · Telegram 中文 (zh) · command line English (en)");
    const broken = makeContext({ locale: "en" });
    broken.config.language = null;
    broken.config.languageProblem = "ui.default_locale: must be one of the interface languages";
    expect((await runDoctor(broken, ALL_CHECKS, { only: ["i18n"] })).checks[0]).toMatchObject({ status: "warn", detail: expect.stringContaining("language.yaml cannot be read (ui.default_locale") });
  });
});
