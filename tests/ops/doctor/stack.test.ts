// @vitest-environment node
import { describe, expect, it } from "vitest";

import { composeServicesCheck, dbConnectCheck, dockerDaemonCheck, migrationsCheck, runnerHeartbeatCheck, webCheck } from "@/lib/ops/doctor/checks/stack";
import { parseComposePs } from "@/lib/ops/doctor/shared";
import { SkipCheck } from "@/lib/ops/doctor";

import { ago, composeJson, httpDown, httpOk, makeContext, only, ran, results, sourcesView } from "./helpers";

const DOCKER_INFO = "docker info --format {{.ServerVersion}}";
const COMPOSE_PS = "docker compose -p job-radar ps -a --format json";
const byService = async (ctx: ReturnType<typeof makeContext>) => new Map((await results(composeServicesCheck, ctx)).map((r) => [r.id, r]));

describe("docker.daemon", () => {
  it("ok with the server version", async () => {
    expect(await only(dockerDaemonCheck, makeContext())).toMatchObject({ status: "ok", detail: "Docker 29.8.2" });
  });
  it("fails when docker is not installed", async () => {
    const r = await only(dockerDaemonCheck, makeContext({ commands: { [DOCKER_INFO]: { kind: "missing" } } }));
    expect(r).toMatchObject({ status: "fail", detail: "找不到 docker 命令" });
    expect(r.hint).toContain("Docker Desktop");
  });
  it("fails when the daemon is not running", async () => {
    const r = await only(dockerDaemonCheck, makeContext({ commands: { [DOCKER_INFO]: ran("", 1, "Cannot connect to the Docker daemon") } }));
    expect(r).toMatchObject({ status: "fail", detail: "Docker 没有在运行" });
    expect(r.hint).toContain("open -a Docker");
  });
  it("fails when docker hangs", async () => {
    expect((await only(dockerDaemonCheck, makeContext({ commands: { [DOCKER_INFO]: { kind: "timeout" } } }))).status).toBe("fail");
  });
});

describe("compose.<service>", () => {
  it("ok for the four healthy services, one result each", async () => {
    const map = await byService(makeContext());
    expect([...map.keys()]).toEqual(["compose.db", "compose.web", "compose.runner", "compose.jobspy"]);
    expect([...map.values()].every((r) => r.status === "ok")).toBe(true);
    expect(map.get("compose.web")?.detail).toContain("healthy");
    expect(map.get("compose.db")?.detail).toContain("127.0.0.1:5433");
  });

  it("fails an unhealthy service and points at its logs", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ runner: { Health: "unhealthy" } })) } }));
    expect(map.get("compose.runner")).toMatchObject({ status: "fail" });
    expect(map.get("compose.runner")?.hint).toContain("docker compose -p job-radar logs --tail 100 runner");
    expect(map.get("compose.web")?.status).toBe("ok");
  });

  it("warns for a service that is still starting", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ web: { Health: "starting" } })) } }));
    expect(map.get("compose.web")?.status).toBe("warn");
  });

  it("fails a stopped container with its exit code", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ jobspy: { State: "exited", Health: "", ExitCode: 137 } })) }, probes: { http: async (url) => (url.includes("8000") ? httpDown() : httpOk('{"db":"ok"}')) } }));
    expect(map.get("compose.jobspy")).toMatchObject({ status: "fail" });
    expect(map.get("compose.jobspy")?.detail).toContain("exited");
    expect(map.get("compose.jobspy")?.detail).toContain("137");
  });

  it("fails a missing service when nothing on the host stands in for it", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ jobspy: null })) }, probes: { http: async (url) => (url.includes("8000") ? httpDown() : httpOk('{"db":"ok"}')) } }));
    expect(map.get("compose.jobspy")).toMatchObject({ status: "fail", detail: "compose 项目 job-radar 里没有这个容器" });
    expect(map.get("compose.jobspy")?.hint).toContain("scripts/ops/deploy.sh");
  });

  it("host processes instead of compose: warns (not fails) when web, runner and jobspy answer on the host", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ web: null, runner: null, jobspy: null })) } }));
    for (const id of ["compose.web", "compose.runner", "compose.jobspy"]) {
      expect(map.get(id)?.status, id).toBe("warn");
      expect(map.get(id)?.detail, id).toContain("宿主机上可用");
    }
    expect(map.get("compose.web")?.detail).toContain("http://127.0.0.1:3000");
    expect(map.get("compose.runner")?.detail).toContain("心跳 10 秒前");
    expect(map.get("compose.db")?.status).toBe("ok");
  });

  it("host processes instead of exited compose containers: also a warning", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ web: { State: "exited", Health: "", ExitCode: 143 } })) } }));
    expect(map.get("compose.web")).toMatchObject({ status: "warn" });
    expect(map.get("compose.web")?.detail).toContain("exited");
  });

  it("a stale runner heartbeat is no stand-in for a missing runner container", async () => {
    const stale = sourcesView({ lastHeartbeatAt: ago(900) });
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ runner: null })) }, probes: { sources: async () => stale } }));
    expect(map.get("compose.runner")?.status).toBe("fail");
  });

  it("docker down: every service is a failure unless it answers on the host", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran("", 1, "Cannot connect"), [DOCKER_INFO]: ran("", 1) }, probes: { http: async () => httpDown(), dbPing: async () => true } }));
    expect(map.get("compose.db")).toMatchObject({ status: "warn" }); // the db answers on the host
    expect(map.get("compose.web")).toMatchObject({ status: "fail" });
    expect(map.get("compose.web")?.detail).toContain("docker 不可用");
  });

  it("fails a service published on a non-loopback address (C5)", async () => {
    const map = await byService(makeContext({ commands: { [COMPOSE_PS]: ran(composeJson({ web: { Publishers: [{ URL: "0.0.0.0", TargetPort: 3000, PublishedPort: 3000 }] } })) } }));
    expect(map.get("compose.web")).toMatchObject({ status: "fail" });
    expect(map.get("compose.web")?.detail).toContain("0.0.0.0:3000");
    expect(map.get("compose.web")?.hint).toContain("127.0.0.1");
  });

  it("follows doctor.compose_services and doctor.compose_project", async () => {
    const ctx = makeContext({ settings: { compose_services: ["db"], compose_project: "other" }, commands: { "docker compose -p other ps -a --format json": ran(composeJson()) } });
    expect([...(await byService(ctx)).keys()]).toEqual(["compose.db"]);
  });
});

describe("parseComposePs", () => {
  const web = { Service: "web", State: "running", Health: "healthy", Publishers: [{ URL: "127.0.0.1", TargetPort: 3000, PublishedPort: 3000 }] };
  it("reads one JSON object per line and a JSON array", () => {
    expect(parseComposePs(`${JSON.stringify(web)}\n${JSON.stringify({ ...web, Service: "db" })}\n`).map((c) => c.service)).toEqual(["web", "db"]);
    expect(parseComposePs(JSON.stringify([web])).map((c) => c.service)).toEqual(["web"]);
  });
  it("ignores empty output, junk lines and null Publishers", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs(`not json\n${JSON.stringify({ ...web, Publishers: null })}`)).toMatchObject([{ service: "web", published: [] }]);
  });
  it("drops unpublished ports (PublishedPort 0)", () => {
    expect(parseComposePs(JSON.stringify({ ...web, Publishers: [{ URL: "", TargetPort: 8000, PublishedPort: 0 }] }))[0]?.published).toEqual([]);
  });
});

describe("web.http", () => {
  it("ok on 200 with db ok", async () => {
    expect(await only(webCheck, makeContext())).toMatchObject({ status: "ok", detail: expect.stringContaining("→ 200") });
  });
  it("fails when nothing answers", async () => {
    const r = await only(webCheck, makeContext({ urls: { "http://127.0.0.1:3000/api/health": httpDown("ECONNREFUSED") } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("ECONNREFUSED");
    expect(r.hint).toContain("3000");
  });
  it("fails on 503 (the web app cannot reach the database)", async () => {
    const r = await only(webCheck, makeContext({ urls: { "http://127.0.0.1:3000/api/health": { ok: false, status: 503, body: '{"db":"error"}', error: null } } }));
    expect(r).toMatchObject({ status: "fail" });
    expect(r.detail).toContain("503");
    expect(r.detail).toContain("连不上数据库");
  });
  it("uses doctor.web_url", async () => {
    const ctx = makeContext({ settings: { web_url: "http://127.0.0.1:3200" }, urls: { "http://127.0.0.1:3200/api/health": httpOk('{"db":"ok"}') } });
    expect((await only(webCheck, ctx)).status).toBe("ok");
  });
});

describe("db.connect and db.migrations", () => {
  it("db.connect ok / fail", async () => {
    expect((await only(dbConnectCheck, makeContext())).status).toBe("ok");
    const r = await only(dbConnectCheck, makeContext({ probes: { dbPing: async () => false } }));
    expect(r.status).toBe("fail");
    expect(r.hint).toContain("POSTGRES_PASSWORD");
    expect(r.detail).not.toMatch(/postgres:\/\//);
  });

  it("migrations: up to date", async () => {
    expect(await only(migrationsCheck, makeContext())).toMatchObject({ status: "ok", detail: "迁移是最新的（17 个）" });
  });
  it("migrations: behind -> fail with the count", async () => {
    const ctx = makeContext({ probes: { migrations: async () => ({ expected: { count: 17, latestAt: 200 }, applied: { count: 15, latestAt: 100 } }) } });
    const r = await only(migrationsCheck, ctx);
    expect(r).toMatchObject({ status: "fail" });
    expect(r.detail).toContain("缺 2 个迁移");
    expect(r.hint).toContain("scripts/ops/deploy.sh");
  });
  it("migrations: never migrated -> fail", async () => {
    const ctx = makeContext({ probes: { migrations: async () => ({ expected: { count: 17, latestAt: 200 }, applied: { count: 0, latestAt: null } }) } });
    expect((await only(migrationsCheck, ctx)).detail).toContain("还没有迁移");
  });
  it("migrations: database newer than the code -> warn", async () => {
    const ctx = makeContext({ probes: { migrations: async () => ({ expected: { count: 16, latestAt: 100 }, applied: { count: 17, latestAt: 200 } }) } });
    const r = await only(migrationsCheck, ctx);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("比这份代码新");
  });
  it("migrations: unreadable journal -> warn", async () => {
    const ctx = makeContext({ probes: { migrations: async () => ({ expected: null, applied: { count: 17, latestAt: 200 } }) } });
    expect((await only(migrationsCheck, ctx)).status).toBe("warn");
  });
  it("migrations: skipped while the database is down", async () => {
    await expect(migrationsCheck.run(makeContext({ probes: { dbPing: async () => false } }))).rejects.toBeInstanceOf(SkipCheck);
  });
});

describe("runner.heartbeat", () => {
  it("ok when fresh", async () => {
    expect(await only(runnerHeartbeatCheck, makeContext())).toMatchObject({ status: "ok", detail: "最近一次心跳 10 秒前（上限 120 秒）" });
  });
  it("ok at exactly the limit, fails one second over", async () => {
    expect((await only(runnerHeartbeatCheck, makeContext({ probes: { sources: async () => sourcesView({ lastHeartbeatAt: ago(120) }) } }))).status).toBe("ok");
    expect((await only(runnerHeartbeatCheck, makeContext({ probes: { sources: async () => sourcesView({ lastHeartbeatAt: ago(121) }) } }))).status).toBe("fail");
  });
  it("fails without any heartbeat", async () => {
    const r = await only(runnerHeartbeatCheck, makeContext({ probes: { sources: async () => sourcesView({ lastHeartbeatAt: null }) } }));
    expect(r).toMatchObject({ status: "fail", detail: "runner 从来没有写过心跳" });
  });
});
