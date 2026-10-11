// @vitest-environment node
import { describe, expect, it } from "vitest";

import { aiBacklogCheck, aiWorkerHeartbeatCheck, aiWorkerLaunchdCheck, claudeLoginCheck, codexLoginCheck, configGuardsCheck, parseLaunchctlPrint, profileCheck } from "@/lib/ops/doctor/checks/ai";

import { ago, LAUNCHCTL_RUNNING, makeContext, only, ran, sourcesView } from "./helpers";

const LAUNCHCTL = "launchctl print gui/501/io.jobradar.ai-worker";
const worker = (extra: Partial<ReturnType<typeof sourcesView>["aiWorker"]>) => ({ ...sourcesView().aiWorker, ...extra });

describe("parseLaunchctlPrint", () => {
  it("reads state, pid and last exit code", () => {
    expect(parseLaunchctlPrint("x = {\n\tstate = running\n\tpid = 99\n\tlast exit code = 0\n}")).toEqual({ state: "running", pid: 99, lastExitCode: "0", stdoutPath: null });
    expect(parseLaunchctlPrint("\tstate = waiting\n\tlast exit code = 78")).toEqual({ state: "waiting", pid: null, lastExitCode: "78", stdoutPath: null });
    expect(parseLaunchctlPrint("nothing")).toEqual({ state: null, pid: null, lastExitCode: null, stdoutPath: null });
    expect(parseLaunchctlPrint("\tstdout path = /Users/me/Library/Logs/job-radar/ai-worker.launchd.log\n").stdoutPath).toBe("/Users/me/Library/Logs/job-radar/ai-worker.launchd.log");
  });
});

describe("aiworker.launchd", () => {
  it("ok when launchd runs it", async () => {
    expect(await only(aiWorkerLaunchdCheck, makeContext())).toMatchObject({ status: "ok", detail: expect.stringContaining("pid 4242") });
  });
  it("asks launchctl for gui/<uid>/<label> from doctor.ai_worker_launchd_label", async () => {
    const ctx = makeContext({ settings: { ai_worker_launchd_label: "x.y" }, uid: 777, commands: { "launchctl print gui/777/x.y": ran("\tstate = running\n\tpid = 1") } });
    expect((await only(aiWorkerLaunchdCheck, ctx)).status).toBe("ok");
  });
  it("fails when installed but not running", async () => {
    const r = await only(aiWorkerLaunchdCheck, makeContext({ commands: { [LAUNCHCTL]: ran("\tstate = waiting\n\tlast exit code = 78") } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("waiting");
    expect(r.detail).toContain("78");
    expect(r.hint).toContain("~/Library/Logs/job-radar/ai-worker.launchd.log");
    expect(r.hint).toContain("/Volumes/SSD/work/job-radar/data/logs/ai-worker.err.log");
  });
  it("warns when the running agent still has launchd write the old log files on the internal disk (installed before the log-dir option)", async () => {
    const old = `${LAUNCHCTL_RUNNING}\n\tstdout path = /Users/me/Library/Logs/job-radar/ai-worker.out.log`;
    const r = await only(aiWorkerLaunchdCheck, makeContext({ commands: { [LAUNCHCTL]: ran(old) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("/Users/me/Library/Logs/job-radar/ai-worker.out.log");
    expect(r.hint).toContain("scripts/ops/install-ai-worker.sh");
    const current = `${LAUNCHCTL_RUNNING}\n\tstdout path = /Users/me/Library/Logs/job-radar/ai-worker.launchd.log`;
    expect((await only(aiWorkerLaunchdCheck, makeContext({ commands: { [LAUNCHCTL]: ran(current) } }))).status).toBe("ok");
  });
  it("warns that the agent needs migration when only the old de.jobradar label is loaded", async () => {
    const r = await only(aiWorkerLaunchdCheck, makeContext({ commands: { [LAUNCHCTL]: ran("", 113, "Could not find service"), "launchctl print gui/501/de.jobradar.ai-worker": ran(LAUNCHCTL_RUNNING) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("de.jobradar.ai-worker");
    expect(r.hint).toContain("scripts/ops/install-ai-worker.sh");
  });
  it("treats a user config that still names the old label as the new label", async () => {
    const ctx = makeContext({ settings: { ai_worker_launchd_label: "de.jobradar.ai-worker" } });
    expect((await only(aiWorkerLaunchdCheck, ctx)).status).toBe("ok");
  });
  it("fails when not installed and no heartbeat", async () => {
    const r = await only(aiWorkerLaunchdCheck, makeContext({ commands: { [LAUNCHCTL]: ran("", 113, "Could not find service") }, probes: { sources: async () => sourcesView({ aiWorker: worker({ online: false, lastHeartbeatAt: null, ageSeconds: null }) }) } }));
    expect(r).toMatchObject({ status: "fail" });
    expect(r.hint).toContain("scripts/ops/install-ai-worker.sh");
  });
  it("warns when not installed but a hand-started worker beats (UAT)", async () => {
    const r = await only(aiWorkerLaunchdCheck, makeContext({ commands: { [LAUNCHCTL]: ran("", 113, "Could not find service") } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("手动启动");
  });
  it("is not needed with execution: container", async () => {
    const r = await only(aiWorkerLaunchdCheck, makeContext({ ai: (raw) => (raw.execution = "container") }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("不需要 ai-worker");
  });
  it("warns off macOS instead of crashing", async () => {
    expect((await only(aiWorkerLaunchdCheck, makeContext({ platform: "linux", uid: null }))).status).toBe("warn");
  });
});

describe("aiworker.heartbeat", () => {
  it("ok when online", async () => {
    expect(await only(aiWorkerHeartbeatCheck, makeContext())).toMatchObject({ status: "ok", detail: "最近一次心跳 5 秒前（超过 180 秒算离线）" });
  });
  it("fails when offline", async () => {
    const r = await only(aiWorkerHeartbeatCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ online: false, lastHeartbeatAt: ago(900), ageSeconds: 900 }) }) } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("15 分钟");
    expect(r.hint).toContain("launchctl kickstart");
    expect(r.hint).toContain("/Volumes/SSD/work/job-radar/data/logs/ai-worker.err.log");
  });
  it("fails when it never beat", async () => {
    const r = await only(aiWorkerHeartbeatCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ online: false, lastHeartbeatAt: null, ageSeconds: null }) }) } }));
    expect(r.detail).toContain("从来没有");
  });
  it("is not needed with execution: container", async () => {
    expect((await only(aiWorkerHeartbeatCheck, makeContext({ ai: (raw) => (raw.execution = "container") }))).status).toBe("ok");
  });
});

describe("ai.claude and ai.codex", () => {
  const loggedOut = ran(JSON.stringify({ loggedIn: false }), 1);
  it("ok when both are logged in, without printing the account", async () => {
    const ctx = makeContext();
    const claude = await only(claudeLoginCheck, ctx);
    const codex = await only(codexLoginCheck, ctx);
    expect(claude).toMatchObject({ status: "ok", detail: expect.stringContaining("订阅 max") });
    expect(codex.status).toBe("ok");
    expect(JSON.stringify([claude, codex])).not.toContain("someone@example.com");
  });
  it("warns for the missing login while the other one works", async () => {
    const ctx = makeContext({ commands: { "claude auth status": loggedOut } });
    const claude = await only(claudeLoginCheck, ctx);
    expect(claude).toMatchObject({ status: "warn", detail: expect.stringContaining("没有登录") });
    expect(claude.hint).toContain("/login");
    expect((await only(codexLoginCheck, ctx)).status).toBe("ok");
  });
  it("fails both when neither works", async () => {
    const ctx = makeContext({ commands: { "claude auth status": loggedOut, "codex login status": ran("Not logged in\n", 1) } });
    expect((await only(claudeLoginCheck, ctx)).status).toBe("fail");
    const codex = await only(codexLoginCheck, ctx);
    expect(codex.status).toBe("fail");
    expect(codex.hint).toContain("codex login");
  });
  it("reports a missing command", async () => {
    const ctx = makeContext({ commands: { "codex login status": { kind: "missing" } } });
    const codex = await only(codexLoginCheck, ctx);
    expect(codex).toMatchObject({ status: "warn", detail: expect.stringContaining("找不到 codex") });
  });
  it("warns when the output cannot be read or the command hangs", async () => {
    const ctx = makeContext({ commands: { "claude auth status": ran("garbage"), "codex login status": { kind: "timeout" } } });
    expect((await only(claudeLoginCheck, ctx)).status).toBe("warn");
    expect((await only(codexLoginCheck, ctx)).status).toBe("warn");
  });
  it("uses the commands named in ai.yaml", async () => {
    const ctx = makeContext({ ai: (raw) => ((raw.providers as { claude_cli: { command: string } }).claude_cli.command = "claude-x"), commands: { "claude-x auth status": ran(JSON.stringify({ loggedIn: true })) } });
    expect((await only(claudeLoginCheck, ctx)).status).toBe("ok");
  });
  it("does not care about a provider that ai.yaml leaves out", async () => {
    const ctx = makeContext({ ai: (raw) => (raw.order = ["claude-cli", "api"]), commands: { "codex login status": ran("Not logged in", 1) } });
    const codex = await only(codexLoginCheck, ctx);
    expect(codex.status).toBe("ok");
    expect(codex.detail).toContain("不使用");
  });
  it("never runs anything that could call the AI", async () => {
    const ctx = makeContext();
    await only(claudeLoginCheck, ctx);
    await only(codexLoginCheck, ctx);
    const lines = ctx.probes.run.mock.calls.map((c) => [c[0], ...c[1]].join(" "));
    expect(lines.sort()).toEqual(["claude auth status", "codex login status"]);
  });
});

describe("ai.backlog", () => {
  it("ok with a short queue", async () => {
    const r = await only(aiBacklogCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("0 条等待");
    expect(r.detail).toContain("12 条岗位等 AI 打分");
  });
  it("warns when the queue is long", async () => {
    const queue = { pending: 40, running: 1, oldestPendingAt: ago(60) };
    const r = await only(aiBacklogCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ queue }) }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("40 条等待");
  });
  it("warns when the oldest request waited too long (doctor.ai_oldest_pending_warn_minutes)", async () => {
    const queue = { pending: 1, running: 0, oldestPendingAt: ago(31 * 60) };
    const r = await only(aiBacklogCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ queue }) }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("31 分钟");
  });
  it("warns when many jobs wait for a score", async () => {
    const r = await only(aiBacklogCheck, makeContext({ probes: { unscoredJobs: async () => 200 } }));
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("score:queue");
  });
  it("warns when the last run_ai failed", async () => {
    const lastRun = { requestId: 1, status: "failed" as const, finishedAt: ago(60), cycleId: 1, error: "ai_failed", aiStatus: null, scored: null, translated: null, notifyStatus: null, pushed: null };
    const r = await only(aiBacklogCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ lastRun }) }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("ai_failed");
  });
  it("shows the last successful run", async () => {
    const lastRun = { requestId: 1, status: "done" as const, finishedAt: ago(60), cycleId: 1, error: null, aiStatus: "done", scored: 80, translated: 3, notifyStatus: "done", pushed: 10 };
    const r = await only(aiBacklogCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ lastRun }) }) } }));
    expect(r.detail).toContain("打分 80 条，推送 10 条");
  });
});

describe("ai.profile", () => {
  const incomplete = async () => ({ usable: false, missing: ["summary" as const, "skills" as const] });

  it("ok when me.yaml has a summary or skills", async () => {
    const r = await only(profileCheck, makeContext());
    expect(r.status).toBe("ok");
  });
  it("fails with a 'what to do' line when the profile is incomplete and jobs wait for a score", async () => {
    const r = await only(profileCheck, makeContext({ probes: { profile: incomplete, unscoredJobs: async () => 139 } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("简介（summary）、技能（skills）");
    expect(r.detail).toContain("139 条岗位在等打分");
    expect(r.hint).toContain("/me");
  });
  it("warns when the profile is incomplete but nothing waits (or the database is down)", async () => {
    expect((await only(profileCheck, makeContext({ probes: { profile: incomplete, unscoredJobs: async () => 0 } }))).status).toBe("warn");
    const down = await only(profileCheck, makeContext({ probes: { profile: incomplete, unscoredJobs: async () => Promise.reject(new Error("down")) } }));
    expect(down.status).toBe("warn");
    expect(down.hint).toContain("/me");
  });
  it("warns when me.yaml cannot be read", async () => {
    const r = await only(profileCheck, makeContext({ probes: { profile: async () => null } }));
    expect(r.status).toBe("warn");
  });
  it("the backlog check no longer calls a profile-skipped run a success", async () => {
    const lastRun = { requestId: 2, status: "done" as const, finishedAt: ago(60), cycleId: 2, error: null, aiStatus: "skipped_profile_incomplete", scored: 0, translated: 0, notifyStatus: "ok", pushed: 0 };
    const r = await only(aiBacklogCheck, makeContext({ probes: { sources: async () => sourcesView({ aiWorker: worker({ lastRun }) }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("画像不完整");
    expect(r.detail).not.toContain("成功");
  });
});

describe("config.guards", () => {
  it("ok with the shipped config and no opt-in", async () => {
    expect(await only(configGuardsCheck, makeContext())).toMatchObject({ status: "ok" });
  });

  it("fails for a refused CLI command and warns for dropped overrides and a refused endpoint", async () => {
    const ctx = makeContext({
      ai: (raw) => {
        const providers = raw.providers as Record<string, Record<string, unknown>>;
        providers.codex_cli!.command = "/tmp/not-codex";
        (providers.codex_cli!.config_overrides as Record<string, string>).sandbox_mode = '"danger-full-access"';
        providers.mimo!.base_url = "https://evil.example/v1";
      },
    });
    const r = await only(configGuardsCheck, ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("sandbox_mode");
    expect(r.detail).toContain("/tmp/not-codex");
    expect(r.detail).toContain("ai.yaml providers.mimo.base_url");
    expect(r.hint).toContain("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1");
  });

  it("warns while JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1 is set, and for a custom Telegram host it lets through", async () => {
    const r = await only(configGuardsCheck, makeContext({ env: { JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" }, notify: (raw) => { raw.telegram.api_base_url = "https://tg.example"; } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1");
    expect(r.detail).toContain("notify.yaml telegram.api_base_url");
  });
});

describe("config.guards: codex version and Gmail", () => {
  it("warns when the installed codex is older than ai.yaml providers.codex_cli.min_version", async () => {
    const ctx = makeContext({ commands: { "codex --version": ran("codex-cli 0.100.0\n") } });
    const r = await only(configGuardsCheck, ctx);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("0.100.0");
    expect(r.hint).toContain("Codex");
  });

  it("is quiet for a codex equal to or newer than the minimum, and for a stale verified_version key in the user's file", async () => {
    for (const version of ["9.9.9", "0.122.0"]) {
      const ctx = makeContext({
        commands: { "codex --version": ran(`codex-cli ${version}\n`) },
        ai: (raw) => {
          const codex = (raw.providers as Record<string, Record<string, unknown>>).codex_cli!;
          codex.min_version = "0.122.0";
          codex.verified_version = "0.160.1";
        },
      });
      expect((await only(configGuardsCheck, ctx)).status).toBe("ok");
    }
  });

  it("fails for a model name that looks like an option", async () => {
    const r = await only(configGuardsCheck, makeContext({ ai: (raw) => { (raw.providers as Record<string, Record<string, unknown>>).claude_cli!.model = "--dangerously-skip-permissions"; } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("--dangerously-skip-permissions");
  });

  it("warns when the Gmail login would go elsewhere than imap.gmail.com:993 with TLS", async () => {
    const r = await only(configGuardsCheck, makeContext({ channels: (raw) => { Object.assign((raw.sources as Record<string, Record<string, unknown>>).gmail!, { secure: false, port: 143 }); } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("sources.yaml sources.gmail");
  });
});
