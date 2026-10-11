import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AiProviderError } from "../errors";
import type { AiProviderId } from "../types";

export interface ProcessSpec {
  command: string;
  args: readonly string[];
  /** Written to the child's stdin, then stdin is closed. */
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed by a signal. */
  exitCode: number | null;
}

/** Runs a child process to completion. Injectable so tests never spawn a real CLI. */
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

/** Output cap so a runaway child cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

/** The spawn failed or the process misbehaved; `kind` tells the provider how to classify it. */
export class ProcessError extends Error {
  readonly kind: "not_found" | "timeout" | "aborted" | "spawn" | "output_limit";
  constructor(kind: ProcessError["kind"], message: string) {
    super(message);
    this.name = "ProcessError";
    this.kind = kind;
  }
}

export const runProcess: ProcessRunner = (spec) =>
  new Promise<ProcessResult>((resolve, reject) => {
    if (spec.signal?.aborted) {
      reject(new ProcessError("aborted", "cancelled before start"));
      return;
    }
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      // Next's type augmentation makes NODE_ENV mandatory in ProcessEnv; the child gets exactly `spec.env`.
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: ProcessError | null = null;
    let settled = false;

    const kill = (error: ProcessError): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => kill(new ProcessError("timeout", `timed out after ${Math.round(spec.timeoutMs / 1000)}s`)), spec.timeoutMs);
    const onAbort = (): void => kill(new ProcessError("aborted", "cancelled"));
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const collect = (chunk: Buffer, target: "out" | "err"): void => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        kill(new ProcessError("output_limit", "output too large"));
        return;
      }
      if (target === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "out"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "err"));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(new ProcessError(error.code === "ENOENT" ? "not_found" : "spawn", error.code ?? "spawn failed")));
    });
    child.on("close", (exitCode) => {
      finish(() => (failure ? reject(failure) : resolve({ stdout, stderr, exitCode })));
    });
    // A child that exits before reading stdin raises EPIPE; the exit code reports the real problem.
    child.stdin.on("error", () => {});
    child.stdin.end(spec.stdin);
  });

/** Make a private empty directory to run a CLI in (no repository, no project files to wander into). */
export function makeScratchDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Is `command` runnable? An absolute/relative path is checked directly, a bare name is looked up on PATH. */
export function findExecutable(command: string, env: Record<string, string | undefined> = process.env): string | null {
  const candidates = command.includes(path.sep)
    ? [command]
    : (env.PATH ?? "")
        .split(path.delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * The only environment a CLI child receives. Everything else (database URL, other providers' keys,
 * the parent's own Claude Code session variables) stays out of the child (C4).
 */
const CHILD_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function childEnv(source: Record<string, string | undefined>, extra: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...CHILD_ENV_ALLOW, ...extra]) {
    const value = source[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

/** Map a failed spawn to a provider error. */
export function processFailure(provider: AiProviderId, command: string, error: unknown): AiProviderError {
  if (error instanceof ProcessError) {
    switch (error.kind) {
      case "not_found":
        return new AiProviderError(provider, "not_configured", `command "${command}" not found`);
      case "timeout":
        return new AiProviderError(provider, "timeout", error.message);
      case "aborted":
        return new AiProviderError(provider, "aborted", error.message);
      default:
        return new AiProviderError(provider, "provider_error", error.message);
    }
  }
  return new AiProviderError(provider, "provider_error", error instanceof Error ? error.message : "process failed");
}
