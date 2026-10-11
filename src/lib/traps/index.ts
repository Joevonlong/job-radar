/** AI trap detection: find content of a JD written to mislead an AI, mark it, and never pass it on to an AI. */
export * from "./types";
export { jdForAi, overlapsTrap, resolveSpans, spanKindOf, type SpanRow } from "./ai-input";
export { cleanDescriptionForAi, cleanDescriptionsForAi, loadTrapSpans, type JobText } from "./clean";
export { descriptionMd5, rulesFingerprint, TRAP_RULES_VERSION } from "./fingerprint";
export { scanHtml, squash } from "./html";
export { firstInstruction, firstTrigger, scanInstructions, sentenceOf } from "./instructions";
export { locateLoose } from "./locate";
export { IN_DESCRIPTION, scanJob, type ScanJobInput, type ScanJobResult } from "./scan";
export { readTrapsSettings, trapsEnabled } from "./settings";
export { runTrapScan, spansHashOf, type ChannelLookup, type TrapScanOptions, type TrapScanResult } from "./step";
export { decodeTagChars, scanInvisibleUnicode, stripInvisible } from "./unicode";
