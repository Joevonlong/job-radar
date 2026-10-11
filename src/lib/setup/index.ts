/** The first-run setup (see `docs/setup.md` and `docs/architecture.md`). Server / Node only; the browser imports the plain modules directly. */
export * from "./steps";
export * from "./types";
export { readSetupState, resetSetupStateCache, markStep, completeSetup, type SetupStatus, type SetupSource, type SetupWriteResult } from "./state";
export { setupRedirect, shouldRunScheduled, SETUP_PATH, HELD_BACK_WORK, type ScheduledWork } from "./gate";
export { planKeywordGroups, cleanTitles, TARGETS_GROUP, type KeywordPlan } from "./keywords";
export { buildReadiness, READINESS_IDS, type ReadinessItem, type ReadinessId, type ReadinessStatus } from "./readiness";
export { saveLanguageStep, localeFromAcceptLanguage } from "./steps/language";
export { saveMarketStep } from "./steps/market";
export { saveProfileStep } from "./steps/profile";
export { saveTargetsStep } from "./steps/targets";
export { saveSourcesStep } from "./steps/sources";
export { saveAiStep } from "./steps/ai";
export { saveTelegramStep } from "./steps/telegram";
export { finishSetup, requestFirstCycle, skipSetupStep } from "./steps/review";
