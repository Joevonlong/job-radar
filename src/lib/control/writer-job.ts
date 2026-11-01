import type { ZodType } from "zod";

import { AiProviderError } from "@/lib/ai";
import {
  buildWritePrompt,
  coachOutputSchema,
  WRITE_PROMPT_VERSIONS,
  writeOutputSchema,
  type CoachOutput,
  type WriteOutput,
} from "@/lib/ai/prompts/write";
import { truncateJd } from "@/lib/ai/prompts/score";
import type { AiRouter } from "@/lib/ai/router";
import type { AiCallRecord, AiResult } from "@/lib/ai/types";
import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { ConfigError, loadConfig, type WriterConfig } from "@/lib/config";
import { getApplicationQuestion, insertAnswerVersions, setAnswerVersionCoach, type AnswerVersionInput } from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { locateQuote } from "@/lib/signals/quote";
import { cleanDescriptionForAi } from "@/lib/traps/clean";
import { classifyTranslationFailure, resumeOf } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";
import { buildWriteInput, profileEvidenceText, storyEvidenceText, type WriterMaterials } from "@/lib/writer/materials";
import { COACH_REWRITE_VARIANT, type CheckedSentence } from "@/lib/writer/types";
import { countStatuses, joinSentences, verifySentences, verifySuggestion, type VerifyContext } from "@/lib/writer/verify";

import { writerJobPayloadSchema, type ControlHandler, type ControlHandlerContext, type ControlOutcome } from "./types";

export interface WriterJobHandlerOptions {
  /** Default: the router of ai.yaml (usage written to `ai_usage`). Tests inject a fake. */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  /** Default: `loadConfig("writer")` (the worker hot-reloads it). */
  loadSettings?: () => WriterConfig;
}

/** The output token cap of the `write` task (else the global one), to tell a cut-off answer from a malformed one. */
function writeOutputTokenCap(): number {
  const ai = loadConfig("ai");
  return ai.tasks.write.max_output_tokens ?? ai.max_output_tokens;
}

/** The skill names of the profile snapshot ("Python (5 years)" -> "Python"). */
const skillName = (entry: string): string => entry.replace(/\s*\(\d+(?:\.\d+)?(?: years|y)\)$/u, "");

/** Pair the variants the request asked for with the ones the AI returned: by id, else in order. */
function pairVariants(materials: WriterMaterials, output: WriteOutput): { id: string; sentences: WriteOutput["variants"][number]["sentences"] }[] {
  const byId = new Map(output.variants.map((variant) => [variant.variant_id, variant]));
  const unmatched = output.variants.filter((variant) => !materials.question.variants.some((wanted) => wanted.id === variant.variant_id));
  return materials.question.variants.flatMap((wanted) => {
    const variant = byId.get(wanted.id) ?? unmatched.shift();
    return variant ? [{ id: wanted.id, sentences: variant.sentences }] : [];
  });
}

/**
 * `writer_job`: write for one application question from the material snapshot in the payload, in one of four modes.
 * `draft`: the versions the question asks for. `polish`: one version made from your own text (fitted to the job, or only
 * its language). `coach`: a review of one version (score, verdicts, sentence suggestions) stored on that version.
 * `coach_rewrite`: one version made from a reviewed version and its suggestions. The JD goes through the trap cleaning
 * first, and a chosen JD point whose quote the cleaned JD no longer has is not sent. Every sentence of every version and
 * every suggested rewrite is then checked against the snapshot and the stored JD (`verifySentences`). Claimed only by
 * the ai-worker; the payload's material is cleared when the request ends (`finishControlRequest`). The result never holds
 * text of the material or the answer.
 */
export function createWriterJobHandler(options: WriterJobHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): WriterConfig => loadConfig("writer"));
  return async (request, context) => {
    const payload = writerJobPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, questionId, materials, materialsHash, mode, polish, versionId } = payload.data;
    const base = { jobId, questionId };
    // polish and review work on a text: the payload must carry it (and a review the version it is stored on)
    if (mode !== "draft" && materials.draft === null) return { status: "failed", result: { ...base, error: "invalid_payload" } };
    if ((mode === "coach" || mode === "coach_rewrite") && versionId === undefined) return { status: "failed", result: { ...base, error: "invalid_payload" } };
    let settings: WriterConfig;
    try {
      settings = loadSettings();
    } catch (error) {
      if (error instanceof ConfigError) return { status: "failed", result: { ...base, error: "config_error" } };
      throw error;
    }
    if (!settings.enabled) return { status: "failed", result: { ...base, error: "disabled" } };
    const { db } = context;
    const [job, question] = await Promise.all([getJobForBreakdown(db, jobId), getApplicationQuestion(db, { jobId, questionId })]);
    if (!job || !question) return { status: "failed", result: { ...base, error: "not_found" } };

    const raw = job.description ?? "";
    const cleaned = raw.trim() === "" ? null : await cleanDescriptionForAi(db, { jobId, description: raw }, { logger: context.logger });
    const jdPoints = cleaned === null ? [] : materials.jdPoints.filter((point) => locateQuote(cleaned, point.quote) !== null);
    const sent: WriterMaterials = { ...materials, jdPoints };
    const excerpt = sent.useJdText && cleaned !== null ? truncateJd(cleaned, settings.jd_max_chars, settings.jd_head_share).text : null;
    const { input } = buildWriteInput(sent, excerpt);
    const prompt = buildWritePrompt({
      input,
      mode,
      outputLanguage: materials.question.outputLanguage,
      quoteMaxChars: settings.evidence.quote_max_chars,
      ...(polish ? { polish } : {}),
      coach: { dimensions: settings.coach.dimensions, maxSuggestions: settings.coach.max_suggestions },
      ...(materials.draft ? { notesLanguage: materials.draft.notesLanguage } : {}),
    });

    // `timeout_seconds` counts from the claim (the JD cleaning above included), so this timeout ends a live request
    // before the expiry (`timeout_seconds + expiry_grace_seconds` from the claim) would
    const startedAt = request.startedAt?.getTime() ?? Date.now();
    const timeout = AbortSignal.timeout(Math.max(1, startedAt + settings.timeout_seconds * 1000 - Date.now()));
    let lastCall: AiCallRecord | null = null;
    const callAi = async <T>(schema: ZodType<T>): Promise<{ result: AiResult<T> } | { failed: ControlOutcome }> => {
      try {
        const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
        const result = await router.run("write", prompt, schema, {
          signal: AbortSignal.any([context.signal, timeout]),
          jobId,
          onCall: (call) => {
            lastCall = call;
          },
        });
        return { result };
      } catch (error) {
        if (timeout.aborted && !context.signal.aborted) return { failed: { status: "failed", result: { ...base, error: "timeout" } } };
        if (error instanceof AiProviderError && error.kind === "aborted") return { failed: { status: "failed", result: { ...base, error: "aborted" } } };
        const failure = classifyTranslationFailure(error);
        const call = lastCall as AiCallRecord | null;
        if (failure.code === "invalid_output" && call !== null && call.usage.tokensOut >= writeOutputTokenCap() * settings.output_truncated_share) {
          return { failed: { status: "failed", result: { ...base, error: "output_truncated" } } };
        }
        return { failed: { status: "failed", result: { ...base, error: failure.code, detail: failure.message, ...resumeOf(failure) } } };
      }
    };

    const breakdown = await getJobBreakdown(db, jobId);
    const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
    const verify: VerifyContext = {
      jd: raw,
      profile: materials.profile ? profileEvidenceText(materials.profile) : null,
      stories: new Map(materials.stories.map((story) => [story.id, storyEvidenceText(story)])),
      emphasis: materials.emphasis,
      draft: materials.draft?.text ?? null,
      company: null,
      entities: [
        ...(content?.tech_stack.map((item) => item.name) ?? []),
        ...materials.stories.flatMap((story) => story.skills),
        ...(materials.profile?.skills.map(skillName) ?? []),
        job.company,
      ],
      companyName: job.company,
      language: materials.question.outputLanguage,
      config: settings.evidence,
    };

    if (mode === "coach") {
      const called = await callAi<CoachOutput>(coachOutputSchema);
      if ("failed" in called) return called.failed;
      const { result } = called;
      const out = result.value;
      const sentenceCount = materials.draft?.sentences.length ?? 0;
      const allowed = new Set(settings.coach.dimensions);
      const seen = new Set<string>();
      const dimensions = out.dimensions.filter((entry) => {
        if (!allowed.has(entry.id) || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      const suggested = out.suggestions.filter((entry) => entry.sentence_index < sentenceCount).slice(0, settings.coach.max_suggestions);
      const coach = {
        score: Math.round(out.score),
        dimensions,
        suggestions: suggested.map((entry) => ({
          sentenceIndex: entry.sentence_index,
          issue: entry.issue,
          sentence: verifySuggestion({ text: entry.rewrite, about: entry.about, evidence: entry.evidence }, verify) satisfies CheckedSentence,
        })),
        dropped: { dimensions: out.dimensions.length - dimensions.length, suggestions: out.suggestions.length - suggested.length },
        provider: result.provider,
        model: result.model,
        promptVersion: WRITE_PROMPT_VERSIONS.coach,
        createdAt: new Date().toISOString(),
      };
      if (!(await setAnswerVersionCoach(db, { questionId, versionId: versionId ?? 0, coach }))) return { status: "failed", result: { ...base, error: "not_found" } };
      return {
        status: "done",
        result: { ...base, versionId, score: coach.score, suggestions: coach.suggestions.length, dropped: coach.dropped, provider: result.provider, model: result.model },
      };
    }

    const called = await callAi<WriteOutput>(writeOutputSchema);
    if ("failed" in called) return called.failed;
    const { result } = called;
    const versions: AnswerVersionInput[] = pairVariants(materials, result.value).map((variant) => {
      const sentences = verifySentences(
        variant.sentences.map((sentence) => ({ text: sentence.text, about: sentence.about, newParagraph: sentence.new_paragraph ?? false, evidence: sentence.evidence })),
        verify,
      );
      const counts = countStatuses(sentences);
      return {
        mode: mode === "polish" ? "polish" : mode === "coach_rewrite" ? "coach_rewrite" : "draft",
        variantId: mode === "coach_rewrite" ? COACH_REWRITE_VARIANT : variant.id,
        text: joinSentences(sentences),
        sentences,
        supportedCount: counts.supported,
        partialCount: counts.partial,
        unsupportedCount: counts.unsupported,
        framingCount: counts.framing,
        userWrittenCount: counts.user_written,
        webUnverifiedCount: counts.web_unverified,
        ...(mode === "coach_rewrite" && versionId !== undefined ? { parentVersionId: versionId } : {}),
        provider: result.provider,
        model: result.model,
        promptVersion: WRITE_PROMPT_VERSIONS[mode],
        materialsHash,
        controlRequestId: request.id,
      };
    });
    if (versions.length === 0) return { status: "failed", result: { ...base, error: "invalid_output" } };
    const ids = await insertAnswerVersions(db, { questionId, versions, maxVersions: settings.questions.max_versions_per_question });
    return {
      status: "done",
      result: { ...base, mode, versions: ids, provider: result.provider, model: result.model, droppedJdPoints: materials.jdPoints.length - jdPoints.length },
    };
  };
}

export const writerJobHandler: ControlHandler = createWriterJobHandler();
