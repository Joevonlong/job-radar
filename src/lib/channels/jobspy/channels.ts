import { loadConfig } from "@/lib/config";

import type { Channel, ChannelFamily, ChannelKind } from "../types";
import { collectFromJobspy, resolveJobspySettings, type JobspySettings, type JobspySite } from "./client";
import { parseJobspyPosting } from "./parse";

/** The channels backed by the sidecar (the compose service `jobspy`); each registered below. */
export const JOBSPY_CHANNEL_IDS = ["linkedin-guest", "indeed", "jobspy-google"] as const;

export interface JobspyChannelOptions {
  /** Sidecar settings. Default: `sources.yaml: jobspy` with `JOBSPY_URL` applied, read at collect time. */
  settings?: () => JobspySettings;
}

function defaultSettings(): JobspySettings {
  return resolveJobspySettings(loadConfig("channels").jobspy);
}

function createJobspyChannel(
  spec: { id: string; family: ChannelFamily; kind: ChannelKind; site: JobspySite },
  options: JobspyChannelOptions,
): Channel {
  const settings = options.settings ?? defaultSettings;
  return {
    id: spec.id,
    family: spec.family,
    kind: spec.kind,
    usesQueries: true,
    supportsCompanyQueries: true,
    collect: (query, ctx) => collectFromJobspy(spec.site, query, ctx, settings()),
    parse: parseJobspyPosting,
  };
}

/** LinkedIn without login (jobspy). Last in the LinkedIn cascade: free, and the first to be rate limited. */
export function createLinkedinGuestChannel(options: JobspyChannelOptions = {}): Channel {
  return createJobspyChannel({ id: "linkedin-guest", family: "linkedin", kind: "guest", site: "linkedin" }, options);
}

export function createIndeedChannel(options: JobspyChannelOptions = {}): Channel {
  return createJobspyChannel({ id: "indeed", family: "indeed", kind: "guest", site: "indeed" }, options);
}

export function createJobspyGoogleChannel(options: JobspyChannelOptions = {}): Channel {
  return createJobspyChannel({ id: "jobspy-google", family: "google", kind: "guest", site: "google" }, options);
}
