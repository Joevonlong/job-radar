import { findPii, type PiiKind } from "@/lib/stories/pii";

export function profilePiiWarnings(value: unknown): PiiKind[] {
  const found = new Set<PiiKind>();
  function visit(item: unknown): void {
    if (typeof item === "string") findPii(item).forEach((kind) => found.add(kind));
    else if (Array.isArray(item)) item.forEach(visit);
    else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit);
  }
  visit(value);
  return (["email", "phone"] as const).filter((kind) => found.has(kind));
}
