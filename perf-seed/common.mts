import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
export function checkedUrl(input: string | undefined) {
  const url = new URL(z.string().parse(input));
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.port === "5433") throw new Error("An explicit local throwaway PostgreSQL port is required");
  return url;
}
export function checkedDatabase(name: string) {
  if (name.length > 63 || !/^jobradar_test_scoreperf_[a-z0-9_]+$/.test(name)) throw new Error("Expected a scoreperf disposable database name");
  return name;
}
export const moduleAt = (root: string, file: string) => pathToFileURL(path.resolve(root, file)).href;
export function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
export async function measure(work: () => Promise<unknown>, batches = 5, samples = 20) {
  await work(); const result = [];
  for (let b = 0; b < batches; b++) {
    const times = [];
    for (let n = 0; n < samples; n++) { const start = performance.now(); await work(); times.push(performance.now() - start); }
    result.push(stats(times));
  }
  return { batches: result, p95: stats(result.map((batch) => batch.p95!)).p50 };
}
