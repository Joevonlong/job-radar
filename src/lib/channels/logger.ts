import type { ChannelLogger } from "./types";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Field names whose values are never written to a log (C4). Matched case-insensitively as substrings. */
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|credential|session|headers|body|payload/i;
const MAX_STRING = 300;
const MAX_DEPTH = 3;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  return redactFields(value as Record<string, unknown>, depth + 1);
}

/** Copy of `fields` with sensitive keys replaced by "[redacted]" and long values shortened. */
export function redactFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(value, depth);
  }
  return out;
}

/** Strip query string and fragment from a URL so tokens in them never reach a log. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export interface LogRecord {
  at: Date;
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

const consoleSink: LogSink = (record) => {
  const fields = Object.keys(record.fields).length > 0 ? ` ${JSON.stringify(record.fields)}` : "";
  const line = `${record.at.toISOString()} ${record.level.toUpperCase()} ${record.message}${fields}`;
  (record.level === "error" ? console.error : record.level === "warn" ? console.warn : console.log)(line);
};

export interface LoggerOptions {
  sink?: LogSink;
  minLevel?: LogLevel;
  fields?: Record<string, unknown>;
  now?: () => Date;
}

/** Structured logger: one line per record, fields redacted before they reach the sink. */
export function createLogger(options: LoggerOptions = {}): ChannelLogger {
  const sink = options.sink ?? consoleSink;
  const min = LEVEL_ORDER[options.minLevel ?? "info"];
  const now = options.now ?? (() => new Date());
  const base = options.fields ?? {};

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < min) return;
    sink({ at: now(), level, message, fields: redactFields({ ...base, ...fields }) });
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

export const silentLogger: ChannelLogger = createLogger({ sink: () => {} });
