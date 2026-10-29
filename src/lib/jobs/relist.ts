/** A source returned a job after a qualifying gap with an earlier-cycle absence observation. */
export function relistDecision(input: { lastListedAt: Date | null; observedAt: Date; minGapDays: number; absenceObserved: boolean }): boolean {
  return input.minGapDays > 0 && input.lastListedAt !== null && input.absenceObserved
    && input.observedAt.getTime() >= input.lastListedAt.getTime() + input.minGapDays * 86_400_000;
}
