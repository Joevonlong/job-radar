import { REPLY_TERMINAL_STATUSES, type RepliesConfig } from "@/lib/config/schemas/replies";
import type { ApplicationStatus } from "@/lib/db/repos/applications";

import type { ReplyCategory, ReplySuggestion } from "./types";

const DAY_MS = 86_400_000;

/** What a reply of `category` suggests for an application in `status`. Terminal statuses, `other` and `unclassified` get nothing. */
export function suggestFor(category: ReplyCategory, status: ApplicationStatus | null, transitions: RepliesConfig["transitions"], receivedAt: Date): ReplySuggestion {
  if (status === null || category === "other" || category === "unclassified") return { kind: "none" };
  if ((REPLY_TERMINAL_STATUSES as readonly string[]).includes(status)) return { kind: "none" };
  const rule = transitions[category].find((candidate) => candidate.from.includes(status));
  if (!rule) return { kind: "none" };
  switch (rule.kind) {
    case "status":
      return rule.to === status ? { kind: "none" } : { kind: "status", from: status, to: rule.to };
    case "next_action":
      return { kind: "next_action", from: status, action: rule.action, due: rule.due_days === undefined ? null : new Date(receivedAt.getTime() + rule.due_days * DAY_MS).toISOString().slice(0, 10) };
    case "mismatch":
      return { kind: "mismatch", from: status };
  }
}

/** Whether the row waits for the user: something to confirm, something to choose, or a match that looks wrong. Otherwise it is only a record. */
export function needsDecision(input: { category: ReplyCategory; match: "matched" | "ambiguous" | "unmatched"; suggestion: ReplySuggestion }): boolean {
  if (input.category === "unclassified") return true;
  if (input.category === "other") return false;
  if (input.match !== "matched") return true;
  return input.suggestion.kind !== "none";
}
