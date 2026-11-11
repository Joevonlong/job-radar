/**
 * What the MCP server may return: the ONLY implementation of the MCP client row of `docs/privacy.md`, with the data scope in
 * `docs/mcp.md`. Every output is a zod `strictObject` built field by field from the query results, never
 * "the whole row minus some fields", so a new column can never leak by itself. Adding a field here means updating
 * both docs in the same change; a field beyond its data scope needs the maintainer's decision first.
 *
 * Given: job facts, source links, score numbers and rank, compensation and benefit signals with their JD quotes, the JD after
 * AI-trap cleaning, and the status, status dates, next step and interview rounds of the user's applications.
 * Given only by `get_application_context`, which requires effective writer:read in mcp.yaml: a job's breakdown points; its application
 * questions and their settings; for each question the material chosen for it (profile summary, skills and languages, the chosen
 * stories, the emphasis note); the fields of the company background (AI web search, unverified) and the fit note made from them; and
 * the answer versions with their sentence statuses and evidence quotes.
 * Never given (no permission exposes them): the profile files as such and profile snapshots; stories not chosen for a question (a fit note keeps short quotes of the stories chosen when it was made, whatever is chosen now); anything derived from the profile (match reasons,
 * gaps, filter reasons, the salary floor, the German-level deduction, the signal bonus, deal-breaker hits and visa matches); notes
 * of any kind (application notes, event notes, favorite notes); local paths (resume variants); emails; secrets; AI usage,
 * notifications and run records.
 *
 * Every string that comes from a job posting goes through the caller's `clean` (invisible characters removed, an instruction to an
 * AI replaced by the trap marker) before it is put in a DTO.
 */
export { linkDto, locationDto, salaryDto, rankDto, toLinkDto, toLocationDto, toSalaryDto, type CleanText } from "./shared";
export { jobCardDto, amountDto, signalDto, descriptionDto, jobDetailDto, searchJobsOutput, getJobOutput, toJobCardDto, toSignalDto, toJobDetailDto, type JobCardDto, type DescriptionDto, type JobDetailDto, type SearchJobsOutput, type GetJobOutput, type QuoteGuard } from "./jobs";
export { applicationDto, historyDto, applicationItemDto, listApplicationsOutput, toApplicationDto, toApplicationItemDto, type ApplicationItemDto, type ListApplicationsOutput } from "./tracking";
export { writerVersionDto, writerJdPointDto, writerStoryDto, writerQuestionDto, getApplicationContextOutput, saveApplicationAnswerOutput, type WriterVersionDto, type WriterQuestionDto, type GetApplicationContextOutput, type SaveApplicationAnswerOutput } from "./writer";
