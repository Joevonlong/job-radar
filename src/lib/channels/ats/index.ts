import { loadCompanies, loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";

import type { ChannelRegistry } from "@/lib/channels/registry";

import { createAtsChannel, type AtsDeps } from "./collect";
import { ashbyAdapter } from "./ashby";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { personioAdapter } from "./personio";
import { smartrecruitersAdapter } from "./smartrecruiters";
import { createDbAtsBoardStore } from "./store";

export { collectBoard, createAtsChannel, type AtsAdapter, type AtsDeps, type AtsInputs, type BoardReport } from "./collect";
export { ashbyAdapter } from "./ashby";
export { conditionalHeaders, fetchBoard, fetchBoardJson, type BoardFetch, type BoardFormat } from "./conditional";
export { greenhouseAdapter } from "./greenhouse";
export { leverAdapter } from "./lever";
export { personioAdapter } from "./personio";
export { smartrecruitersAdapter } from "./smartrecruiters";
export { compileTermMatcher, createTitlePrefilter, type PrefilterDecision, type TitlePrefilter } from "./prefilter";
export { createDbAtsBoardStore, createMemoryAtsBoardStore, type AtsBoardStore } from "./store";

/** Config from `config/*.yaml` (cached, refreshed by the watcher); board state in the database. */
export const defaultAtsDeps: AtsDeps = {
  inputs: () => ({ companies: loadCompanies(), search: loadConfig("search"), interests: loadConfig("interests") }),
  store: () => createDbAtsBoardStore(getDb()),
};

export function createGreenhouseChannel(deps: AtsDeps = defaultAtsDeps) {
  return createAtsChannel(greenhouseAdapter, deps);
}

export function createLeverChannel(deps: AtsDeps = defaultAtsDeps) {
  return createAtsChannel(leverAdapter, deps);
}

export function createAshbyChannel(deps: AtsDeps = defaultAtsDeps) {
  return createAtsChannel(ashbyAdapter, deps);
}

export function createPersonioChannel(deps: AtsDeps = defaultAtsDeps) {
  return createAtsChannel(personioAdapter, deps);
}

export function createSmartrecruitersChannel(deps: AtsDeps = defaultAtsDeps) {
  return createAtsChannel(smartrecruitersAdapter, deps);
}

/** Registers `greenhouse` and `lever`, `ashby`, `personio` and `smartrecruiters`. */
export function registerAtsChannels(registry: ChannelRegistry, deps: AtsDeps = defaultAtsDeps): void {
  registry.register(createGreenhouseChannel(deps));
  registry.register(createLeverChannel(deps));
  registry.register(createAshbyChannel(deps));
  registry.register(createPersonioChannel(deps));
  registry.register(createSmartrecruitersChannel(deps));
}
