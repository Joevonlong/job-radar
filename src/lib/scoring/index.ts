/**
 * AI scoring: the `score` sub-task of the `ai` cycle step, the German
 * level rule and the rank value.
 */
export { explicitGermanLevels, languagePenalty, penalizedLanguageLevels, resolveGermanLevel, userLanguageLabel, userLanguageRank, GERMAN_SOURCES, type GermanSource, type ResolvedGerman } from "./german";
export { createPriorityScorer, orderByPriority, type PriorityBreakdown, type PriorityConfig, type PriorityInputs, type PriorityJob, type PriorityScorer } from "./priority";
export { recheckGerman, type GermanRecheckResult } from "./german-recheck";
export { computeRankValue, finalMatchScore } from "./rank";
export {
  isProfileUsable,
  missingProfileFields,
  readProfileReadiness,
  readScoringProfile,
  currentPreferencesSnapshotId,
  PROFILE_SCORING_FIELDS,
  type ProfileReadiness,
  type ProfileScoringField,
  type ScoringProfile,
} from "./profile";
export {
  buildScoreQueue,
  createScoringDeps,
  registerScoringSubtask,
  rescoreStale,
  runScoring,
  scoreBacklog,
  scoreJobs,
  scoreSubtask,
  SCORE_SUBTASK_NAME,
  PROFILE_INCOMPLETE,
  type QueuedJob,
  type ScoringDeps,
  type ScoringFailure,
  type ScoringOptions,
  type ScoringResult,
} from "./score-task";
