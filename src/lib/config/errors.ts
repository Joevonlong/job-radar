import type { ZodError } from "zod";

/**
 * `version`: the file's `config_version` is newer than this code supports (a downgrade).
 * `stale`: the file changed on disk (or moved to another layer) since the editor read it.
 * `too_large`: the text is longer than `ui.yaml: config_editor.max_bytes`.
 * `protected`: the write would change a protected key (`protected-keys.ts`); those are edited by hand in the file.
 */
export type ConfigErrorKind = "missing" | "read" | "yaml" | "schema" | "version" | "stale" | "too_large" | "protected";

export interface ConfigIssue {
  /** Dotted field path, e.g. `cycles.weekend.cron`. Empty string = the document root. */
  path: string;
  message: string;
}

const MAX_ISSUES_IN_MESSAGE = 20;

/**
 * Raised for any problem with a config file. Carries the file path and the
 * offending field paths; it never contains the file contents or field values.
 */
export class ConfigError extends Error {
  readonly configName: string;
  readonly filePath: string;
  readonly kind: ConfigErrorKind;
  readonly issues: readonly ConfigIssue[];

  constructor(params: {
    configName: string;
    filePath: string;
    kind: ConfigErrorKind;
    issues?: readonly ConfigIssue[];
    detail?: string;
  }) {
    const issues = params.issues ?? [];
    super(formatMessage(params.configName, params.filePath, params.kind, issues, params.detail));
    this.name = "ConfigError";
    this.configName = params.configName;
    this.filePath = params.filePath;
    this.kind = params.kind;
    this.issues = issues;
  }
}

function formatMessage(
  configName: string,
  filePath: string,
  kind: ConfigErrorKind,
  issues: readonly ConfigIssue[],
  detail: string | undefined,
): string {
  const head = {
    missing: `Config "${configName}" not found`,
    read: `Config "${configName}" could not be read`,
    yaml: `Config "${configName}" is not valid YAML`,
    schema: `Config "${configName}" failed validation`,
    version: `Config "${configName}" is from a newer version of Job Radar`,
    stale: `Config "${configName}" changed on disk since it was opened`,
    too_large: `Config "${configName}" text is too large`,
    protected: `Config "${configName}" has protected keys that can only be changed by editing the file by hand (or with JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1)`,
  }[kind];
  const lines = [`${head} (${filePath})${detail ? `: ${detail}` : ""}`];
  for (const issue of issues.slice(0, MAX_ISSUES_IN_MESSAGE)) {
    lines.push(`  - ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`);
  }
  if (issues.length > MAX_ISSUES_IN_MESSAGE) {
    lines.push(`  ... and ${issues.length - MAX_ISSUES_IN_MESSAGE} more`);
  }
  return lines.join("\n");
}

function joinPath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
    .reduce((acc, seg) => (seg.startsWith("[") || acc === "" ? acc + seg : `${acc}.${seg}`), "");
}

/** Flatten zod issues to path/message pairs (one per unrecognized key). */
export function zodIssues(error: ZodError): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ path: joinPath([...issue.path, key]), message: "unknown key" });
      }
    } else {
      out.push({ path: joinPath(issue.path), message: issue.message });
    }
  }
  return out;
}

/** The first problem of a config error as one short line: "providers.mimo.models.0.price: API models need a price ..." (else the message's first line). */
export function firstConfigProblem(error: ConfigError): string {
  const first = error.issues[0];
  if (first) return `${first.path === "" ? "(root)" : first.path}: ${first.message}`;
  return error.message.split("\n")[0] ?? "unreadable";
}
