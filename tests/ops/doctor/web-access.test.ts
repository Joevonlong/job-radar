// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { aiWorkerLaunchdCheck, AI_WORKER_SYSTEMD_UNIT, parseSystemctlShow } from "@/lib/ops/doctor/checks/ai";
import { ownershipCheck } from "@/lib/ops/doctor/checks/data";
import { webAccessCheck } from "@/lib/ops/doctor/checks/notify";
import { composeProjectCheck, composeServicesCheck } from "@/lib/ops/doctor/checks/stack";
import { resolveComposeProject, resolveDoctorWebUrl, scanOwnership } from "@/lib/ops/doctor/probes";

import { composeJson, HEALTHY_PASSWORD_HASH, makeContext, only, ran, results, sourcesView } from "./helpers";

const HASH = HEALTHY_PASSWORD_HASH;
/** No password at all (the helper's healthy context has one). */
const NONE = { JOB_RADAR_WEB_PASSWORD_HASH: undefined };
const NO_SERVE = { "tailscale serve status --json": ran("{}") };
const COMPOSE_PS = "docker compose -p job-radar ps -a --format json";

describe("web.access", () => {
  it("ok with a hash", async () => {
    expect(await only(webAccessCheck, makeContext({ env: { JOB_RADAR_WEB_PASSWORD_HASH: HASH } }))).toMatchObject({ status: "ok" });
  });

  it("fails on a hash it cannot read (nobody can sign in)", async () => {
    expect((await only(webAccessCheck, makeContext({ env: { JOB_RADAR_WEB_PASSWORD_HASH: "$2b$10$x" } }))).status).toBe("fail");
  });

  it("warns on a plain-text password, and says when it is short", async () => {
    const plain = await only(webAccessCheck, makeContext({ env: { ...NONE, JOB_RADAR_WEB_PASSWORD: "a long enough password" }, locale: "en" }));
    expect(plain.status).toBe("warn");
    const short = await only(webAccessCheck, makeContext({ env: { ...NONE, JOB_RADAR_WEB_PASSWORD: "short" }, locale: "en" }));
    expect(short.status).toBe("warn");
    expect(short.detail).toContain("5");
    expect(short.detail).not.toContain("short\"");
  });

  it("no password: ok while the web is local only, a warning when tailscale serve forwards to it or the bind is wider", async () => {
    expect((await only(webAccessCheck, makeContext({ commands: NO_SERVE, env: NONE }))).status).toBe("ok");
    const served = await only(webAccessCheck, makeContext({ env: NONE, locale: "en" }));
    expect(served.status).toBe("warn");
    expect(served.detail).toContain("3000");
    const bound = await only(webAccessCheck, makeContext({ commands: NO_SERVE, env: { ...NONE, JOB_RADAR_WEB_BIND: "0.0.0.0" }, locale: "en" }));
    expect(bound.status).toBe("warn");
    expect(bound.detail).toContain("0.0.0.0");
  });

  it("warns on a hash with a scrypt N below 2^14 (cheap to guess once stolen), not on the default", async () => {
    const weak = "scrypt:8192:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const r = await only(webAccessCheck, makeContext({ env: { JOB_RADAR_WEB_PASSWORD_HASH: weak }, locale: "en" }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("8192");
    expect(r.detail).toContain("16384");
    const atFloor = "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect((await only(webAccessCheck, makeContext({ env: { JOB_RADAR_WEB_PASSWORD_HASH: atFloor } }))).status).toBe("ok");
  });

  it("a short JOB_RADAR_SESSION_SECRET turns an ok into a warning", async () => {
    const r = await only(webAccessCheck, makeContext({ env: { JOB_RADAR_WEB_PASSWORD_HASH: HASH, JOB_RADAR_SESSION_SECRET: "short" } }));
    expect(r.status).toBe("warn");
  });

  it("a password, no JOB_RADAR_WEB_BIND and no web container: warns that pnpm start listens everywhere and this machine needs the password too", async () => {
    const noWeb = { [COMPOSE_PS]: ran(composeJson({ web: null })) };
    const r = await only(webAccessCheck, makeContext({ commands: noWeb, env: { JOB_RADAR_WEB_PASSWORD_HASH: HASH, JOB_RADAR_WEB_BIND: undefined }, locale: "en" }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("JOB_RADAR_WEB_BIND");
    expect(r.hint).toContain("JOB_RADAR_WEB_BIND=127.0.0.1");
    // compose runs the web (it publishes on 127.0.0.1 by default), or the bind is set: nothing to say
    expect((await only(webAccessCheck, makeContext({ env: { JOB_RADAR_WEB_PASSWORD_HASH: HASH, JOB_RADAR_WEB_BIND: undefined } }))).status).toBe("ok");
    expect((await only(webAccessCheck, makeContext({ commands: noWeb, env: { JOB_RADAR_WEB_PASSWORD_HASH: HASH, JOB_RADAR_WEB_BIND: "127.0.0.1" } }))).status).toBe("ok");
    // docker not there at all: the web can only be running by hand
    const noDocker = { [COMPOSE_PS]: { kind: "missing" as const } };
    expect((await only(webAccessCheck, makeContext({ commands: noDocker, env: { JOB_RADAR_WEB_PASSWORD_HASH: HASH, JOB_RADAR_WEB_BIND: undefined } }))).status).toBe("warn");
  });

  it("never prints the password or the hash", async () => {
    for (const env of [{ ...NONE, JOB_RADAR_WEB_PASSWORD: "secret-password-1" }, { JOB_RADAR_WEB_PASSWORD_HASH: HASH }, { JOB_RADAR_WEB_PASSWORD_HASH: "scrypt:oops" }]) {
      const r = await only(webAccessCheck, makeContext({ env, locale: "en" }));
      const text = `${r.detail} ${r.hint ?? ""}`;
      for (const value of Object.values(env)) if (value !== undefined) expect(text).not.toContain(value);
    }
  });
});

describe("compose.web published beyond loopback", () => {
  const wide = { [COMPOSE_PS]: ran(composeJson({ web: { Publishers: [{ URL: "0.0.0.0", TargetPort: 3000, PublishedPort: 3000 }] } })) };
  const web = async (env: Record<string, string | undefined>) => (await results(composeServicesCheck, makeContext({ commands: wide, env }))).find((r) => r.id === "compose.web");

  it("fails without a bind setting (an accident)", async () => {
    expect((await web({}))?.status).toBe("fail");
    expect((await web(NONE))?.status).toBe("fail");
  });
  it("fails when JOB_RADAR_WEB_BIND opens it but no password is set", async () => {
    const r = await web({ ...NONE, JOB_RADAR_WEB_BIND: "0.0.0.0" });
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("0.0.0.0:3000");
  });
  it("passes when JOB_RADAR_WEB_BIND opens it behind the web password", async () => {
    expect((await web({ JOB_RADAR_WEB_BIND: "0.0.0.0", JOB_RADAR_WEB_PASSWORD_HASH: HASH }))?.status).toBe("ok");
  });
  it("published wide while JOB_RADAR_WEB_BIND is unset or loopback: says the local login exemption is still on, even with a password", async () => {
    for (const env of [{ JOB_RADAR_WEB_PASSWORD_HASH: HASH }, { JOB_RADAR_WEB_BIND: "127.0.0.1", JOB_RADAR_WEB_PASSWORD_HASH: HASH }, NONE]) {
      const r = (await results(composeServicesCheck, makeContext({ commands: wide, env, locale: "en" }))).find((x) => x.id === "compose.web");
      expect(r?.status).toBe("fail");
      expect(r?.detail).toContain("local login exemption is still on");
      expect(r?.hint).toContain("JOB_RADAR_WEB_BIND");
    }
  });
});

describe("data.ownership (Linux)", () => {
  const linux = (env: Record<string, string | undefined> = {}, scan?: { scanned: number; foreign: number; sample: string[]; truncated: boolean }) =>
    makeContext({ platform: "linux", uid: 1000, env, locale: "en", ...(scan === undefined ? {} : { probes: { foreignOwned: async () => scan } }) });

  it("skipped (ok) outside Linux", async () => {
    const ctx = makeContext();
    expect((await only(ownershipCheck, ctx)).status).toBe("ok");
    expect(ctx.probes.foreignOwned).not.toHaveBeenCalled();
  });

  it("checks data/ and .auth/ against PUID (default 1000)", async () => {
    const ctx = linux({ PUID: "1001" });
    expect((await only(ownershipCheck, ctx)).status).toBe("ok");
    expect(ctx.probes.foreignOwned).toHaveBeenCalledWith([`${ctx.appRoot}/data`, `${ctx.appRoot}/.auth`], 1001, expect.any(Object));
    const byDefault = linux();
    await only(ownershipCheck, byDefault);
    expect(byDefault.probes.foreignOwned).toHaveBeenCalledWith(expect.any(Array), 1000, expect.any(Object));
  });

  it("warns with the count, examples and the chown command when files belong to someone else", async () => {
    const appRoot = "/Volumes/SSD/work/job-radar";
    const r = await only(ownershipCheck, linux({ PGID: "1002" }, { scanned: 50, foreign: 7, sample: [`${appRoot}/data/logs/runner.log`, `${appRoot}/.auth/linkedin`], truncated: false }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("7");
    expect(r.detail).toContain("data/logs/runner.log");
    expect(r.hint).toContain("chown -R 1000:1002 data .auth");
  });

  it("warns when PUID is not a number", async () => {
    expect((await only(ownershipCheck, linux({ PUID: "joe" }))).status).toBe("warn");
  });

  it("scanOwnership walks the tree without following links and stops at the limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jr-owner-"));
    try {
      fs.mkdirSync(path.join(root, "data", "logs"), { recursive: true });
      fs.writeFileSync(path.join(root, "data", "logs", "a.log"), "x");
      fs.symlinkSync("/etc", path.join(root, "data", "link"));
      const me = fs.statSync(root).uid;
      const mine = await scanOwnership([path.join(root, "data"), path.join(root, ".auth")], me, { sample: 3, maxEntries: 100 });
      expect(mine).toEqual({ scanned: 4, foreign: 0, sample: [], truncated: false });
      const other = await scanOwnership([path.join(root, "data")], me + 1, { sample: 2, maxEntries: 100 });
      expect(other.foreign).toBe(4);
      expect(other.sample).toHaveLength(2);
      expect((await scanOwnership([path.join(root, "data")], me, { sample: 3, maxEntries: 2 })).truncated).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("compose.project", () => {
  const withDir = (dir: string) => ({ [COMPOSE_PS]: ran(composeJson({ web: { Labels: `com.docker.compose.project=job-radar,com.docker.compose.project.working_dir=${dir}` } })) });

  it("ok when the containers come from this checkout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jr-project-"));
    try {
      const ctx = { ...makeContext({ commands: withDir(root) }), appRoot: root };
      expect((await only(composeProjectCheck, ctx)).status).toBe("ok");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns when another checkout runs containers under the same project name", async () => {
    const r = await only(composeProjectCheck, makeContext({ commands: withDir("/somewhere/else/job-radar"), locale: "en" }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("/somewhere/else/job-radar");
  });

  it("ok when the containers carry no working directory label", async () => {
    expect((await only(composeProjectCheck, makeContext())).status).toBe("ok");
  });
});

describe("doctor settings from the instance variables", () => {
  it("resolveDoctorWebUrl: JOB_RADAR_DOCTOR_WEB_URL, else bind / port, else the configured URL", () => {
    expect(resolveDoctorWebUrl({}, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(resolveDoctorWebUrl({ JOB_RADAR_WEB_PORT: "3100" }, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3100");
    expect(resolveDoctorWebUrl({ JOB_RADAR_WEB_BIND: "0.0.0.0" }, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(resolveDoctorWebUrl({ JOB_RADAR_WEB_BIND: "192.168.1.20", JOB_RADAR_WEB_PORT: "3100" }, "x")).toBe("http://192.168.1.20:3100");
    expect(resolveDoctorWebUrl({ JOB_RADAR_WEB_PORT: "99999" }, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(resolveDoctorWebUrl({ JOB_RADAR_DOCTOR_WEB_URL: "http://127.0.0.1:4000", JOB_RADAR_WEB_PORT: "3100" }, "x")).toBe("http://127.0.0.1:4000");
  });

  it("resolveComposeProject: a valid COMPOSE_PROJECT_NAME, else the configured name", () => {
    expect(resolveComposeProject({}, "job-radar")).toBe("job-radar");
    expect(resolveComposeProject({ COMPOSE_PROJECT_NAME: "job-radar-anna" }, "job-radar")).toBe("job-radar-anna");
    expect(resolveComposeProject({ COMPOSE_PROJECT_NAME: "Bad Name" }, "job-radar")).toBe("job-radar");
  });
});

describe("aiworker.launchd on Linux (systemd user unit)", () => {
  const SYSTEMCTL = `systemctl --user show ${AI_WORKER_SYSTEMD_UNIT} -p LoadState -p ActiveState`;
  const linux = (out: ReturnType<typeof ran> | null, extra: Parameters<typeof makeContext>[0] = {}) =>
    makeContext({ platform: "linux", uid: 1000, ...(out === null ? {} : { commands: { [SYSTEMCTL]: out } }), ...extra });

  it("reads systemctl show", () => {
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=active\n")).toEqual({ load: "loaded", active: "active" });
    expect(parseSystemctlShow("")).toEqual({ load: null, active: null });
  });

  it("ok when the unit is active", async () => {
    const r = await only(aiWorkerLaunchdCheck, linux(ran("LoadState=loaded\nActiveState=active\n"), { locale: "en" }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain(AI_WORKER_SYSTEMD_UNIT);
  });

  it("fails when installed but not running", async () => {
    expect((await only(aiWorkerLaunchdCheck, linux(ran("LoadState=loaded\nActiveState=failed\n")))).status).toBe("fail");
  });

  it("not installed: fails, unless a worker started by hand is beating", async () => {
    const notFound = ran("LoadState=not-found\nActiveState=inactive\n");
    expect((await only(aiWorkerLaunchdCheck, linux(notFound))).status).toBe("warn");
    const offline = linux(notFound, { probes: { sources: async () => sourcesView({ aiWorker: { ...sourcesView().aiWorker, online: false } }) } });
    expect((await only(aiWorkerLaunchdCheck, offline)).status).toBe("fail");
  });

  it("no systemd user manager: a warning", async () => {
    expect((await only(aiWorkerLaunchdCheck, linux(null))).status).toBe("warn");
  });
});
