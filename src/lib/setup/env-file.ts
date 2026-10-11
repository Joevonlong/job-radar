/**
 * Change a few keys of the local `.env` file (host side, `pnpm run setup`): every other line, comment and the order stay
 * exactly as they were. The file is backed up first (`.env.backup-<time>`, mode 0600), written to a temporary file in
 * the same directory and renamed over the original (atomic), and ends up with mode 0600. A missing `.env` is created
 * from `.env.example`. Values never appear in an error message or a result (C4): only key names do.
 */
import fs from "node:fs";
import path from "node:path";

/** `KEY=` at the start of a line (spaces and an `export ` prefix allowed), not a comment. */
function keyOf(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match?.[1] ?? null;
}

const SAFE_VALUE = /^[A-Za-z0-9_:,\-]*$/;

/**
 * The parts of a `KEY=value` line kept when its value changes: what comes before the value (indent, `export `, the key,
 * `=`) and a trailing inline comment (` # ...` after an unquoted value, or anything after the closing quote of a quoted one).
 */
function splitLine(line: string): { head: string; comment: string } {
  const eq = line.indexOf("=");
  const head = line.slice(0, eq + 1);
  const rest = line.slice(eq + 1);
  const quote = /^\s*(["'`])/.exec(rest);
  if (quote !== null) {
    const open = rest.indexOf(quote[1] as string);
    const close = rest.indexOf(quote[1] as string, open + 1);
    if (close < 0) return { head, comment: "" };
    const after = rest.slice(close + 1);
    return { head, comment: /^\s*#/.test(after) ? after : "" };
  }
  const hash = /\s+#/.exec(rest);
  return { head, comment: hash === null ? "" : rest.slice(hash.index) };
}

/**
 * The new text: for each key in `changes`, the first line that sets it gets the new value (`null` removes the line), any
 * later line setting the same key is dropped (one value per key, whatever reader wins on duplicates); keys without a
 * line are appended at the end in the order given. Pure.
 */
export function applyEnvChanges(text: string, changes: Readonly<Record<string, string | null>>): string {
  for (const [key, value] of Object.entries(changes)) {
    if (keyOf(`${key}=`) !== key) throw new Error(`not an environment variable name: ${key}`);
    // only the characters bot tokens, chat ids and id lists use: no quoting, no line breaks, nothing to escape
    if (value !== null && !SAFE_VALUE.test(value)) throw new Error(`the value for ${key} has characters that cannot be written to .env`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null || !(key in changes)) {
      out.push(line);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const value = changes[key];
    if (value === null || value === undefined) continue;
    const { head, comment } = splitLine(line);
    out.push(`${head.replace(/\s*=$/, "=")}${value}${comment}`);
  }
  for (const [key, value] of Object.entries(changes)) if (!done.has(key) && value !== null) out.push(`${key}=${value}`);
  return out.length === 0 ? "" : `${out.join(eol)}${eol}`;
}

export interface EnvFileUpdate {
  /** The `.env` that was written. */
  file: string;
  /** The copy of the previous file; null when there was none. */
  backup: string | null;
  /** True when `.env` did not exist and was created (from `.env.example` when there is one). */
  created: boolean;
}

export interface UpdateEnvFileOptions {
  /** The `.env` to change. */
  file: string;
  /** Template for a missing `.env` (default: `.env.example` next to it). */
  example?: string;
  changes: Readonly<Record<string, string | null>>;
  now?: Date;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Write `content` next to `target` with mode 0600, flush it, then rename it over `target`. */
function writeAtomic(target: string, content: string): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** The file a (possibly symlinked) `.env` stands for: the rename then replaces the target, not the link. */
function realTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    // missing, or a link to a file that does not exist yet: follow the link by hand
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return path.resolve(path.dirname(file), fs.readlinkSync(file));
    } catch {
      // no file at all
    }
    return file;
  }
}

/** Back up, change and atomically replace `.env` (through a symlink: its target). Throws (naming no value) when it cannot read or write. */
export function updateEnvFile(options: UpdateEnvFileOptions): EnvFileUpdate {
  const { changes } = options;
  const file = options.file;
  const target = realTarget(file);
  const example = options.example ?? path.join(path.dirname(file), ".env.example");
  const now = options.now ?? new Date();
  let before: string | null = null;
  try {
    before = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error(`cannot read ${file}`, { cause: error });
  }
  // the new text first: a refused value must not leave a backup (or anything else) behind
  const next = applyEnvChanges(before ?? (fs.existsSync(example) ? fs.readFileSync(example, "utf8") : ""), changes);
  let backup: string | null = null;
  if (before !== null) {
    backup = `${file}.backup-${stamp(now)}`;
    for (let n = 2; fs.existsSync(backup); n += 1) backup = `${file}.backup-${stamp(now)}-${n}`;
    const fd = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, before);
    } finally {
      fs.closeSync(fd);
    }
  }
  writeAtomic(target, next);
  return { file, backup, created: before === null };
}
