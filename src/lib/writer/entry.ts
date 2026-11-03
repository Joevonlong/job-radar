/**
 * Where the job page's "Write answers" entry leads: the workbench when the writer is on or the job already has questions
 * (its saved answers stay reachable after the writer is switched off), else the setting that turns it on.
 */
export function writerEntryHref(input: { jobId: number; enabled: boolean; questions: number }): string {
  return input.enabled || input.questions > 0 ? `/jobs/${input.jobId}/apply` : "/settings?tab=workflow";
}
