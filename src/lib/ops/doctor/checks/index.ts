import type { DoctorCheck } from "../types";

import { AI_CHECKS, BACKLOG_CHECKS } from "./ai";
import { CHANNEL_CHECKS } from "./channels";
import { CONFIG_CHECKS, LANGUAGE_CHECKS } from "./config";
import { DATA_CHECKS, HOST_CHECKS } from "./data";
import { NETWORK_CHECKS, NOTIFY_CHECKS } from "./notify";
import { SCHEDULE_CHECKS } from "./schedule";
import { SETUP_CHECKS } from "./setup";
import { SOURCES_CHECKS } from "./sources";
import { RUNNER_CHECKS, STACK_CHECKS } from "./stack";

/** Every check, in report order (the report groups them by `group`; this order is kept inside a group). */
export const ALL_CHECKS: readonly DoctorCheck[] = [
  ...STACK_CHECKS,
  ...LANGUAGE_CHECKS,
  ...RUNNER_CHECKS,
  ...AI_CHECKS,
  ...NOTIFY_CHECKS,
  ...NETWORK_CHECKS,
  ...DATA_CHECKS,
  ...CONFIG_CHECKS,
  ...SETUP_CHECKS,
  ...CHANNEL_CHECKS,
  ...SOURCES_CHECKS,
  ...SCHEDULE_CHECKS,
  ...BACKLOG_CHECKS,
  ...HOST_CHECKS,
];
