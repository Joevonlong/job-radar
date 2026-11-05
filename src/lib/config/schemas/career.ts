import { z } from "zod";

import { figureUnitsSchema } from "./writer";

export const CAREER_DEFAULT_TIMEOUT_SECONDS = 300;
export const CAREER_DEFAULT_EXPIRY_GRACE_SECONDS = 60;
export const CAREER_DEFAULT_QUEUE_TIMEOUT_SECONDS = 900;

const positive = (fallback: number, max: number) => z.number().int().min(1).max(max).default(fallback);
const words = z.array(z.string().trim().min(1).max(200)).max(100);

export const careerSchema = z.strictObject({
  enabled: z.boolean().default(false),
  timeout_seconds: positive(CAREER_DEFAULT_TIMEOUT_SECONDS, 1800),
  expiry_grace_seconds: positive(CAREER_DEFAULT_EXPIRY_GRACE_SECONDS, 600),
  queue_timeout_seconds: positive(CAREER_DEFAULT_QUEUE_TIMEOUT_SECONDS, 7200),
  import: z
    .strictObject({
      formats: z
        .array(z.enum(["pdf", "md", "txt"]))
        .min(1)
        .max(3)
        .default(["pdf", "md", "txt"]),
      max_file_bytes: positive(2000000, 20000000),
      upload_timeout_seconds: positive(30, 300),
      max_chars: positive(30000, 200000),
      min_chars: positive(20, 200000),
      pdf_timeout_seconds: positive(15, 300),
      pdf_max_memory_mb: positive(256, 2048),
      max_concurrent_uploads: positive(2, 20),
      draft_ttl_days: positive(14, 365),
      max_pending_drafts: positive(5, 100),
      output_truncated_share: z.number().min(0).max(1).default(0.95),
      stored_value_min_chars: positive(3, 100),
      title_words: words.default([
        "Lebenslauf",
        "Curriculum Vitae",
        "CV",
        "Resume",
        "Résumé",
        "Tabellarischer Lebenslauf",
      ]),
      sensitive_labels: words.default([
        "Geburtsdatum",
        "Geburtsort",
        "Staatsangehörigkeit",
        "Nationalität",
        "Familienstand",
        "Anschrift",
        "Date of birth",
        "Place of birth",
        "Nationality",
        "Marital status",
        "Address",
      ]),
    })
    .prefault({})
    .refine((value) => value.min_chars <= value.max_chars, { path: ["min_chars"], message: "invalid limits" }),
  profile: z
    .strictObject({
      max_entries: positive(100, 1000),
      max_bullets_per_entry: positive(30, 100),
      max_wordings_per_text: positive(10, 50),
      text_max_chars: positive(4000, 20000),
    })
    .prefault({}),
  history: z.strictObject({ keep_versions: positive(50, 1000) }).prefault({}),
  evidence: z
    .strictObject({
      min_quote_chars: positive(4, 1000),
      quote_max_chars: positive(160, 4000),
      figure_units: figureUnitsSchema.prefault({}),
    })
    .prefault({})
    .refine((value) => value.min_quote_chars <= value.quote_max_chars, {
      path: ["min_quote_chars"],
      message: "invalid limits",
    }),
});

export type CareerConfig = z.infer<typeof careerSchema>;
