import { runControlPoller } from "./poller";

/** One serial poller per lane, sharing the process's kinds, timings, shutdown and requeue policy. */
export async function startControlLanes(options: Parameters<typeof runControlPoller>[0]): Promise<void> {
  await Promise.all((["interactive", "batch"] as const).map((lane) =>
    runControlPoller({ ...options, lane, logger: options.logger.child({ lane }) }),
  ));
}
