import { AiProviderError } from "@/lib/ai";
import { buildWritePrompt, WRITE_PROMPT_VERSIONS, writeOutputSchema, type WriteOutput } from "@/lib/ai/prompts/write";
import { truncateJd } from "@/lib/ai/prompts/score";
import type { AiRouter } from "@/lib/ai/router";
import type { AiCallRecord } from "@/lib/ai/types";
import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { ConfigError, loadConfig, type WriterConfig } from "@/lib/config";
import { getApplicationQuestion, insertAnswerVersions, type AnswerVersionInput } from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { locateQuote } from "@/lib/signals/quote";
import { cleanDescriptionForAi } from "@/lib/traps/clean";
import { classifyTranslationFailure, resumeOf } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";
import { buildWriteInput, profileEvidenceText, storyEvidenceText, type WriterMaterials } from "@/lib/writer/materials";
import { countStatuses, joinSentences, verifySentences, type VerifyContext } from "@/lib/writer/verify";

import { writerJobPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

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
 * `writer_job`: draft the answer of one application question from the material snapshot in the payload. The JD goes
 * through the trap cleaning first, and a chosen JD point whose quote the cleaned JD no longer has is not sent. Every
 * sentence of every version is then checked against the snapshot and the stored JD (`verifySentences`), and the versions
 * are stored with their check results. Claimed only by the ai-worker; the payload's material is cleared when the request
 * ends (`finishControlRequest`). The result never holds text of the material or the answer.
 */
export function createWriterJobHandler(options: WriterJobHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): WriterConfig => loadConfig("writer"));
  return async (request, context) => {
    const payload = writerJobPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, questionId, materials, materialsHash } = payload.data;
    const base = { jobId, questionId };
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
    const prompt = buildWritePrompt({ input, outputLanguage: materials.question.outputLanguage, quoteMaxChars: settings.evidence.quote_max_chars });

    // `timeout_seconds` counts from the claim (the JD cleaning above included), so this timeout ends a live request
    // before the expiry (`timeout_seconds + expiry_grace_seconds` from the claim) would
    const startedAt = request.startedAt?.getTime() ?? Date.now();
    const timeout = AbortSignal.timeout(Math.max(1, startedAt + settings.timeout_seconds * 1000 - Date.now()));
    let lastCall: AiCallRecord | null = null;
    let result;
    try {
      const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
      result = await router.run("write", prompt, writeOutputSchema, {
        signal: AbortSignal.any([context.signal, timeout]),
        jobId,
        onCall: (call) => {
          lastCall = call;
        },
      });
    } catch (error) {
      if (timeout.aborted && !context.signal.aborted) return { status: "failed", result: { ...base, error: "timeout" } };
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { ...base, error: "aborted" } };
      const failure = classifyTranslationFailure(error);
      const call = lastCall as AiCallRecord | null;
      if (failure.code === "invalid_output" && call !== null && call.usage.tokensOut >= writeOutputTokenCap() * settings.output_truncated_share) {
        return { status: "failed", result: { ...base, error: "output_truncated" } };
      }
      return { status: "failed", result: { ...base, error: failure.code, detail: failure.message, ...resumeOf(failure) } };
    }

    const breakdown = await getJobBreakdown(db, jobId);
    const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
    const verify: VerifyContext = {
      jd: raw,
      profile: materials.profile ? profileEvidenceText(materials.profile) : null,
      stories: new Map(materials.stories.map((story) => [story.id, storyEvidenceText(story)])),
      emphasis: materials.emphasis,
      draft: null,
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
    const versions: AnswerVersionInput[] = pairVariants(materials, result.value).map((variant) => {
      const sentences = verifySentences(
        variant.sentences.map((sentence) => ({ text: sentence.text, about: sentence.about, newParagraph: sentence.new_paragraph ?? false, evidence: sentence.evidence })),
        verify,
      );
      const counts = countStatuses(sentences);
      return {
        mode: "draft",
        variantId: variant.id,
        text: joinSentences(sentences),
        sentences,
        supportedCount: counts.supported,
        partialCount: counts.partial,
        unsupportedCount: counts.unsupported,
        framingCount: counts.framing,
        userWrittenCount: counts.user_written,
        webUnverifiedCount: counts.web_unverified,
        provider: result.provider,
        model: result.model,
        promptVersion: WRITE_PROMPT_VERSIONS.draft,
        materialsHash,
        controlRequestId: request.id,
      };
    });
    if (versions.length === 0) return { status: "failed", result: { ...base, error: "invalid_output" } };
    const ids = await insertAnswerVersions(db, { questionId, versions, maxVersions: settings.questions.max_versions_per_question });
    return {
      status: "done",
      result: { ...base, versions: ids, provider: result.provider, model: result.model, droppedJdPoints: materials.jdPoints.length - jdPoints.length },
    };
  };
}

export const writerJobHandler: ControlHandler = createWriterJobHandler();
