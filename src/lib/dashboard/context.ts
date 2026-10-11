import { loadConfig } from "@/lib/config";

/** The schedule config: the time zone that defines "today", and the cycle times for "next run". */
export function getSchedule() {
  return loadConfig("schedule");
}
