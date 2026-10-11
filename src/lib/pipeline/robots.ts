/**
 * robots.txt for the recheck of watched jobs (RFC 9309, the parts a single page fetch needs). The file is untrusted text:
 * it is only parsed. Groups are chosen by the product token of our User-Agent (exact, case-insensitive), else the `*` group (only
 * those groups' rules are kept, capped per group, failing closed beyond the cap); inside a
 * group the longest matching rule wins and `Allow` wins a tie; `*` matches any run of characters and a trailing `$` anchors the end.
 */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  /** Kept only for a group that names us or `*` (the only ones that can apply); other crawlers' rules are skipped unread. */
  rules: Rule[];
  /** More than MAX_ROBOTS_RULES rules, or a pattern longer than MAX_PATTERN_LENGTH: the group is not fully known (fail closed). */
  overflow: boolean;
}

/** Longest robots.txt read (RFC 9309 asks crawlers to read at least 500 KiB). */
export const MAX_ROBOTS_BYTES = 512 * 1024;
/**
 * Most Allow / Disallow rules of one group that applies to us (ours or `*`); bounds the work per URL. Other crawlers' groups are not
 * counted (LinkedIn lists ~4,700 rules for named bots before its `*` group). A group over the cap is not fully known: DISALLOW_ALL.
 */
export const MAX_ROBOTS_RULES = 500;
/** Longest pattern of a group that applies to us; a longer one also makes the group unknown (DISALLOW_ALL). */
export const MAX_PATTERN_LENGTH = 512;

export interface RobotsPolicy {
  /** Whether `path` (path and query of the URL) may be fetched. */
  allows(path: string): boolean;
}

export const ALLOW_ALL: RobotsPolicy = { allows: () => true };
export const DISALLOW_ALL: RobotsPolicy = { allows: () => false };

/** The product token of a User-Agent string: "JobRadar/2 (…)" → "jobradar". */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/u)[0] ?? "").toLowerCase();
}

/** The group names our crawler (by its exact product token) or every crawler (`*`). */
function applies(agents: readonly string[], token: string): boolean {
  return agents.some((agent) => agent === "*" || (token !== "" && agent !== "" && productToken(agent) === token));
}

/** The groups of a robots.txt; rules are kept (and capped) only for the groups that can apply to `token`. */
function parseGroups(text: string, token: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let relevant = false;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], overflow: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    // the agent lines come first, so whether the group applies is known before its first rule
    if (lastWasAgent && current) relevant = applies(current.agents, token);
    lastWasAgent = false;
    if (!current || !relevant || current.overflow) continue;
    if (key === "allow" || key === "disallow") {
      // an empty Disallow allows everything: no rule
      if (value === "") continue;
      if (value.length > MAX_PATTERN_LENGTH || current.rules.length >= MAX_ROBOTS_RULES) {
        current.overflow = true;
        current.rules = [];
        continue;
      }
      current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  return groups;
}

/**
 * Does a robots.txt pattern match `path`? A linear glob, no regex (the file is untrusted; a backtracking regex of many `*` could
 * take exponential time): runs of `*` collapse to one, the part before the first `*` is a prefix, each later part is found with
 * indexOf from where the previous one ended (leftmost is always right for `*`-only globs), and a trailing `$` anchors the last part
 * to the end.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).replace(/\*+/gu, "*").split("*");
  const first = parts[0] ?? "";
  if (parts.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let at = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  const last = parts[parts.length - 1]!;
  if (anchored) return path.length - last.length >= at && path.endsWith(last);
  return last === "" || path.indexOf(last, at) >= 0;
}

/** Percent-decoding differences between the file and the URL are ignored by comparing both decoded where possible. */
function normalise(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** The policy of a robots.txt for the crawler named `userAgent`. */
export function parseRobots(text: string, userAgent: string): RobotsPolicy {
  const token = productToken(userAgent);
  const groups = parseGroups(text, token);
  const own = token === "" ? [] : groups.filter((g) => g.agents.some((agent) => agent !== "*" && agent !== "" && productToken(agent) === token));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  // a group that applies to us but could not be read whole: we do not know what it forbids, so nothing is fetched
  if (chosen.some((g) => g.overflow)) return DISALLOW_ALL;
  const rules = chosen.flatMap((g) => g.rules).map((rule) => ({ ...rule, pattern: normalise(rule.pattern) }));
  if (rules.length === 0) return ALLOW_ALL;
  return {
    allows(path: string): boolean {
      const target = normalise(path === "" ? "/" : path);
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!patternMatches(rule.pattern, target)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) best = rule;
      }
      return best === null || best.allow;
    },
  };
}
