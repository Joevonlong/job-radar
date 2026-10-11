import type { AiProviderId, AiTask } from "./types";

/**
 * The ONE exception to "AI calls never get tools". Every provider call runs without tools (no shell, no files, no
 * web), except the tasks named here, which may search the public web. The list is written in code on purpose: ai.yaml
 * (editable from the web UI) can neither add a task nor switch a tool on. Each transport asks `webAccessAllowed(task,
 * provider)` itself before it builds a call with web tools, and the ai-worker's handler asks again before it runs one; an
 * option a caller passes (`AiRunOptions.web`, `requireWeb`) only chooses providers and limits, it never grants the tools.
 */
export const WEB_ACCESS_TASKS: ReadonlySet<AiTask> = new Set<AiTask>(["salary_lookup"]);

/**
 * Providers whose transport can search the web for a web task: claude-cli (WebSearch + WebFetch on pre-approved domains),
 * codex-cli (its built-in web search, no domain limit), anthropic (the server-side web_search tool). The OpenAI-compatible
 * providers (deepseek, mimo) cannot and are skipped for a web task.
 */
export const WEB_CAPABLE_PROVIDERS: ReadonlySet<AiProviderId> = new Set<AiProviderId>(["claude-cli", "codex-cli", "anthropic"]);

/** Providers whose web search cannot be limited to domains (shown as such in the settings). */
export const UNRESTRICTED_WEB_PROVIDERS: ReadonlySet<AiProviderId> = new Set<AiProviderId>(["codex-cli"]);

export function isWebTask(task: AiTask): boolean {
  return WEB_ACCESS_TASKS.has(task);
}

export function webCapable(provider: AiProviderId): boolean {
  return WEB_CAPABLE_PROVIDERS.has(provider);
}

/** The policy check every transport and the ai-worker make: may this call of `task` on `provider` reach the web? */
export function webAccessAllowed(task: AiTask, provider: AiProviderId): boolean {
  return isWebTask(task) && webCapable(provider);
}

/**
 * A domain name the claude-cli and the anthropic transport accept for their domain lists: lower-case letters, digits,
 * dots and dashes, at least one dot, no leading dot or dash (never an option, never a pattern), and not a public suffix
 * (`isPublicSuffixLike`). Anything else is dropped.
 */
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Second-level labels that countries use as registries (`co.uk`, `com.au`, `ac.jp`): `<label>.<two-letter TLD>` is one. */
const REGISTRY_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "gouv", "ltd", "plc", "mil", "nic", "info", "biz"]);
/** Shared hosting suffixes under which anyone gets a subdomain. */
const SHARED_SUFFIXES = new Set(["github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com", "web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "glitch.me", "fly.dev", "onrender.com", "wordpress.com", "substack.com", "medium.com"]);

/**
 * A name that is (or looks like) a public suffix rather than one site: a single label, a country registry such as `co.uk`
 * or `com.au`, or a shared hosting suffix such as `github.io`. Allowing one would allow every site under it.
 */
export function isPublicSuffixLike(value: string): boolean {
  const labels = value.trim().toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2) return true;
  if (labels.length === 2 && /^[a-z]{2}$/.test(labels[1] ?? "") && REGISTRY_LABELS.has(labels[0] ?? "")) return true;
  return SHARED_SUFFIXES.has(labels.join("."));
}

export function isSafeDomain(value: string): boolean {
  return DOMAIN.test(value) && !isPublicSuffixLike(value);
}

/** The usable domains of a list (lower-cased, deduplicated, invalid ones dropped). */
export function safeDomains(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(isSafeDomain))];
}

/**
 * What a web task's caller passes down (`AiRunOptions.web` -> `AiTransportRequest.web`): limits, never permission.
 * `budget` is shared by every call of one run (the validation retry, the next provider): a transport that can count
 * searches (anthropic) takes them off `remaining`, so one lookup never searches more than `maxSearches` times in total.
 */
export interface WebAccessLimits {
  /** Domains claude-cli may fetch pages from and anthropic may take search results from (validated by `safeDomains`). */
  allowedDomains: readonly string[];
  maxSearches: number;
  budget: { remaining: number };
}

export function webLimits(allowedDomains: readonly string[], maxSearches: number): WebAccessLimits {
  return { allowedDomains: safeDomains(allowedDomains), maxSearches, budget: { remaining: maxSearches } };
}
