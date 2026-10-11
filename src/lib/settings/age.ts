export type AgeUnit = "seconds" | "minutes" | "hours" | "days";

/** A duration in whole seconds as the largest unit that fits: 45 -> 45 seconds, 7300 -> 2 hours. */
export function ageParts(seconds: number): { unit: AgeUnit; count: number } {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return { unit: "seconds", count: s };
  if (s < 3600) return { unit: "minutes", count: Math.floor(s / 60) };
  if (s < 86_400) return { unit: "hours", count: Math.floor(s / 3600) };
  return { unit: "days", count: Math.floor(s / 86_400) };
}
