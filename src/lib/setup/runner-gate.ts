/**
 * The runner's check before scheduled work (scheduled cycles, the start-up catch-up, the weekly suggestions).
 * While the first-run setup is pending the work is held back: one log line, no cycle, nothing recorded as a failure
 * (C2). The state is read at every trigger, so finishing the setup applies from the next slot. Manual requests never
 * pass through here.
 */
import { shouldRunScheduled, type ScheduledWork } from "./gate";
import { readSetupState } from "./state";

export type SetupGate = (work: Exclude<ScheduledWork, "manual">, what: string) => boolean;

export function createSetupGate(log: (message: string) => void, read: () => { pending: boolean } = readSetupState): SetupGate {
  return (work, what) => {
    if (shouldRunScheduled(work, read())) return true;
    log(`setup not completed: skipping ${what} (finish /setup or run pnpm run setup)`);
    return false;
  };
}
