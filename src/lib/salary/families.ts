import type { RoleFamilyConfig } from "@/lib/config/schemas/salary";

/** A compiled role family: the first one whose pattern matches a title is that title's family. */
export interface CompiledFamily {
  id: string;
  label: RoleFamilyConfig["label"];
  patterns: RegExp[];
}

export interface FamilyMatcher {
  families: readonly CompiledFamily[];
  /** The family id of a job title, or null when no family matches (the job is not part of the benchmark). */
  familyOf(title: string): string | null;
  label(id: string, locale: string): string;
}

/** Compile `salary.yaml: role_families` (patterns with flags "iu", like the interest categories). */
export function compileFamilies(families: readonly RoleFamilyConfig[]): FamilyMatcher {
  const compiled: CompiledFamily[] = families.map((family) => ({ id: family.id, label: family.label, patterns: family.patterns.map((source) => new RegExp(source, "iu")) }));
  return {
    families: compiled,
    familyOf(title) {
      const text = title.replace(/\s+/g, " ").trim();
      if (text === "") return null;
      for (const family of compiled) if (family.patterns.some((pattern) => pattern.test(text))) return family.id;
      return null;
    },
    label(id, locale) {
      const family = compiled.find((entry) => entry.id === id);
      if (!family) return id;
      const zh = locale.startsWith("zh");
      return (zh ? (family.label.zh ?? family.label.en) : (family.label.en ?? family.label.zh)) ?? id;
    },
  };
}
