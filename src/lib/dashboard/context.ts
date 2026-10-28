import { loadConfig } from "@/lib/config";

/** The schedule config: the time zone that defines "today", and the cycle times for "next run". */
export function getSchedule() {
  return loadConfig("schedule");
}

/** A broken schedule must not prevent displaying stored data or repairing settings. */
export function getDisplayTimeZone(): string {
  try {
    return getSchedule().timezone;
  } catch {
    return "UTC";
  }
}
