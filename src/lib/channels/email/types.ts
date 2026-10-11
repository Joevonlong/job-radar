import type { GmailPlatform } from "@/lib/config";

export type { GmailPlatform };

export type AlertWorkplace = "remote" | "hybrid" | "onsite";

/** One job card of an alert email, as far as the email states it (nothing is guessed). */
export interface AlertJob {
  /** Platform job id when the link carries one; null = the normalized link identifies the job. */
  id: string | null;
  /** Canonical link: tracking parameters and redirect wrappers removed. */
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  workplace: AlertWorkplace | null;
  salaryText: string | null;
  /** Teaser text of the card, when the platform includes one. */
  snippet: string | null;
}

/** An email parser: pure, no I/O. Returns the job cards it recognises (possibly none). */
export interface AlertParser {
  readonly platform: GmailPlatform;
  parse(html: string): AlertJob[];
}
