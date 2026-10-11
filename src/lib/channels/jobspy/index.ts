import type { ChannelRegistry } from "../registry";
import { createIndeedChannel, createJobspyGoogleChannel, createLinkedinGuestChannel } from "./channels";

export * from "./channels";
export * from "./client";
export { parseJobspyPosting, parseLocation } from "./parse";

/** Register the three channels backed by the jobspy sidecar. */
export function registerJobspyChannels(registry: ChannelRegistry): void {
  registry.register(createLinkedinGuestChannel());
  registry.register(createIndeedChannel());
  registry.register(createJobspyGoogleChannel());
}
