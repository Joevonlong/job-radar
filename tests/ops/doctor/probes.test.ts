// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readJournal } from "@/lib/db/migration-journal";
import { createRealProbes, httpGet, runCommand } from "@/lib/ops/doctor/probes";

const NODE = process.execPath;

describe("runCommand", () => {
  it("returns stdout and exit code 0", async () => {
    expect(await runCommand(NODE, ["-e", "console.log('hi')"], 10_000)).toEqual({ kind: "ran", exitCode: 0, stdout: "hi\n", stderr: "" });
  });
  it("a non-zero exit is an outcome, not an error", async () => {
    expect(await runCommand(NODE, ["-e", "console.error('bad'); process.exit(3)"], 10_000)).toMatchObject({ kind: "ran", exitCode: 3, stderr: "bad\n" });
  });
  it("a command that is not installed is `missing`", async () => {
    expect(await runCommand("definitely-not-a-command-jr", [], 10_000)).toEqual({ kind: "missing" });
  });
  it("a command that runs too long is killed and reported as `timeout`", async () => {
    expect(await runCommand(NODE, ["-e", "setTimeout(() => {}, 20000)"], 300)).toEqual({ kind: "timeout" });
  });
});

describe("httpGet", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") res.end('{"db":"ok"}');
      else if (req.url === "/down") {
        res.statusCode = 503;
        res.end('{"db":"error"}');
      } else if (req.url === "/slow") setTimeout(() => res.end("late"), 3000);
      else if (req.url === "/big") res.end("x".repeat(100_000));
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("reads a 200 and its body", async () => {
    expect(await httpGet(`${base}/ok`, 2000)).toEqual({ ok: true, status: 200, body: '{"db":"ok"}', error: null });
  });
  it("reports a non-2xx answer with its body", async () => {
    expect(await httpGet(`${base}/down`, 2000)).toMatchObject({ ok: false, status: 503, body: '{"db":"error"}', error: null });
    expect(await httpGet(`${base}/nope`, 2000)).toMatchObject({ ok: false, status: 404 });
  });
  it("cuts a large body", async () => {
    expect((await httpGet(`${base}/big`, 2000)).body?.length).toBe(4096);
  });
  it("a closed port is an error with the code", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await httpGet(`http://127.0.0.1:${port}/`, 2000)).toEqual({ ok: false, status: null, body: null, error: "ECONNREFUSED" });
  });
  it("a slow answer times out", async () => {
    expect(await httpGet(`${base}/slow`, 200)).toMatchObject({ ok: false, status: null, error: "timeout" });
  });
});

describe("readJournal", () => {
  it("counts the entries of the shipped migrations and finds the newest `when`", async () => {
    const dir = path.resolve(import.meta.dirname, "../../../drizzle");
    const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries: Array<{ when: number }> };
    const expected = await readJournal(dir);
    expect(expected?.count).toBe(journal.entries.length);
    expect(expected?.latestAt).toBe(Math.max(...journal.entries.map((e) => e.when)));
  });
  it("is null for a folder without a journal", async () => {
    expect(await readJournal(path.join(os.tmpdir(), "no-such-drizzle-dir"))).toBeNull();
  });
});

describe("file system probes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-probes-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const probes = createRealProbes({ commandTimeoutMs: 1000, probeTimeoutMs: 1000, now: () => new Date(), migrationsDir: tmp });

  it("backups: null for a missing directory, [] for an empty one, newest name first, manual and partial files ignored", async () => {
    expect(await probes.backups(path.join(tmp, "missing"))).toBeNull();
    const dir = path.join(tmp, "backups");
    fs.mkdirSync(dir);
    expect(await probes.backups(dir)).toEqual([]);
    for (const name of ["jobradar-20261001-033000.dump", "jobradar-20261003-033000.dump", "jobradar-manual-20261004-120000.dump", "jobradar-20261005-033000.dump.partial"]) fs.writeFileSync(path.join(dir, name), "PGDMPx");
    expect((await probes.backups(dir))?.map((f) => f.name)).toEqual(["jobradar-20261003-033000.dump", "jobradar-20261001-033000.dump"]);
  });
  it("backups: a file where a directory should be is null", async () => {
    const file = path.join(tmp, "plain-file");
    fs.writeFileSync(file, "x");
    expect(await probes.backups(file)).toBeNull();
  });
  it("disk: free and total bytes of the volume, also for a path that does not exist yet", async () => {
    const space = await probes.disk(path.join(tmp, "not", "created", "yet"));
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space?.freeBytes).toBeGreaterThan(0);
    expect(space?.freeBytes).toBeLessThanOrEqual(space?.totalBytes ?? 0);
  });
  it("listDir: names, or null when missing", async () => {
    fs.writeFileSync(path.join(tmp, "a.json"), "{}");
    expect(await probes.listDir(tmp)).toContain("a.json");
    expect(await probes.listDir(path.join(tmp, "missing"))).toBeNull();
  });
  it("run and http go through the injected time-outs", async () => {
    expect(await probes.run(NODE, ["-e", "setTimeout(() => {}, 20000)"])).toEqual({ kind: "timeout" });
  });
});
