import { z } from "zod";

import { marketSettingsSchema } from "@/lib/market/schema";

import { nonEmptyString, nonNegativeInt, remoteScope, stringList } from "./common";

const contractKind = z.enum(["permanent", "fixed_term", "freelance", "temp_agency"]);
const workplace = z.enum(["onsite", "hybrid", "remote"]);

const uniqueEnumList = <T extends z.ZodType>(item: T) =>
  z.array(item).refine((xs) => new Set(xs).size === xs.length, "must not contain duplicates");

/** data/profile/preferences.yaml — what I want. */
export const preferencesSchema = z.strictObject({
  /** The market (pack, home country, base currency, local language); omitted values come from the pack. */
  market: marketSettingsSchema,
  target_titles: stringList.min(1),
  locations: stringList.min(1),
  workplace: uniqueEnumList(workplace).refine((w) => w.length > 0, "needs at least one workplace type"),
  remote_scope: remoteScope,
  seniority: z.enum(["all", "entry", "mid", "senior", "lead"]),
  /** Annual gross salary floor in the market's base currency (was `salary_floor_eur_year`); postings with a stated maximum below it are filtered out. */
  salary_floor_year: nonNegativeInt,
  contracts: z
    .strictObject({
      allow: uniqueEnumList(contractKind),
      exclude: uniqueEnumList(contractKind),
    })
    .refine((c) => !c.allow.some((kind) => c.exclude.includes(kind)), {
      message: "a contract type cannot be both allowed and excluded",
      path: ["exclude"],
    }),
  exclude_student_roles: z.boolean(),
  exclude_companies: z.array(nonEmptyString),
  exclude_keywords: z.array(nonEmptyString),
});

export type PreferencesConfig = z.infer<typeof preferencesSchema>;
