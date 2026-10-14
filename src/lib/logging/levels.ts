/**
 * The log levels, lowest first. A leaf module (imports nothing) shared by the logger, the environment parser and the
 * schedule.yaml schema, so none of them has to import another and no import cycle can form through the config loader.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The level a process logs at when neither `JOB_RADAR_LOG_LEVEL` nor schedule.yaml `logging.level` says otherwise. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
