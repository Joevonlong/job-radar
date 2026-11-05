import type { Resume } from "./schema";

export const FILENAME_VARS = ["name", "company", "role", "lang", "date"] as const;

const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const FOLD: Record<string, string> = {
  ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss", ẞ: "SS",
  æ: "ae", Æ: "Ae", œ: "oe", Œ: "Oe", ø: "o", Ø: "O", ł: "l", Ł: "L", đ: "d", Đ: "D", þ: "th", Þ: "Th",
};

export function ascii(s: string, sep = "-"): string {
  const folded = s.replace(/[äöüÄÖÜßẞæÆœŒøØłŁđĐþÞ]/g, (c) => FOLD[c]).normalize("NFKD").replace(/\p{M}/gu, "");
  return folded.split(/[^A-Za-z0-9]+/).filter(Boolean).join(sep);
}

export function personName(name: string): string {
  const latin = name.trim().split(/\s+/).map((p) => ascii(p)).filter(Boolean).join("_");
  return latin || name.replace(FORBIDDEN, "").trim().split(/\s+/).filter(Boolean).join("_");
}

const role = (s: string) => ascii(s.replace(/\(.*?\)/g, " "));

export function templateProblem(t: string): string | undefined {
  if (/[/\\]/.test(t)) return "filename can't contain / or \\ — it is a file name inside the exports folder, not a path";
  if (/[\u0000-\u001f\u007f]/.test(t)) return "filename can't contain control characters or line breaks";
  const unknown = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((v) => !(FILENAME_VARS as readonly string[]).includes(v));
  if (unknown.length) return `unknown variable {${unknown[0]}} in filename — use ${FILENAME_VARS.map((v) => `{${v}}`).join(", ")}`;
  if (!t.replace(/\.pdf$/i, "").trim()) return "filename must not be empty";
}

export function exportStem(r: Resume, date = new Date().toLocaleDateString("sv-SE"), doc: "resume" | "letter" = "resume"): string {
  const vars: Record<string, string> = {
    name: personName(r.basics.name),
    company: ascii(r.target?.company ?? ""),
    role: role(r.target?.role ?? ""),
    lang: r.meta.lang,
    date,
  };

  const word = doc === "letter" ? (r.meta.lang === "de" ? "Anschreiben" : "Cover_Letter") : r.meta.lang === "de" ? "Lebenslauf" : "CV";
  const raw = r.meta.filename && doc === "resume"
    ? r.meta.filename.replace(/\.pdf$/i, "").replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "")
    : [vars.name, word, vars.company].filter(Boolean).join("_");
  const clean = raw
    .replace(FORBIDDEN, "")
    .replace(/([_\-. ])[_\-. ]+/g, "$1")
    .replace(/^[_\-. ]+|[_\-. ]+$/g, "");
  return clean || "CV";
}

export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}
