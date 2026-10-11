/**
 * Leak guard for the README screenshots: before a picture is taken, the page (markup with every attribute, form values)
 * and everything the browser loaded for it (HTML and RSC response bodies, request URLs) are searched for strings of this
 * machine and its owner. A hit fails the run and no picture is written.
 *
 * The patterns are built at run time: the home directory, user name, host name and temp directory of this machine, the
 * repository's absolute path, the generic machine-path and tailnet rules of `scripts/release-check.sh`, e-mail addresses
 * outside the fictional domains, and the private strings of `.release-check.local` / `RELEASE_CHECK_PATTERNS_FILE`
 * (the same file and rules as release-check: one fixed string per line, `#` comments).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ForbiddenPattern {
  /** What it is; never the private string itself (the report must not repeat it). */
  label: string;
  regex: RegExp;
}

export interface MachineFacts {
  homedir: string;
  username: string;
  hostname: string;
  tmpdir: string;
  /** Absolute path of the product repository. */
  repoRoot: string;
}

export function machineFacts(repoRoot: string): MachineFacts {
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? "";
  }
  return { homedir: os.homedir(), username, hostname: os.hostname(), tmpdir: os.tmpdir(), repoRoot };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** User names too generic to search for as a word (they would match ordinary text). */
const GENERIC_NAMES = new Set(["root", "user", "admin", "runner", "node", "demo", "test", "me"]);

/** Path placeholders release-check allows after /Users/ or /Volumes/ (scripts/release-check.sh ALLOWED_PATH_NAMES). */
const ALLOWED_PATH_NAMES = /^(me|test|x|SSD|Other|Data|example|you|user|name|path|work|Library|System)$/;

/** Read the private strings file the way release-check does: one fixed string per line, blank lines and `#` lines skipped. */
export function readPrivateStrings(file: string | undefined): string[] {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The main checkout of a git repository (the parent of `--git-common-dir`); in a worktree that is not `repoRoot`. */
export function mainCheckoutOf(repoRoot: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return common === "" ? undefined : path.dirname(common);
  } catch {
    return undefined;
  }
}

/**
 * The private strings file: `$RELEASE_CHECK_PATTERNS_FILE`, else `.release-check.local` in the repository, else (a git
 * worktree has no copy of the untracked file) the one in the main checkout. Undefined when none exists.
 */
export function privateStringsFile(repoRoot: string, env: Readonly<Record<string, string | undefined>> = process.env, mainCheckout: string | undefined = mainCheckoutOf(repoRoot)): string | undefined {
  if (env.RELEASE_CHECK_PATTERNS_FILE) return env.RELEASE_CHECK_PATTERNS_FILE;
  for (const dir of [repoRoot, mainCheckout]) {
    if (!dir) continue;
    const file = path.join(dir, ".release-check.local");
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

export class MissingPatternsError extends Error {}

/**
 * The private strings for the guard. Without a patterns file (or with an empty one) only the generic rules apply: a
 * loud warning, or a `MissingPatternsError` when `require` is set (`pnpm demo:shots` sets it unless told otherwise).
 */
export function loadPrivateStrings(repoRoot: string, options: { require: boolean; env?: Readonly<Record<string, string | undefined>>; mainCheckout?: string; warn?: (message: string) => void }): { file: string | undefined; strings: string[] } {
  const file = privateStringsFile(repoRoot, options.env ?? process.env, "mainCheckout" in options ? options.mainCheckout : mainCheckoutOf(repoRoot));
  const strings = readPrivateStrings(file);
  if (strings.length === 0) {
    const message = file
      ? "leak guard: the private patterns file has no patterns"
      : "leak guard: no private patterns file (.release-check.local here or in the main checkout, or RELEASE_CHECK_PATTERNS_FILE)";
    if (options.require) throw new MissingPatternsError(`${message}; the pictures would only be checked against the generic rules`);
    (options.warn ?? console.warn)(`WARNING ${message}: only the generic rules apply`);
  }
  return { file, strings };
}

function pathVariants(p: string): string[] {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return [];
  const out = new Set([trimmed]);
  // macOS: /var/folders/... is also seen as /private/var/folders/...
  if (trimmed.startsWith("/private/")) out.add(trimmed.slice("/private".length));
  try {
    out.add(fs.realpathSync(trimmed));
  } catch {
    // gone: the plain string is enough
  }
  return [...out];
}

export function buildForbiddenPatterns(facts: MachineFacts, privateStrings: readonly string[] = []): ForbiddenPattern[] {
  const patterns: ForbiddenPattern[] = [];
  for (const p of pathVariants(facts.homedir)) patterns.push({ label: "home directory", regex: new RegExp(escapeRegex(p)) });
  for (const p of pathVariants(facts.tmpdir)) patterns.push({ label: "temp directory", regex: new RegExp(escapeRegex(p)) });
  for (const p of pathVariants(facts.repoRoot)) patterns.push({ label: "repository path", regex: new RegExp(escapeRegex(p)) });
  if (facts.username.length >= 3 && !GENERIC_NAMES.has(facts.username.toLowerCase())) {
    patterns.push({ label: "user name", regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(facts.username)}(?![A-Za-z0-9])`, "i") });
  }
  const host = facts.hostname.trim();
  if (host !== "" && host.toLowerCase() !== "localhost") {
    for (const name of new Set([host, host.replace(/\.(local|lan|home)$/i, "")])) {
      if (name.length >= 3) patterns.push({ label: "host name", regex: new RegExp(`(?<![A-Za-z0-9-])${escapeRegex(name)}(?![A-Za-z0-9-])`, "i") });
    }
  }
  privateStrings.forEach((value, i) => patterns.push({ label: `private string #${i + 1} of the patterns file`, regex: new RegExp(escapeRegex(value)) }));
  return patterns;
}

/** Machine paths (release-check rule): `/Users/<name>` or `/Volumes/<name>` unless the name is a placeholder. */
function machinePaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\/(Users|Volumes)\/([A-Za-z0-9._-]+)/g)) {
    if (!ALLOWED_PATH_NAMES.test(m[2] ?? "")) out.push(m[0]);
  }
  return out;
}

/** Tailnet host names (release-check rule): `<name>.ts.net` unless it is one of the documented placeholders. */
function tailnetHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net/g)) {
    if (!/^(MACHINE\.TAILNET|[a-z]+\.example(-tailnet|-other)?)\.ts\.net$/.test(m[0])) out.push(m[0]);
  }
  return out;
}

/** File extensions that look like a top-level domain after an `@` (`icon@2x.png`): not e-mail addresses. */
const FILE_EXTENSIONS = /^(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|json|woff2?|ttf|otf|txt|html?)$/i;

/** Whether an e-mail domain is a fictional one: `example.<tld>`, `<name>.example`, `.invalid`, `.test`. */
export function isFictionalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return /^(.+\.)?example(\.[a-z]+)?$/.test(d) || d.endsWith(".example") || d.endsWith(".invalid") || d.endsWith(".test");
}

/** E-mail addresses whose domain is not fictional. */
export function realEmails(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
    const domain = m[1] ?? "";
    const tld = domain.split(".").pop() ?? "";
    if (!/^[A-Za-z]{2,}$/.test(tld) || FILE_EXTENSIONS.test(tld)) continue;
    if (!isFictionalDomain(domain)) out.push(m[0]);
  }
  return out;
}

export interface Leak {
  label: string;
  /** Where it was found (page markup, a response URL, ...). */
  where: string;
  /** A short excerpt around the hit; private strings are masked. */
  excerpt: string;
}

function excerptAround(text: string, index: number, length: number, mask: boolean): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const hit = mask ? "<redacted>" : text.slice(index, index + length);
  return `${text.slice(start, index)}${hit}${text.slice(index + length, end)}`.replace(/\s+/g, " ");
}

/** Every leak in `text`. */
export function findLeaks(text: string, patterns: readonly ForbiddenPattern[], where: string): Leak[] {
  const leaks: Leak[] = [];
  for (const pattern of patterns) {
    const m = pattern.regex.exec(text);
    if (m) leaks.push({ label: pattern.label, where, excerpt: excerptAround(text, m.index, m[0].length, true) });
  }
  for (const hit of machinePaths(text)) leaks.push({ label: "machine path", where, excerpt: hit });
  for (const hit of tailnetHosts(text)) leaks.push({ label: "tailnet host name", where, excerpt: hit });
  for (const hit of realEmails(text)) leaks.push({ label: "e-mail address outside the fictional domains", where, excerpt: hit });
  return leaks;
}

/**
 * The page as text for the guard: the whole markup (attributes, titles, tooltips included) and the current value of every
 * input and textarea (a typed value is not in the markup). Runs in the browser (passed to `page.evaluate`): self-contained.
 */
export function serializeDocument(): string {
  const values = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => (el as HTMLInputElement).value ?? "");
  return `${document.documentElement.outerHTML}\n${values.join("\n")}`;
}

export class LeakError extends Error {
  constructor(readonly leaks: Leak[]) {
    super(`leak guard: ${leaks.length} hit(s), no picture written:\n${leaks.map((l) => `  ${l.label} in ${l.where}: ${l.excerpt}`).join("\n")}`);
  }
}

/** The bits of a Playwright page the guard needs (a fake in the unit tests). */
export interface GuardedPage {
  evaluate<R>(fn: () => R): Promise<R>;
  screenshot(options: { path: string; animations?: "disabled" | "allow"; fullPage?: boolean }): Promise<unknown>;
}

/** Collects what the browser loaded since the last check (HTML / RSC bodies, request URLs). */
export class TrafficLog {
  private entries: Array<{ where: string; text: string }> = [];

  add(where: string, text: string): void {
    this.entries.push({ where, text });
  }

  drain(): Array<{ where: string; text: string }> {
    const out = this.entries;
    this.entries = [];
    return out;
  }
}

/** Check the page and the traffic; throw a `LeakError` (and take no picture) on a hit, else write the picture. */
/** Throw a `LeakError` when the page (markup, form values) or the recorded traffic holds a forbidden string. */
export async function assertNoLeaks(page: Pick<GuardedPage, "evaluate">, patterns: readonly ForbiddenPattern[], traffic?: TrafficLog): Promise<void> {
  const leaks = findLeaks(await page.evaluate(serializeDocument), patterns, "page markup and form values");
  for (const entry of traffic?.drain() ?? []) leaks.push(...findLeaks(entry.text, patterns, entry.where));
  if (leaks.length > 0) throw new LeakError(leaks);
}

export async function guardedScreenshot(page: GuardedPage, file: string, patterns: readonly ForbiddenPattern[], traffic?: TrafficLog): Promise<void> {
  await assertNoLeaks(page, patterns, traffic);
  await page.screenshot({ path: file, animations: "disabled", fullPage: false });
}
