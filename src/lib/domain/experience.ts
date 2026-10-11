export function isValidExperienceRange(min: number | null, max: number | null): boolean {
  return min == null || max == null || min <= max;
}

export function formatExperienceRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Not explicitly stated";
  if (min == null) return `Up to ${max} years`;
  if (max == null) return `${min}+ years`;
  return min === max ? `${min} years` : `${min}–${max} years`;
}
