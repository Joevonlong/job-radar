import type { RepliesConfig } from "@/lib/config/schemas/replies";

/** A Gmail search for the replies of the current applications: the ATS senders and the company names. The user pastes it into a Gmail filter. */
export function gmailFilterQuery(input: { companies: readonly string[]; hosts: readonly string[] }, match: Pick<RepliesConfig["match"], "ats_sender_domains" | "generic_domains">): string {
  const skip = [...match.ats_sender_domains, ...match.generic_domains];
  const hosts = [...new Set(input.hosts.map((host) => host.toLowerCase().replace(/^www\./, "")))].filter((host) => !skip.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  const senders = [...new Set([...match.ats_sender_domains, ...hosts])].sort();
  const names = [...new Set(input.companies.map((name) => name.replace(/"/g, "").trim()).filter(Boolean))].sort();
  const parts = [`from:(${senders.join(" OR ")})`];
  if (names.length > 0) parts.push(`subject:(${names.map((name) => `"${name}"`).join(" OR ")})`);
  return parts.join(" OR ");
}
