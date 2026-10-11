import { z } from "zod";

import { TRANSLATE_PROMPT_VERSION, buildTranslatePrompt } from "@/lib/ai/prompts/translate";
import type { AiAttempt } from "@/lib/ai/errors";
import type { AiRouter } from "@/lib/ai/router";
import type { AiProviderId } from "@/lib/ai/types";
import type { ChannelLogger } from "@/lib/channels/types";
import { promptLanguageName, targetScript } from "@/lib/i18n/languages";

import { joinChunks, splitIntoChunks } from "./chunk";
import { markedSentencesFor, normalizeMarkers, type MarkableSignal } from "./markers";

/**
 * Sanity checks on a reply, so a model that answers with the original text or a stub is retried (the
 * provider layer sends the validation message back once) instead of being cached as a translation.
 * Wide scripts (Chinese, Japanese) are far more compact than English or German: a real translation may be
 * much shorter than its source, but never by this much.
 */
const MIN_LENGTH_RATIO = 0.15;
const MIN_LATIN_LETTERS_FOR_SCRIPT_CHECK = 20;
const LATIN = /\p{Script=Latin}/gu;

/**
 * The Unicode scripts a text in a writing system uses (ISO 15924 → Unicode `Script` values). `Hans` / `Hant` are
 * written in Han, Japanese in Han and kana, Korean in Hangul (and Han). Unicode facts, not copy.
 */
const SCRIPT_CHARACTERS: Readonly<Record<string, readonly string[]>> = { Hans: ["Han"], Hant: ["Han"], Jpan: ["Han", "Hiragana", "Katakana"], Kore: ["Hangul", "Han"] };

/** A pattern matching a character of the target language's writing system; null for Latin (and for a script the engine does not know). */
export function targetScriptPattern(target: string): RegExp | null {
  const script = targetScript(target);
  if (script === null || script === "Latn") return null;
  const names = SCRIPT_CHARACTERS[script] ?? [script];
  try {
    return new RegExp(names.map((name) => `\\p{Script=${name}}`).join("|"), "u");
  } catch {
    return null;
  }
}

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The reply schema for translating `sourceText` into `target`: never much shorter than the source; for a target
 * written in another script than Latin, a reply to a Latin-script source must contain that script; for a Latin-script
 * target, the reply must not be the source itself.
 */
export function translationReplySchema(sourceText: string, target: string) {
  const minLength = Math.floor(sourceText.length * MIN_LENGTH_RATIO);
  const pattern = targetScriptPattern(target);
  const latinSource = (sourceText.match(LATIN) ?? []).length >= MIN_LATIN_LETTERS_FOR_SCRIPT_CHECK;
  const name = promptLanguageName(target);
  return z
    .object({ translation: z.string().trim().min(1) })
    .refine((v) => v.translation.length >= minLength, { message: "the translation is much shorter than the source text: translate the complete text, do not summarise" })
    .refine((v) => pattern === null || !latinSource || pattern.test(v.translation), { message: `the translation must be written in ${name}` })
    .refine((v) => pattern !== null || !latinSource || normalized(v.translation) !== normalized(sourceText), { message: `the reply is the source text: translate it into ${name}` });
}

export interface TranslateTextInput {
  text: string;
  /** Language the pipeline detected (`en`, `de`, `other`, `unknown`). */
  language: string;
  /** The language to translate into (`language.yaml: translation.target`). */
  target: string;
  /** Signals of the job; their quotes get highlighted in the translation where the model finds them. */
  signals?: readonly MarkableSignal[];
}

export interface TranslateTextOptions {
  signal?: AbortSignal;
  logger?: ChannelLogger;
  /** Time one provider gets for one piece (default: each provider's own timeout). */
  timeoutMs?: number;
  /** Providers not to try (they timed out a moment ago). */
  skipProviders?: readonly AiProviderId[];
  /** Called for every provider that was skipped or failed on the way to the answer. */
  onAttempt?: (attempt: AiAttempt) => void;
  /** Longest piece in characters (default: `TRANSLATION_CHUNK_CHARS`). */
  chunkChars?: number;
  /** Fixed renderings (ai.yaml `translation.glossary`; the service passes it). */
  glossary?: Readonly<Record<string, string>>;
  /** The job this text belongs to (recorded in `ai_usage.job_id`). */
  jobId?: number;
}

export interface TranslatedText {
  /** The translated text in the stored form (tier markers, see markers.ts). */
  content: string;
  /** The providers that answered, e.g. `codex-cli` (several when a chunk fell back to another one). */
  provider: string;
  chunks: number;
  tokensIn: number;
  tokensOut: number;
}

export interface TranslatedChunk {
  content: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
}

/** Translate one piece (a chunk of the description) through the AI router, with the signal quotes inside it marked. */
export async function translateChunk(router: AiRouter, chunk: string, input: Omit<TranslateTextInput, "text">, options: TranslateTextOptions = {}): Promise<TranslatedChunk> {
  const marked = markedSentencesFor(chunk, input.signals ?? []);
  const prompt = buildTranslatePrompt({ text: chunk, language: input.language, target: input.target, marked: marked.map((m) => m.text), glossary: options.glossary });
  const result = await router.run("translate", prompt, translationReplySchema(chunk, input.target), {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.skipProviders ? { skipProviders: options.skipProviders } : {}),
    ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
  });
  return { content: normalizeMarkers(result.value.translation, marked), provider: result.provider, tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut };
}

/** Translate a job description into the target language through the AI router (task `translate`), piece by piece. All or nothing; the service keeps the pieces. */
export async function translateText(router: AiRouter, input: TranslateTextInput, options: TranslateTextOptions = {}): Promise<TranslatedText> {
  const chunks = splitIntoChunks(input.text, options.chunkChars);
  if (chunks.length === 0) throw new Error("nothing to translate");
  const parts: string[] = [];
  const providers: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  for (const chunk of chunks) {
    const result = await translateChunk(router, chunk, input, options);
    parts.push(result.content);
    if (!providers.includes(result.provider)) providers.push(result.provider);
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
  }
  options.logger?.debug("translated", { promptVersion: TRANSLATE_PROMPT_VERSION, chunks: chunks.length, providers: providers.join(",") });
  return { content: joinChunks(parts), provider: providers.join(", "), chunks: chunks.length, tokensIn, tokensOut };
}
