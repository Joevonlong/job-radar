import type { RepliesConfig } from "@/lib/config/schemas/replies";
import { normalizeCompanyKey } from "@/lib/pipeline/company";

import type { ConfirmedThread, MatchCandidate, ReplyCandidateScore, ReplyCategory, ReplyMatch } from "./types";

export interface ReplyEvidence {
  category: ReplyCategory;
  senderAddress: string;
  senderName: string;
  senderDomain: string;
  subject: string;
  /** The visible body, as far as the rules read it. */
  body: string;
  threadId: string | null;
  receivedAt: Date;
}

export interface MatchResult {
  match: ReplyMatch;
  applicationId: number | null;
  jobId: number | null;
  score: number | null;
  /** Best first, at most `match.max_candidates`. */
  candidates: ReplyCandidateScore[];
}

/** `a.b.example.com` is on `example.com`. */
const onDomain = (domain: string, parent: string): boolean => domain === parent || domain.endsWith(`.${parent}`);

export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/** `Acme GmbH` as `-acme-gmbh-`: a whole-word search in a text keyed the same way, so `acme` does not hit `acmeville`. */
const framed = (key: string): string => `-${key}-`;

function hasName(haystack: string, names: readonly string[], legalSuffixes: readonly string[], minChars: number): boolean {
  return names.some((name) => {
    const key = normalizeCompanyKey(name, legalSuffixes);
    return key.length >= minChars && haystack.includes(framed(key));
  });
}

function titleOverlap(title: string, text: string, minWordChars: number): number {
  const words = (value: string): string[] => value.toLocaleLowerCase("en").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= minWordChars);
  const wanted = [...new Set(words(title))];
  if (wanted.length === 0) return 0;
  const present = new Set(words(text));
  return wanted.filter((word) => present.has(word)).length / wanted.length;
}

/**
 * Which application a reply belongs to. Hard rules first: a mail older than the application is not about it, and `interested` (not applied
 * as far as we know) can only get an acknowledgement. A confirmed thread decides at once when the sender's domain is the same and the
 * subject is not one many companies share (Gmail threads different companies' mails from one no-reply sender with one subject). Then the
 * evidence adds up. Title words only tell candidates apart: they never make one on their own.
 */
export function matchReply(evidence: ReplyEvidence, candidates: readonly MatchCandidate[], threads: readonly ConfirmedThread[], config: RepliesConfig["match"], legalSuffixes: readonly string[]): MatchResult {
  const eligible = candidates.filter((c) => c.since.getTime() <= evidence.receivedAt.getTime() && (c.status !== "interested" || evidence.category === "acknowledgement"));
  const generic = config.generic_subjects.some((source) => new RegExp(source, "iu").test(evidence.subject.trim()));
  const thread = evidence.threadId === null ? [] : threads.filter((t) => t.threadId === evidence.threadId);
  const sameThread = thread.find((t) => t.senderDomain === evidence.senderDomain && !generic);
  if (sameThread) {
    const followed = eligible.find((c) => c.applicationId === sameThread.applicationId);
    if (followed) {
      const candidate: ReplyCandidateScore = { applicationId: followed.applicationId, jobId: followed.jobId, score: config.weights.thread, hits: ["thread"] };
      return { match: "matched", applicationId: followed.applicationId, jobId: followed.jobId, score: candidate.score, candidates: [candidate] };
    }
  }

  const text = `${evidence.senderName}\n${evidence.subject}\n${evidence.body}`;
  const haystack = framed(normalizeCompanyKey(text, []));
  const senderKey = framed(normalizeCompanyKey(evidence.senderAddress, []));
  const isAts = config.ats_sender_domains.some((domain) => onDomain(evidence.senderDomain, domain));
  const isGeneric = isAts || config.generic_domains.some((domain) => onDomain(evidence.senderDomain, domain));

  const scored: ReplyCandidateScore[] = [];
  for (const candidate of eligible) {
    const hits: string[] = [];
    let score = 0;
    const add = (hit: string, weight: number): void => {
      hits.push(hit);
      score += weight;
    };
    const named = hasName(haystack, [candidate.companyName, ...candidate.aliases], legalSuffixes, config.min_company_chars);
    const tokenKey = candidate.atsToken === null ? "" : normalizeCompanyKey(candidate.atsToken, []);
    const token = tokenKey.length >= config.min_company_chars && (haystack.includes(framed(tokenKey)) || senderKey.includes(framed(tokenKey)));
    if (thread.some((t) => t.applicationId === candidate.applicationId)) add("thread", config.weights.thread);
    if (isAts && (named || token)) add("ats", config.weights.ats);
    if (named) add("company", config.weights.company);
    if (!isGeneric && evidence.senderDomain !== "" && candidate.hosts.some((host) => onDomain(evidence.senderDomain, host) || onDomain(host, evidence.senderDomain))) add("domain", config.weights.domain);
    if (hits.length === 0) continue;
    const overlap = titleOverlap(candidate.title, text, config.min_title_word_chars);
    if (overlap > 0) add("title", Math.round(config.weights.title * overlap * 100) / 100);
    scored.push({ applicationId: candidate.applicationId, jobId: candidate.jobId, score, hits });
  }
  scored.sort((a, b) => b.score - a.score || a.applicationId - b.applicationId);
  const kept = scored.slice(0, config.max_candidates);
  const [top, second] = kept;
  if (!top) return { match: "unmatched", applicationId: null, jobId: null, score: null, candidates: [] };
  if (top.score >= config.min_score && (!second || top.score - second.score >= config.min_margin)) {
    return { match: "matched", applicationId: top.applicationId, jobId: top.jobId, score: top.score, candidates: kept };
  }
  return { match: "ambiguous", applicationId: null, jobId: null, score: top.score, candidates: kept };
}
