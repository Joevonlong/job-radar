// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { agentCallerSchema, callerKey, withoutCaller } from "@/lib/agent-access/caller";
import {
  breakdownJobPayloadSchema, careerExtractPayloadSchema, careerTailorPayloadSchema, companyResearchPayloadSchema,
  modelsSyncPayloadSchema, rescorePayloadSchema, runAiPayloadSchema, runCyclePayloadSchema, salaryLookupPayloadSchema,
  scoreJobsPayloadSchema, storyExtractPayloadSchema, testAiPayloadSchema, testChannelPayloadSchema, testTelegramPayloadSchema,
  translateJobPayloadSchema, writerFitPayloadSchema, writerJobPayloadSchema,
} from "@/lib/control/types";

const hash = "a".repeat(64);
const story = { id: "story", title: "A story", what: "Built a service", result: null, metrics: [], skills: [], period: null };
const company = { researchId: 1, expired: false, fields: [] };
const cases: { name: string; schema: z.ZodType; payload: Record<string, unknown> }[] = [
  { name: "runCycle", schema: runCyclePayloadSchema, payload: {} },
  { name: "rescore", schema: rescorePayloadSchema, payload: {} },
  { name: "runAi", schema: runAiPayloadSchema, payload: { cycleId: 1 } },
  { name: "translateJob", schema: translateJobPayloadSchema, payload: { jobId: 1 } },
  { name: "breakdownJob", schema: breakdownJobPayloadSchema, payload: { jobId: 1 } },
  { name: "writerJob", schema: writerJobPayloadSchema, payload: {
    jobId: 1, questionId: 1, materialsHash: hash,
    refs: { storyIds: [], jdPoints: 0, profile: false, emphasis: false },
    materials: {
      question: { text: "Why us?", kind: "question", lengthUnit: "words", lengthValue: 100, outputLanguage: "en", tone: "neutral", variants: [] },
      job: { title: "Engineer", company: "Example" }, jdPoints: [], useJdText: false, profile: null, stories: [], emphasis: null,
    },
  } },
  { name: "storyExtract", schema: storyExtractPayloadSchema, payload: { origin: "self_description", sourceHash: hash, sourceChars: 5, truncated: false, text: "Story" } },
  { name: "careerExtract", schema: careerExtractPayloadSchema, payload: { origin: "resume", sourceHash: hash, sourceChars: 6, text: "Resume" } },
  { name: "careerTailor", schema: careerTailorPayloadSchema, payload: { mode: "tailor", doc_id: "doc_abcdefghij", outbound_hash: hash } },
  { name: "writerFit", schema: writerFitPayloadSchema, payload: {
    jobId: 1, questionId: 1, materialsHash: hash,
    refs: { storyIds: ["story"], companyResearchId: 1 },
    materials: { job: { title: "Engineer", company: "Example" }, outputLanguage: "en", stories: [story], company },
  } },
  { name: "salaryLookup", schema: salaryLookupPayloadSchema, payload: { jobId: 1 } },
  { name: "companyResearch", schema: companyResearchPayloadSchema, payload: { jobId: 1, companyId: 1 } },
  { name: "scoreJobs ids", schema: scoreJobsPayloadSchema, payload: { jobIds: [1] } },
  { name: "scoreJobs backlog", schema: scoreJobsPayloadSchema, payload: { backlog: true } },
  { name: "testChannel", schema: testChannelPayloadSchema, payload: { channelId: "fixture" } },
  { name: "testAi", schema: testAiPayloadSchema, payload: { provider: "anthropic" } },
  { name: "modelsSync", schema: modelsSyncPayloadSchema, payload: { provider: "openrouter" } },
  { name: "testTelegram", schema: testTelegramPayloadSchema, payload: {} },
];

describe.each(cases)("caller marker in $name", ({ schema, payload }) => {
  it("preserves the existing payload when no caller is given", () => {
    expect(schema.safeParse(payload).success).toBe(true);
    expect(schema.parse(payload)).not.toHaveProperty("caller");
  });

  it.each(["stdio", 7])("accepts caller %s without changing other fields", (caller) => {
    expect(schema.parse({ ...payload, caller })).toEqual({ ...schema.parse(payload) as Record<string, unknown>, caller });
  });

  it.each([0, "token", 1.5])("rejects caller %s", (caller) => {
    expect(schema.safeParse({ ...payload, caller }).success).toBe(false);
  });
});

it("drops a caller from untrusted input and leaves everything else as it is", () => {
  expect(withoutCaller({ jobIds: [1], caller: 7 })).toEqual({ jobIds: [1] });
  expect(withoutCaller({ backlog: true, caller: "stdio" })).toEqual({ backlog: true });
  const plain = { jobIds: [1] };
  expect(withoutCaller(plain)).toBe(plain);
  for (const raw of [null, undefined, "caller", 7, ["caller"]]) expect(withoutCaller(raw)).toBe(raw);
});

it("uses separate keys for stdio and numeric tokens", () => {
  expect(callerKey(agentCallerSchema.parse("stdio"))).toBe("stdio");
  expect(callerKey(agentCallerSchema.parse(7))).toBe("token:7");
});
