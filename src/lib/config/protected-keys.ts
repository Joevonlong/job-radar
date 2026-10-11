/**
 * Protected config keys: values that decide which program is started, where a request carrying a credential goes, or
 * which credential file is read. The web (settings forms, advanced editor, setup wizard, any write through `writeConfig` /
 * `writeConfigText`) may not change them; they are edited by hand in the file. The host processes (runner, ai-worker) run
 * with every secret of `.env`, so a value written through the web must never be able to send a key elsewhere or start a
 * program of the writer's choice.
 *
 * The rule (checked in `write.ts` and by the advanced editor's live validation): a submitted value of a protected key
 * must equal the value on disk now, or the shipped default's value. Setting `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` in the
 * environment of the web process switches the check off.
 *
 * Pure data and pure functions, no server-only imports: the settings forms use `isProtectedPath` to show the fields locked.
 */
import type { ConfigName } from "./registry";

/** Environment variable that, set to `1`, lets the web change protected keys. */
export const ALLOW_PROTECTED_EDIT_ENV = "JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED";

/**
 * Per config file, the protected key paths. Segments are separated by dots; `*` stands for exactly one key, `**` for any
 * number of keys (zero included). A pattern names a whole value: `providers.codex_cli.config_overrides` covers every
 * override in it.
 */
export const PROTECTED_KEYS: Readonly<Partial<Record<ConfigName, readonly string[]>>> = {
  ai: [
    // the subscription CLIs: the program spawned for every AI call
    "providers.*.command",
    // the API providers: the bearer key goes to this URL
    "providers.*.base_url",
    // passed to `codex exec -c key=value`; can configure extra programs or another model endpoint
    "providers.codex_cli.config_overrides",
    // the codex tools switched off for every call, and the switch that applies them
    "providers.codex_cli.disable_features",
    "providers.codex_cli.trim_context",
  ],
  notify: [
    // the bot token is part of every request URL
    "telegram.api_base_url",
  ],
  channels: [
    // every channel's API host (API keys travel in headers or query strings)
    "**.base_url",
    "**.api_base_url",
    "**.eu_api_base_url",
    // the scraping sidecar, and the proxies it sends every scrape through (they may carry credentials)
    "jobspy.url",
    "jobspy.proxies",
    // the Apify actor run with the account's token (and billed to it)
    "linkedin.apify.actor_id",
    // the IMAP server the Gmail app password is sent to
    "sources.gmail.host",
    "sources.gmail.port",
    "sources.gmail.secure",
    // the browser login state read by the LinkedIn session channel
    "linkedin.session.site.auth_file",
  ],
  ui: [
    // the login session length and the failed-login limits of the optional web password
    "web_access.**",
  ],
  resume: [
    // pasted unquoted into the shell command shown on a job page
    "claude_command",
    "claude_args",
    // the paths of that command (the directory Claude Code runs in, the files it is told to read) and the directories the
    // web writes exports to and attaches PDFs from
    "resume_kit_path",
    "master_resume_path",
    "pdf_dir",
    "jd_export_dir",
    "jd_export_host_dir",
  ],
};

/** The protected patterns of one config file (empty when it has none). */
export function protectedPatterns(name: ConfigName): readonly string[] {
  return PROTECTED_KEYS[name] ?? [];
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) if (matchSegments(rest, path.slice(skip))) return true;
    return false;
  }
  if (path.length === 0) return false;
  return (head === "*" || head === path[0]) && matchSegments(rest, path.slice(1));
}

/** Whether a dotted key path (`providers.claude_cli.command`) is protected or lies inside a protected value. */
export function isProtectedPath(name: ConfigName, path: string): boolean {
  const segments = path.split(".");
  return protectedPatterns(name).some((pattern) => {
    const parts = pattern.split(".");
    // the path itself, or a key inside a protected value (`providers.codex_cli.config_overrides.web_search`)
    for (let length = segments.length; length >= 1; length--) if (matchSegments(parts, segments.slice(0, length))) return true;
    return false;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(value: unknown, pattern: readonly string[], at: readonly string[], out: Map<string, { path: string[]; value: unknown }>): void {
  if (pattern.length === 0) {
    out.set(JSON.stringify(at), { path: [...at], value });
    return;
  }
  const [head, ...rest] = pattern;
  if (head === "**") {
    collect(value, rest, at, out);
    if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) collect(child, pattern, [...at, key], out);
    // lists too: a URL inside a list of blocks is as protected as one in a map
    if (Array.isArray(value)) value.forEach((child, index) => collect(child, pattern, [...at, String(index)], out));
    return;
  }
  if (!isPlainObject(value)) return;
  if (head === "*") {
    for (const [key, child] of Object.entries(value)) collect(child, rest, [...at, key], out);
    return;
  }
  if (head !== undefined && Object.hasOwn(value, head)) collect(value[head], rest, [...at, head], out);
}

/** Every protected value present in a config value, keyed by its path (as JSON of the segments). */
export function protectedValues(name: ConfigName, value: unknown): Map<string, { path: string[]; value: unknown }> {
  const out = new Map<string, { path: string[]; value: unknown }>();
  for (const pattern of protectedPatterns(name)) collect(value, pattern.split("."), [], out);
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * The protected keys whose value in `next` is neither the value in `current` (what is on disk now; null when unreadable)
 * nor the value in `shipped` (the shipped default; null when there is none). Each as its key segments. Pure.
 */
export function changedProtectedPaths(name: ConfigName, next: unknown, current: unknown, shipped: unknown): string[][] {
  if (protectedPatterns(name).length === 0) return [];
  const nextValues = protectedValues(name, next);
  const currentValues = current === null ? new Map<string, { path: string[]; value: unknown }>() : protectedValues(name, current);
  const shippedValues = shipped === null ? new Map<string, { path: string[]; value: unknown }>() : protectedValues(name, shipped);
  const changed: string[][] = [];
  for (const key of new Set([...nextValues.keys(), ...currentValues.keys()])) {
    const submitted = nextValues.get(key);
    const onDisk = currentValues.get(key);
    if (submitted !== undefined && onDisk !== undefined && deepEqual(submitted.value, onDisk.value)) continue;
    if (submitted === undefined && onDisk === undefined) continue;
    const shippedEntry = shippedValues.get(key);
    // back to the shipped default: the same value, or a key the default does not have either
    if (submitted !== undefined && shippedEntry !== undefined && deepEqual(submitted.value, shippedEntry.value)) continue;
    if (submitted === undefined && shipped !== null && shippedEntry === undefined) continue;
    changed.push((submitted ?? onDisk)?.path ?? []);
  }
  return changed;
}

/** Whether the environment lets the web change protected keys (`JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1`). Server side only. */
export function protectedEditAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[ALLOW_PROTECTED_EDIT_ENV]?.trim() === "1";
}
