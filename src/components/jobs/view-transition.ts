export type JobViewTransitionPart = "title" | "score";
export function jobViewTransitionName(id: string | number, part: JobViewTransitionPart): string {
  return `job-${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}-${part}`;
}
