/**
 * CPU time for timing tests. Wall time grows several times over on a busy machine (other test files, other builds), the CPU time
 * of the test's own thread hardly at all: bounds on it fail for slow code, not for a loaded machine.
 */

/** This thread's CPU time (the process's on a Node 22 older than 22.19), without the garbage collector's and compilers' threads. */
const node: { threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage } = process;
const cpuUsage = (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage => (node.threadCpuUsage ? node.threadCpuUsage(previous) : process.cpuUsage(previous));

/** CPU milliseconds of one run of `work` in this thread. */
export function cpuTime(work: () => void): number {
  const started = cpuUsage();
  work();
  const used = cpuUsage(started);
  return (used.user + used.system) / 1000;
}

export interface MeasureOptions {
  /** Measurements taken; the least counts (a measure, not a retry: interruptions only ever add time). Default 3. */
  runs?: number;
  /** One measurement repeats `work` (at least once) until it took this many milliseconds, and divides by the repeats. Default 20. */
  atLeast?: number;
  /** Stop after the first run of `work` that takes longer than this, and return that run's time (code that slow fails anyway). */
  giveUpAbove?: number;
}

/** The least CPU milliseconds of one run of `work` over a few measurements. */
export function leastCpuTime(work: () => void, options: MeasureOptions = {}): number {
  const { runs = 3, atLeast = 20, giveUpAbove = Infinity } = options;
  let least = Infinity;
  for (let run = 0; run < runs; run += 1) {
    let total = 0;
    let repeats = 0;
    do {
      const once = cpuTime(work);
      if (once > giveUpAbove) return once;
      total += once;
      repeats += 1;
    } while (total < atLeast);
    least = Math.min(least, total / repeats);
  }
  return least;
}
