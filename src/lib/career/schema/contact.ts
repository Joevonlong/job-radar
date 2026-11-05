import { z } from "zod";

const field = z.string().max(20000).nullable().default(null);
export const careerContactSchema = z.strictObject({
  schema_version: z.literal(1).default(1),
  name: field,
  address: field,
  location: field,
  email: field,
  phone: field,
  work_auth: field,
  availability: field,
  links: z
    .array(z.strictObject({ label: z.string().max(20000), url: z.url({ protocol: /^https?$/ }).max(20000) }))
    .max(100)
    .default([]),
  photo: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(?:png|jpe?g|webp)$/i)
    .optional(),
});
export type CareerContact = z.infer<typeof careerContactSchema>;
export function emptyContact(): CareerContact {
  return careerContactSchema.parse({});
}
