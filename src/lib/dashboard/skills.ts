/**
 * Skill overlap of a job with the profile (me.yaml), for the skill cells of the job list.
 *
 * A job lists the skill names the pipeline found (`jobs.skills`, canonical names of pipeline.yaml `skills`); me.yaml lists the
 * user's own spelling. Both are reduced to one key so "Python", "python 3" and "PYTHON" meet, and pipeline.yaml `skills[].aliases`
 * ("k8s", "Large Language Models") map other names onto the canonical one. Nothing is matched fuzzily beyond that: a skill the
 * profile does not name is a miss.
 */

export interface SkillAliasEntry {
  name: string;
  aliases?: readonly string[];
}

export interface SkillMatch {
  name: string;
  /** The profile names this skill. */
  have: boolean;
}

/**
 * Comparison key of a skill name: lower case, no accents, only letters, digits, `+` and `#` (so "C++" and "C#" stay distinct
 * from "C"), and a trailing plural "s" dropped on names longer than three characters ("LLMs" = "LLM", "Vector DBs" = "vectordb").
 */
export function skillKey(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]/gu, "");
  return base.length > 3 && base.endsWith("s") ? base.slice(0, -1) : base;
}

/** alias key -> canonical key, from pipeline.yaml `skills` (the canonical name maps to itself). */
export function buildSkillAliasMap(entries: readonly SkillAliasEntry[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const canonical = skillKey(entry.name);
    if (canonical === "") continue;
    map.set(canonical, canonical);
    for (const alias of entry.aliases ?? []) {
      const key = skillKey(alias);
      // the first claim on an alias wins: a name never silently moves to another skill
      if (key !== "" && !map.has(key)) map.set(key, canonical);
    }
  }
  return map;
}

/**
 * The skills one profile entry names. People write "LLM / RAG", "Kubernetes (k8s)" or "Docker, Compose" in one line: the entry
 * is split at ` / `, `|`, `·`, `,`, `;`, ` & ` and at brackets, so each part is a skill of its own. A slash
 * without spaces is part of the name ("CI/CD", "TCP/IP"), and so is the `+` of "C++". The whole entry is kept as one more
 * spelling, so a job that names exactly "CI / CD" still matches.
 */
export function splitProfileSkill(name: string): string[] {
  const whole = name.trim();
  if (whole === "") return [];
  const parts = whole
    .split(/\s+[/|·&]\s+|\s*[,;，；、|]\s*|\s*[()（）[\]]\s*/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 1 ? [whole, ...parts] : [whole];
}

/** The set of canonical skill keys the profile names (an entry that lists several skills names each of them). */
export function profileSkillKeys(profileSkills: readonly string[], aliases: ReadonlyMap<string, string> = new Map()): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const name of profileSkills) {
    for (const part of splitProfileSkill(name)) {
      const key = skillKey(part);
      if (key !== "") keys.add(aliases.get(key) ?? key);
    }
  }
  return keys;
}

/** Each skill of the job with whether the profile has it. A job without listed skills gives an empty list (shown as "—", never 0/0). */
export function matchSkills(jobSkills: readonly string[], profile: ReadonlySet<string>, aliases: ReadonlyMap<string, string> = new Map()): SkillMatch[] {
  const seen = new Set<string>();
  const out: SkillMatch[] = [];
  for (const name of jobSkills) {
    const key = skillKey(name);
    if (key === "") continue;
    const canonical = aliases.get(key) ?? key;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ name, have: profile.has(canonical) });
  }
  return out;
}
