import type { Manager } from "./fake-release";

/** Unset keeps the local suite intact; reject empty/unknown entries before any test hooks can run. */
export function selectedSwapManagers(value: string | undefined): Manager[] {
  const managers: Manager[] = ["systemd", "launchd"];
  if (value === undefined) return managers;
  const requested = value.split(",").map((manager) => manager.trim());
  if (requested.some((manager) => manager !== "systemd" && manager !== "launchd")) {
    throw new Error(`Invalid SWAP_MANAGERS=${JSON.stringify(value)}; expected systemd, launchd, or a comma-separated list`);
  }
  // Preserve suite order and run each manager once, including when the input repeats one.
  return managers.filter((manager) => requested.includes(manager));
}
