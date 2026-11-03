import { z } from "zod";

/**
 * What the channel reads of the job list the site embeds in its page (`__NEXT_DATA__`): the apply link and the company's name.
 * Nothing else is declared, so nothing else is kept: the page also carries the companies' contact details, and `z.object`
 * drops every key that is not named here.
 */

/** The path down to the list; each entry is checked on its own (see `jobSchema`), so one odd entry costs only itself. */
export const nextDataSchema = z.object({
  props: z.object({ pageProps: z.object({ page: z.object({ pageData: z.object({ jobs: z.array(z.unknown()) }) }) }) }),
});

export const jobSchema = z.object({
  attributes: z.object({
    link: z.string(),
    at_company_text: z.string().nullish(),
  }),
});
export type BerlinDesignNetworkJob = z.infer<typeof jobSchema>;
