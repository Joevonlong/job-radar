import { z } from "zod";

import { redactedProfileSchema } from "@/lib/career/contact/redact-profile";
import { redactedDocumentSchema } from "@/lib/career/document/redact";
import { proposalSchema } from "@/lib/career/tailor/proposal-schema";

const notices = z.array(z.string());
const versions = z.array(z.strictObject({
  id: z.string(),
  createdAt: z.string(),
  hash: z.string(),
}));
export const getCareerProfileOutput = z.strictObject({
  notices,
  profile: redactedProfileSchema,
  baseHash: z.string().nullable(),
  updatedAt: z.string().nullable(),
  versions,
  version: z.string().nullable(),
  hasPhoto: z.boolean(),
  hasSignature: z.boolean(),
});
export const listCareerDocumentsOutput = z.strictObject({
  notices,
  documents: z.array(z.strictObject({
    id: z.string(),
    status: z.enum(["ok", "invalid"]),
    title: z.string().nullable(),
    kind: z.enum(["general", "tailored"]).nullable(),
    updatedAt: z.string().nullable(),
    lang: z.string().nullable(),
    jobId: z.number().nullable(),
  })),
  total: z.number().int().nonnegative(),
});
const proposalDto = proposalSchema.extend({
  support: z.array(z.union([
    z.strictObject({ quote: z.string().nullable() }),
    z.strictObject({ entry: z.string() }),
  ])),
});
export const getCareerDocumentOutput = z.strictObject({
  notices,
  document: redactedDocumentSchema,
  baseHash: z.string().nullable(),
  versions,
  version: z.string().nullable(),
  source: z.strictObject({
    jdChanged: z.boolean().nullable(),
    profileChanged: z.boolean().nullable(),
  }),
  proposals: z.strictObject({
    status: z.enum(["ok", "unavailable"]),
    stale: z.boolean().nullable(),
    items: z.array(proposalDto),
  }).nullable(),
});
const findingDto = z.strictObject({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  severity: z.enum(["error", "warn", "info", "ok"]),
  path: z.string().optional(),
});
export const checkCareerDocumentOutput = z.strictObject({
  notices,
  renderable: z.boolean(),
  issues: z.array(z.strictObject({
    path: z.string(),
    code: z.string(),
  })),
  text: z.string().nullable(),
  pageBudget: z.strictObject({ pages: z.number().int().positive() }).nullable(),
  findings: z.array(findingDto),
  uncovered: z.array(z.string()),
  exportHints: z.strictObject({
    findings: z.array(findingDto),
    uncovered: z.array(z.string()),
  }).nullable(),
});
