/** Match judgements omit the profile values used to compute them; AI-written texts follow the JD's availability (`available`, `reason`). */
import { z } from "zod";

import { VISA_KINDS, VISA_STATUSES } from "@/lib/visa/types";

const reason = z.strictObject({ text: z.string(), basis: z.enum(["jd", "inferred", "unstated"]).nullable(), quote: z.string().nullable(), offset: z.number().int().nullable() });

export const matchBlockDto = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
  summaries: z.record(z.string(), z.string()),
  output_lang: z.string().nullable(),
  ai_score: z.number().nullable(),
  german_penalty: z.number(),
  scored_at: z.iso.datetime({ offset: true }).nullable(),
  stale: z.boolean(),
  fit_reasons: z.array(reason),
  gaps: z.array(reason),
  filter: z.strictObject({ result: z.enum(["passed", "filtered_out"]), reasons: z.array(z.string()) }),
  deal_breakers: z.array(z.strictObject({ id: z.string(), type: z.enum(["phrase", "language_gate", "visa_not_offered"]), field: z.enum(["title", "description"]).nullable(), quote: z.string().nullable(), offset: z.number().int().nullable(), required: z.string().nullable(), visa_kind: z.enum(VISA_KINDS).nullable() })),
  visa: z.strictObject({ state: z.enum([...VISA_STATUSES, "not_checked"]), kind: z.enum(VISA_KINDS).nullable(), checked_at: z.iso.datetime({ offset: true }).nullable(), match: z.enum(["supports", "refuses", "neutral"]), evidence: z.array(z.strictObject({ status: z.enum(["offered", "not_offered", "unclear"]), kind: z.enum(VISA_KINDS).nullable(), quote: z.string().nullable(), offset: z.number().int() })) }).nullable(),
  checks: z.strictObject({
    skills: z.array(z.strictObject({ name: z.string(), have: z.boolean() })),
    german: z.strictObject({ state: z.enum(["not_required", "preferred", "unknown", "met", "gap", "no_german"]), required: z.string().nullable() }),
    salary_floor: z.strictObject({ state: z.enum(["pass", "fail", "no_salary", "other_region", "no_floor"]), figure: z.number().nullable(), currency: z.string(), approx: z.boolean() }),
  }),
}).nullable();
