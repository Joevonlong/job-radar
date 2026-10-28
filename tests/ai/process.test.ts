// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createClaudeCliProvider } from "@/lib/ai/providers/claude-cli";
import { createCodexCliProvider } from "@/lib/ai/providers/codex-cli";
import { findExecutable, ProcessError, runProcess } from "@/lib/ai/providers/process";

import { pinnedAi } from "./helpers";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-proc-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000 };
const node = process.execPath;

describe("runProcess (real child processes)", () => {
  it("feeds stdin and captures stdout, stderr and the exit code", async () => {
    const result = await runProcess({
      ...base,
      command: node,
      args: ["-e", "process.stdin.on('data', d => { process.stdout.write('got:' + d); process.stderr.write('err'); process.exit(3); })"],
      stdin: "hello",
    });
    expect(result).toEqual({ stdout: "got:hello", stderr: "err", exitCode: 3 });
  });

  it("kills a child that exceeds the timeout", async () => {
    await expect(runProcess({ ...base, command: node, args: ["-e", "setInterval(() => {}, 1000)"], stdin: "", timeoutMs: 100 })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("kills a child when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runProcess({ ...base, command: node, args: ["-e", "setInterval(() => {}, 1000)"], stdin: "", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reports a missing binary", async () => {
    await expect(runProcess({ ...base, command: "definitely-not-a-command-xyz", args: [], stdin: "" })).rejects.toBeInstanceOf(ProcessError);
    await expect(runProcess({ ...base, command: "definitely-not-a-command-xyz", args: [], stdin: "" })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("reports an unavailable command when PATH lookup returns EACCES", async () => {
    fs.writeFileSync(path.join(dir, "unavailable-cli"), "#!/bin/sh\n", { mode: 0o600 });
    await expect(runProcess({ ...base, env: { PATH: dir }, command: "unavailable-cli", args: [], stdin: "" }))
      .rejects.toMatchObject({ kind: "not_found", message: "EACCES" });
  });

  it.skipIf(process.getuid?.() === 0)("reports a missing command even when PATH includes an unreadable directory", async () => {
    const blocked = path.join(dir, "blocked");
    fs.mkdirSync(blocked, { mode: 0o000 });
    try {
      await expect(runProcess({ ...base, env: { PATH: `${blocked}${path.delimiter}${dir}` }, command: "absent-cli", args: [], stdin: "" }))
        .rejects.toMatchObject({ kind: "not_found", message: "EACCES" });
    } finally {
      fs.chmodSync(blocked, 0o700);
    }
  });

  it("does not choke on a child that exits without reading stdin", async () => {
    const result = await runProcess({ ...base, command: node, args: ["-e", "process.exit(0)"], stdin: "x".repeat(2_000_000) });
    expect(result.exitCode).toBe(0);
  });
});

describe("findExecutable", () => {
  it("finds a command on PATH and an absolute path, and refuses non-executables", () => {
    const script = path.join(dir, "mycli");
    fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    expect(findExecutable("mycli", { PATH: dir })).toBe(script);
    expect(findExecutable(script, {})).toBe(script);
    expect(findExecutable("plain", { PATH: dir })).toBeNull();
    expect(findExecutable("mycli", { PATH: "/nonexistent" })).toBeNull();
  });
});

describe("providers against fake CLI executables", () => {
  const schema = z.object({ answer: z.string() });
  const prompt = { system: "sys", user: "hi" };
  const config = pinnedAi();

  function fakeCli(name: string, body: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${node}\n${body}`, { mode: 0o755 });
    return file;
  }

  it("claude-cli: spawns the command, passes the prompt on stdin and parses the envelope", async () => {
    const envelope = JSON.stringify({ is_error: false, result: "", structured_output: { answer: "from-claude" }, usage: { input_tokens: 5, output_tokens: 2 }, modelUsage: { "claude-haiku-4-5": {} } });
    const command = fakeCli("claude", `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{ if(s!=='hi'||!process.argv.includes('--safe-mode')) process.exit(9); process.stdout.write(${JSON.stringify(envelope)}); });`);
    const provider = createClaudeCliProvider({ config: { ...config.providers.claude_cli, command }, env: { PATH: process.env.PATH } });
    expect(provider.availability().available).toBe(true);
    const result = await provider.run("score", prompt, schema);
    expect(result.value).toEqual({ answer: "from-claude" });
    expect(result.usage).toMatchObject({ tokensIn: 5, tokensOut: 2 });
  });

  it("codex-cli: reads the schema file, answers with JSONL", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: '{"answer":"from-codex"}' } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } }),
    ].join("\n");
    const command = fakeCli(
      "codex",
      `const fs=require('fs');const a=process.argv;const f=a[a.indexOf('--output-schema')+1];if(JSON.parse(fs.readFileSync(f,'utf8')).type!=='object')process.exit(8);process.stdin.resume().on('end',()=>process.stdout.write(${JSON.stringify(lines)}));`,
    );
    const provider = createCodexCliProvider({ config: { ...config.providers.codex_cli, command }, env: { PATH: process.env.PATH }, authFileExists: () => true });
    const result = await provider.run("score", prompt, schema);
    expect(result.value).toEqual({ answer: "from-codex" });
    expect(result.usage).toMatchObject({ tokensIn: 9, tokensOut: 4 });
  });
});
