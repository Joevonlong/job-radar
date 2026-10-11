import { z } from "zod";

import { nonEmptyString } from "./common";

export const ATS_KINDS = ["greenhouse", "lever", "ashby", "personio", "smartrecruiters"] as const;

export const ATS_REGIONS = ["global", "eu"] as const;

/** One ATS company board (an entry of `ats_boards` in config/sources.yaml). */
export const atsBoardEntrySchema = z.strictObject({
  name: nonEmptyString,
  ats: z.enum(ATS_KINDS),
  /** Board token / site slug used in the ATS public API. */
  token: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "token must be a plain board slug"),
  enabled: z.boolean(),
  /** Lever only: which API host serves the board (`eu` = api.eu.lever.co). Defaults to `global`. */
  region: z.enum(ATS_REGIONS).optional(),
});

/** The `ats_boards` list of config/sources.yaml. */
export const atsBoardsSchema = z.array(atsBoardEntrySchema).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((c, i) => {
    const key = `${c.ats}:${c.token.toLowerCase()}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", message: "duplicate ats + token", path: [i, "token"] });
    }
    seen.add(key);
    if (c.region === "eu" && c.ats !== "lever") {
      ctx.addIssue({ code: "custom", message: "region eu only applies to lever boards", path: [i, "region"] });
    }
  });
});

/** The ATS boards as the channels expect them: `{ companies: [...] }`. */
export const companiesSchema = z.strictObject({ companies: atsBoardsSchema });

export type CompaniesConfig = z.infer<typeof companiesSchema>;
export type CompanyEntry = z.infer<typeof atsBoardEntrySchema>;
