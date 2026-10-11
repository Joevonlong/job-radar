import { z } from "zod";

/** What a JD says about visa sponsorship: support mentioned, refused (or a permit required), mentioned but unclear, nothing. */
export const VISA_STATUSES = ["offered", "not_offered", "unclear", "not_mentioned"] as const;
export type VisaStatus = (typeof VISA_STATUSES)[number];

/** Why a JD counts as `not_offered`: it refuses sponsorship, or it requires a work permit the candidate already has. */
export const VISA_KINDS = ["no_sponsorship", "permit_required"] as const;
export type VisaKind = (typeof VISA_KINDS)[number] | null;

/** One quote behind a result: a verbatim piece of `jobs.description` and its offset (C7). `kind` is set only for `not_offered`. */
export const visaEvidenceSchema = z
  .strictObject({
    status: z.enum(["offered", "not_offered", "unclear"]),
    kind: z.enum(VISA_KINDS).nullable(),
    quote: z.string().min(1),
    offset: z.number().int().nonnegative(),
  })
  .refine((e) => (e.status === "not_offered") === (e.kind !== null), "kind is set exactly when status is not_offered");
export type VisaEvidence = z.infer<typeof visaEvidenceSchema>;

export const visaEvidenceListSchema = z.array(visaEvidenceSchema);

export interface VisaResult {
  status: VisaStatus;
  evidence: VisaEvidence[];
}

/** The `kind` of a `not_offered` result (that of its first `not_offered` quote); null otherwise. */
export function visaKindOf(result: Pick<VisaResult, "status" | "evidence">): VisaKind {
  if (result.status !== "not_offered") return null;
  return result.evidence.find((e) => e.status === "not_offered")?.kind ?? "no_sponsorship";
}

