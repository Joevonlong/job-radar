/**
 * What the MCP server may return: the ONLY implementation of the MCP client row of `docs/privacy.md`, with the data scope in
 * `docs/mcp.md`. Every output is a zod `strictObject` built field by field from the query results, never
 * "the whole row minus some fields", so a new column can never leak by itself. Adding a field here means updating
 * both docs in the same change; a field beyond its data scope needs the maintainer's decision first.
 *
 * Given per effective permission: jobs:read gives job facts, links, scores, signals and the cleaned JD; get_job include adds
 * translation, breakdown, salary, company, ghost and lifecycle. tracking:read adds application history, favorites, seen, closure
 * and filter override. match:read adds summaries, fit reasons, gaps, filter reasons, deal-breaker evidence, visa and match checks.
 * notes:read adds application, event and favorite notes. No other permission adds a get_job block. Search cards add only the
 * one-line summary/language and filter result/reasons under match:read, and status/favorite/seen under tracking:read.
 * Given only by `get_application_context`, which requires effective writer:read in mcp.yaml: a job's breakdown points; its application
 * questions and their settings; for each question the material chosen for it (profile summary, skills and languages, the chosen
 * stories, the emphasis note); the fields of the company background (AI web search, unverified) and the fit note made from them; and
 * the answer versions with their sentence statuses and evidence quotes.
 * profile:read gives selected me/preferences/stories drafts with their web form hashes, interest vocabulary, saved views,
 * watched companies, pending suggestions and read-only rule previews. No history or import drafts are included.
 * career:read gives redacted career profiles, documents, versions, source status, proposals and checks; image presence only.
 * Contact values and links become bracket placeholders. The contact file, image bytes, HTML and PDF are never returned.
 * replies:read gives classification, match/state/time and the linked application's job; its status needs tracking:read; no mail content or transport identifiers.
 * Operations require ops:read: safe doctor summaries, cycle/channel/activity codes and counts, and aggregate AI usage.
 * Never given under any permission: local paths (resume variants), mail content, secrets, profile snapshots, AI provider/model at job level, job-level AI usage, notifications,
 * raw errors and raw run payloads. Writer material is the explicitly selected subset described above; unselected stories are never given by writer:read alone (a fit note
 * can retain short quotes selected when it was made).
 *
 * Posting strings go through the caller's `clean` (invisible characters removed, an instruction to an AI replaced by the trap
 * marker), except `get_job_raw` under raw:read: its JSON payloads are uncleaned and may contain recruiter contact data or AI
 * instructions. Only their combined length is capped; metadata including parse_error is cleaned independently.
 */
export { linkDto, locationDto, salaryDto, rankDto, toLinkDto, toLocationDto, toSalaryDto, type CleanText } from "./shared";
export { jobCardDto, amountDto, signalDto, descriptionDto, jobDetailDto, searchJobsOutput, searchJobsOutputFor, getJobOutput, getJobOutputFor, releasedJobCard, releasedJobDetail, toJobCardDto, toSignalDto, toJobDetailDto, type JobCardDto, type DescriptionDto, type JobDetailDto, type SearchJobsOutput, type GetJobOutput, type QuoteGuard } from "./jobs";
export { translationBlockDto, breakdownBlockDto, salaryBlockDto, companyBlockDto, ghostBlockDto, ghostReasonDto, lifecycleBlockDto } from "./job-analysis";
export { cardMatchBlockDto, cardTrackingBlockDto } from "./job-card-blocks";
export { matchBlockDto } from "./job-match";
export { trackingBlockDto } from "./job-tracking";
export { notesBlockDto } from "./notes";
export { applicationDto, historyDto, applicationItemDto, listApplicationsOutput, toApplicationDto, toApplicationItemDto, type ApplicationItemDto, type ListApplicationsOutput } from "./tracking";
export { writerVersionDto, writerJdPointDto, writerStoryDto, writerQuestionDto, getApplicationContextOutput, saveApplicationAnswerOutput, type WriterVersionDto, type WriterQuestionDto, type GetApplicationContextOutput, type SaveApplicationAnswerOutput } from "./writer";
export { systemStatusOutput, listCyclesOutput, listChannelsOutput, activityLogOutput, aiUsageOutput } from "./ops";
export { getProfileOutput, getInterestsOutput, previewDealBreakersOutput, previewInterestCategoryOutput, toMeDto, toPreferencesDto, toStoriesDto, toInterestSettingsDto, toSuggestionDto, toDealBreakerPreviewDto, toCategoryPreviewDto, type GetProfileOutput, type GetInterestsOutput } from "./profile";

export { getCareerProfileOutput, listCareerDocumentsOutput, getCareerDocumentOutput, checkCareerDocumentOutput } from "./career";
export { listRepliesOutput, listRepliesOutputFor } from "./replies";
export { rawPostingDto, getJobRawOutput, toRawPostingDtos } from "./raw";
