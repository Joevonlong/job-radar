/**
 * Board candidates of web-search discovery as `/sources` shows them, and the two things the
 * user can do with one: put it into `ats_boards` of `config/sources.yaml` through the shared config mutator,
 * or dismiss it.
 */
import { logActionFailure } from "@/lib/logging/action-failure";
import { z } from "zod";

import { boardKey } from "@/lib/channels/discovery/boards";
import { ATS_KINDS, ConfigError, configErrorKey, mutateConfig, readConfigText, reloadConfig, type CompaniesConfig, type ConfigWriteErrorKey } from "@/lib/config";
import { getDb, listBoardCandidates, setBoardCandidateStatus, type BoardCandidateRow } from "@/lib/db";

import { syncSourceRegistry } from "./registry/sync";

export interface CandidateView {
  ats: (typeof ATS_KINDS)[number];
  token: string;
  region: "eu" | null;
  /** The name the `ats_boards` entry will get. */
  name: string;
  boardUrl: string;
  /** Title of the search result that led to the board. */
  title: string | null;
  seenCount: number;
  lastSeenAt: Date;
}

const atsSchema = z.enum(ATS_KINDS);

/** "acme-labs" -> "Acme Labs"; a token that already has capitals ("BoschGroup") stays as it is. */
export function candidateName(token: string): string {
  if (/[A-Z]/.test(token)) return token;
  return token
    .split(/[-_.]+/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Candidates that still wait for the user: rows with status `new` that are not in `ats_boards` (added by hand meanwhile). */
export function toCandidateViews(rows: readonly BoardCandidateRow[], companies: CompaniesConfig): CandidateView[] {
  const known = new Set(companies.companies.map((c) => boardKey(c.ats, c.token)));
  const views: CandidateView[] = [];
  for (const row of rows) {
    const ats = atsSchema.safeParse(row.ats);
    if (!ats.success || row.status !== "new" || known.has(boardKey(row.ats, row.token))) continue;
    views.push({
      ats: ats.data,
      token: row.token,
      region: row.region === "eu" ? "eu" : null,
      name: candidateName(row.token),
      boardUrl: row.boardUrl,
      title: row.title,
      seenCount: row.seenCount,
      lastSeenAt: row.lastSeenAt,
    });
  }
  return views;
}

/** The candidates for `/sources`; null when the database or the config cannot be read. */
export async function loadBoardCandidates(): Promise<CandidateView[] | null> {
  try {
    return toCandidateViews(await listBoardCandidates(getDb(), "new"), { companies: reloadConfig("channels").ats_boards });
  } catch (error) {
    logActionFailure("loadBoardCandidates", error);
    return null;
  }
}

export const candidateKeySchema = z.strictObject({
  ats: atsSchema,
  token: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
});

export type CandidateActionState =
  | { status: "done"; outcome: "added" | "already_listed" | "dismissed" }
  | { status: "error"; error: "invalid" | "unknown_candidate" | "config_invalid" | "write_failed" | "database_unavailable" | ConfigWriteErrorKey };

const fail = (error: Extract<CandidateActionState, { status: "error" }>["error"]): CandidateActionState => ({ status: "error", error });

/** Add a candidate board to `ats_boards` of sources.yaml (enabled), then mark it added. `raw` is untrusted. */
export async function addBoardCandidate(raw: unknown): Promise<CandidateActionState> {
  const key = candidateKeySchema.safeParse(raw);
  if (!key.success) return fail("invalid");
  let row: BoardCandidateRow | undefined;
  try {
    row = (await listBoardCandidates(getDb(), "new")).find((r) => r.ats === key.data.ats && r.token === key.data.token);
  } catch (error) {
    logActionFailure("addBoardCandidate", error);
    return fail("database_unavailable");
  }
  if (!row) return fail("unknown_candidate");

  let outcome: "added" | "already_listed" = "already_listed";
  try {
    const candidate = row;
    const changed = await mutateConfig("channels", (current) => {
      if (current.ats_boards.some((c) => boardKey(c.ats, c.token) === boardKey(key.data.ats, key.data.token))) return null;
      return {
        ...current,
        ats_boards: [...current.ats_boards, { name: candidateName(candidate.token), ats: key.data.ats, token: candidate.token, enabled: true, ...(key.data.ats === "lever" && candidate.region === "eu" ? { region: "eu" as const } : {}) }],
      };
    });
    outcome = changed === null ? "already_listed" : "added";
  } catch (error) {
    logActionFailure("addBoardCandidate", error);
    return fail(configErrorKey(error) ?? (error instanceof ConfigError ? "config_invalid" : "write_failed"));
  }
  if (outcome === "added") {
    // keep the database mirror of sources.yaml in step (a failure is caught up by the next page load or runner reload)
    try {
      await syncSourceRegistry(getDb(), { config: reloadConfig("channels"), text: readConfigText("channels") });
    } catch (error) {
      logActionFailure("addBoardCandidate", error);
      // mirror out of sync until then
    }
  }
  try {
    await setBoardCandidateStatus(getDb(), key.data, "added");
  } catch (error) {
    logActionFailure("addBoardCandidate", error);
    return fail("database_unavailable");
  }
  return { status: "done", outcome };
}

/** Hide a candidate for good (discovery will not list it again). */
export async function dismissBoardCandidate(raw: unknown): Promise<CandidateActionState> {
  const key = candidateKeySchema.safeParse(raw);
  if (!key.success) return fail("invalid");
  try {
    return (await setBoardCandidateStatus(getDb(), key.data, "dismissed")) ? { status: "done", outcome: "dismissed" } : fail("unknown_candidate");
  } catch (error) {
    logActionFailure("dismissBoardCandidate", error);
    return fail("database_unavailable");
  }
}
