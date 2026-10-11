import { SENIORITIES, type Seniority } from "./types";

export function isSeniority(value: string | undefined | null): value is Seniority {
  return value != null && (SENIORITIES as readonly string[]).includes(value);
}

/**
 * Seniority as the title (or a channel's hint) words it. A level is never derived from required
 * years of experience: that would be a guess (C3).
 */
export function inferSeniority(title: string): Seniority {
  if (/\bintern(ship)?\b|\bpraktik(?:ant|antin|um)\b|\bstagiaire\b|\bwerkstudent/i.test(title)) return "intern";
  if (/\bjunior\b|\bentry.level\b|\bgraduate\b|\bberufseinsteig(?:er|erin)\b|débutant(?:e)?/i.test(title)) return "junior";
  if (/\bmid[ -]?level\b|\bintermediate\b|\bmedior\b/i.test(title)) return "mid";
  if (/\bprincipal\b/i.test(title)) return "principal";
  if (/\bstaff\b/i.test(title)) return "staff";
  if (/\blead\b|\bhead of\b/i.test(title)) return "lead";
  if (/\bmanager\b|\bdirector\b/i.test(title)) return "manager";
  if (/\bsenior\b|\bsr\.?\b/i.test(title)) return "senior";
  return "unknown";
}
