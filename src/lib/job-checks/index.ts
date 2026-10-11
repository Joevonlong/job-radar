/** Shared pieces of the job checks (the visa check; later others of the same shape): segments, input hashes, the table probe, the loop. */
export { DEFAULT_ABBREVIATIONS, segmentText, type SegmentOptions, type TextSegment } from "./segment";
export { inputHash, textHash } from "./fingerprint";
export { checkTableReady, resetCheckTablesCache, type JobCheckTable } from "./table";
export {
  runJobCheck,
  runJobCheckStep,
  type JobCheckCandidate,
  type JobCheckOutcome,
  type JobCheckRunOptions,
  type JobCheckRunResult,
  type JobCheckSpec,
  type JobCheckStepOutcome,
} from "./step";
