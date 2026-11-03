import { z } from "zod";

import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { listAnswerVersions, listApplicationQuestions } from "@/lib/db/repos/application-writer";
import { getFitNote } from "@/lib/db/repos/application-fit-notes";
import { getJobBreakdown } from "@/lib/db/repos/breakdowns";
import { getCompanyResearchForJob } from "@/lib/db/repos/company-research";
import { cleanDescriptionStrict } from "@/lib/traps/clean";
import { COMPANY_RESEARCH_FIELDS } from "@/lib/research/fields";
import { companyFieldText, httpsUrlOrNull } from "@/lib/writer/company-background";
import { parseFitItems } from "@/lib/writer/fit";
import { fitNoteOutdated } from "@/lib/writer/fit-hash";
import { jdPointsOf } from "@/lib/writer/jd-points";
import { parseSelection } from "@/lib/writer/selection";
import { buildSnapshot, questionSettingsOf } from "@/lib/writer/snapshot";
import { parseStoredSentences } from "@/lib/writer/stored";
import type { CheckedSentence } from "@/lib/writer/types";

import { ToolFailure, type McpContext } from "../context";
import { getApplicationContextOutput, toLinkDto, toLocationDto, type CleanText, type DescriptionDto, type GetApplicationContextOutput, type WriterVersionDto } from "../dto";
import { availableDescription, jdQuoteGuard, shortFieldCleaner, unavailableDescription, visibleText } from "../guard";
import { readTraps, resultLimit, truncationNotice } from "./shared";
import { readWriterForTool } from "./writer-shared";

export function getApplicationContextInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({
    job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.jobId")),
  });
}

export type GetApplicationContextArgs = z.infer<ReturnType<typeof getApplicationContextInput>>;

function sentenceDto(sentence: CheckedSentence, clean: CleanText): WriterVersionDto["sentences"][number] {
  return {
    text: clean(sentence.text),
    about: sentence.about,
    status: sentence.status,
    evidence: sentence.evidence.map((entry) => ({ source: entry.source, ref: entry.ref === undefined ? null : clean(entry.ref), quote: clean(entry.quote), valid: entry.problem === null })),
    missing: sentence.missing.map(clean),
    needs_check: sentence.needsCheck.map(clean),
  };
}

/**
 * Everything to write one job's application answers from: the job's facts, its breakdown points, its questions, for each question
 * the material the user chose for it, and the saved versions. The result is built field by field (`dto.ts`).
 *
 * The reader is an AI, so nothing here is handed over as written. The JD follows the rule of `get_job`: only after the trap findings
 * were removed, and withheld (with the breakdown points, which quote it) when the trap check cannot vouch for it; a point whose
 * quote overlaps a finding is that finding's marker. Every other string goes through the short-field cleaner, the user's own too:
 * a question is pasted from a posting, a story may come from an imported file, a version may be what another client saved.
 */
export async function getApplicationContext(ctx: McpContext, args: GetApplicationContextArgs): Promise<GetApplicationContextOutput> {
  const { writer, stories, storiesUnreadable, me } = readWriterForTool(ctx);
  const detail = await getJobDetail(ctx.db, args.job_id);
  if (!detail) throw new ToolFailure("not_found", ctx.text("errors.notFound", { id: args.job_id }));

  const [strict, breakdown, questions, research, fitRow] = await Promise.all([
    cleanDescriptionStrict(ctx.db, { jobId: detail.id, description: detail.description }, { settings: ctx.traps }),
    getJobBreakdown(ctx.db, detail.id),
    listApplicationQuestions(ctx.db, detail.id),
    getCompanyResearchForJob(ctx.db, detail.id),
    getFitNote(ctx.db, detail.id),
  ]);
  const versions = await listAnswerVersions(ctx.db, questions.map((question) => question.id));
  const traps = readTraps(ctx);
  const clean = shortFieldCleaner(traps);

  const notices: string[] = [];
  let description: DescriptionDto;
  if (strict.ok) {
    description = availableDescription(strict.text, ctx.settings.limits.max_description_chars);
    if (strict.removed > 0) notices.push(ctx.text("notice.traps", { count: strict.removed }));
    if (description.truncated) notices.push(ctx.text("description.truncated", { limit: ctx.settings.limits.max_description_chars, total: description.total_chars ?? 0 }));
  } else {
    description = unavailableDescription(strict.reason, ctx.text("description.unavailable"));
  }
  if (storiesUnreadable) notices.push(ctx.text("notice.storiesUnreadable"));

  const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
  const points = content ? jdPointsOf(content) : [];
  const guard = jdQuoteGuard(strict, detail.description);
  /** A point as it may be given: its own text only while its quote is clean; null while the JD is withheld. */
  const pointDto = (point: { text: string; quote: string; offset: number; requirement: string | null }): GetApplicationContextOutput["jd_points"][number] | null => {
    const quote = guard(point.quote, point.offset);
    if (quote === null) return null;
    return { text: clean(quote === point.quote ? point.text : quote), quote: clean(quote), requirement: point.requirement };
  };
  const pointsOf = (list: readonly Parameters<typeof pointDto>[0][]) => list.flatMap((point) => pointDto(point) ?? []);

  // a field the rules take for an instruction becomes the cleaner's marker; the notice covers what no rule can recognise
  // an address is given as written, unless it spells an instruction (in the path or the query, plain or percent-encoded)
  const safeUrl = (url: string | null): string | null => {
    if (url === null) return null;
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // not valid percent-encoding: the address as written is what is checked
    }
    const spaced = decoded.replace(/[-_+/?&=.]+/g, " ");
    return [url, decoded, spaced].every((form) => clean(form) === visibleText(form)) ? url : null;
  };
  const companyFields =
    research === null
      ? []
      : COMPANY_RESEARCH_FIELDS.flatMap((field) => {
          const entry = research.fields[field];
          return entry ? [{ field, text: clean(companyFieldText(entry.text)), source_url: safeUrl(httpsUrlOrNull(entry.sourceUrl)) }] : [];
        });
  if (research !== null || fitRow !== null) notices.push(ctx.text("notice.companyBackground"));

  const limit = resultLimit(ctx, undefined);
  let cutVersions = false;
  const output: GetApplicationContextOutput = {
    notices,
    job: {
      id: detail.id,
      title: clean(detail.title),
      company: clean(detail.company.name),
      language: detail.language,
      locations: detail.locations.map((location) => toLocationDto(location, clean)),
      links: detail.sources.map((source) => toLinkDto(source, clean)),
      description,
    },
    jd_points: pointsOf(points),
    company_background: research === null ? null : { expired: research.expired, fields: companyFields },
    fit_note:
      fitRow === null
        ? null
        : {
            outdated: fitNoteOutdated(fitRow, research?.id ?? null, stories),
            items: parseFitItems(fitRow.items).map((item) => ({
              company_point: clean(item.companyPoint),
              your_point: clean(item.yourPoint),
              company_quote: clean(item.companyQuote),
              story_quote: clean(item.storyQuote),
              status: item.status,
            })),
          },
    questions: questions.map((question) => {
      const { materials } = buildSnapshot({
        question: questionSettingsOf(question),
        selection: parseSelection(question.selectedMaterials),
        job: { title: detail.title, company: detail.company.name },
        jdPoints: points,
        me,
        stories,
        writer,
        company: research,
        traps,
      });
      const own = versions.filter((version) => version.questionId === question.id);
      if (own.length > limit) cutVersions = true;
      return {
        id: question.id,
        text: clean(materials.question.text),
        kind: question.kind,
        length: { unit: question.lengthUnit, value: question.lengthValue },
        output_language: question.outputLanguage,
        tone: question.tone,
        material: {
          jd_points: pointsOf(materials.jdPoints),
          use_jd_text: materials.useJdText,
          profile: materials.profile ? { summary: clean(materials.profile.summary), skills: materials.profile.skills.map(clean), languages: materials.profile.languages.map(clean) } : null,
          stories: materials.stories.map((story) => ({
            id: story.id,
            title: clean(story.title),
            what: clean(story.what),
            result: story.result === null ? null : clean(story.result),
            metrics: story.metrics.map(clean),
            skills: story.skills.map(clean),
            period: story.period === null ? null : clean(story.period),
          })),
          emphasis: materials.emphasis === null ? null : clean(materials.emphasis),
          company_fields: materials.company?.fields.map((entry) => entry.field) ?? [],
        },
        versions: own.slice(0, limit).map((version) => ({
          id: version.id,
          mode: version.mode,
          text: clean(version.text),
          is_final: question.finalVersionId === version.id,
          created_at: version.createdAt.toISOString(),
          sentences: parseStoredSentences(version.sentences, version.text).map((sentence) => sentenceDto(sentence, clean)),
        })),
        versions_total: own.length,
      };
    }),
  };
  if (cutVersions) notices.push(truncationNotice(ctx, limit, Math.max(...output.questions.map((question) => question.versions_total)), limit));
  notices.push(ctx.text("notice.thirdParty"), ctx.text("notice.yourMaterial"));
  return getApplicationContextOutput.parse(output);
}
