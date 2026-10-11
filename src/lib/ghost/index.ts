/**
 * The ghost job check (docs/ghost-jobs.md): signs that a posting is not a real opening, by rules over stored data. Only a hint next
 * to the score; nothing here changes a score, a filter or a push (C3). Server code imports `./step` and `./filter` directly.
 */
export { evaluateGhost, levelOf } from "./evaluate";
export { GHOST_RULES_VERSION, ghostRulesFingerprint } from "./fingerprint";
export { compileGhostRules, ghostRulesFor, type CompiledGhostRules, type GhostRulesInput } from "./rules";
export { countWords, evergreenWording, hasResponsibilityHeading, longOpen, repostLabel, reposted, thinDescription } from "./signals";
export * from "./types";
export { buildGhostCheckView, ghostMarkText, ghostReasonMessage, ghostShortMessage, type GhostCheckView, type GhostMessage } from "./view";
