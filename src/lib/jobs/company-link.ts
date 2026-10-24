import { cleanMultiValues } from "./filter-values";
import { jobsListHref } from "./search-params";

/**
 * `/jobs?company=<name>`: the list of this company's jobs only (no other filter). Null when the name cannot be a filter value (too
 * long for the URL): the name is then shown as plain text.
 */
export function companyJobsHref(name: string): string | null {
  const [value, ...rest] = cleanMultiValues("company", [name]);
  return value === undefined || rest.length > 0 ? null : jobsListHref({ company: [value] });
}
