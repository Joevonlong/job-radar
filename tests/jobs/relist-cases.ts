/** Shared SQL/TypeScript boundary cases; every value belongs to this test. */
const baseline = new Date("2026-09-01T12:00:00Z");
const observation = new Date("2026-09-10T12:00:00Z");
export const relistCases = [
  { name: "gap exactly the minimum", lastListedAt: baseline, observedAt: observation, minGapDays: 9, absenceObserved: true, expected: true },
  { name: "one second short", lastListedAt: baseline, observedAt: new Date(observation.getTime() - 1000), minGapDays: 9, absenceObserved: true, expected: false },
  { name: "disabled", lastListedAt: baseline, observedAt: observation, minGapDays: 0, absenceObserved: true, expected: false },
  { name: "null baseline", lastListedAt: null, observedAt: observation, minGapDays: 9, absenceObserved: true, expected: false },
  { name: "out of order", lastListedAt: observation, observedAt: baseline, minGapDays: 9, absenceObserved: true, expected: false },
  { name: "no observed absence", lastListedAt: baseline, observedAt: observation, minGapDays: 9, absenceObserved: false, expected: false },
];
