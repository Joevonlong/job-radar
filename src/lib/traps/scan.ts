/**
 * The rule layer for one job: scan the HTML of every source posting and the JD text, place every finding in the JD
 * (or name the source field when the JD does not hold it), merge, and keep the strongest finding per piece of text. Pure.
 */
import type { TrapsConfig } from "@/lib/config/schemas/traps";

import { scanHtml, squash } from "./html";
import { firstTrigger, scanInstructions } from "./instructions";
import { locateLoose } from "./locate";
import type { HtmlFragment, RawFinding, TrapFinding } from "./types";
import { scanInvisibleUnicode } from "./unicode";

export interface ScanJobInput {
  description: string | null;
  sources: ReadonlyArray<{ rawPostingId: number; fragments: readonly HtmlFragment[] }>;
}

export interface ScanJobResult {
  findings: TrapFinding[];
  /** A trigger pattern (weaker than an instruction) matched the JD or a hidden text: the AI check should look at the job. */
  trigger: string | null;
}

/** Location of a finding that is in the JD text. */
export const IN_DESCRIPTION = "description";

const cut = (text: string, max: number): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);

function overlaps(a: TrapFinding, start: number, end: number): boolean {
  return a.quoteOffset !== null && start < a.quoteOffset + a.quote.length && end > a.quoteOffset;
}

const rank = (f: TrapFinding): number => (f.severity === "trap" ? 0 : 1);

function withInstruction(detail: Record<string, string | number>, instructionId: string | null): Record<string, string | number> {
  return instructionId === null ? detail : { ...detail, instruction_id: instructionId };
}

/** One HTML finding placed in the JD, or as a quote of the source field. */
function place(raw: RawFinding, rawPostingId: number, description: string, settings: TrapsConfig): TrapFinding | null {
  const found = description === "" ? null : locateLoose(description, raw.text);
  const detail = withInstruction(raw.detail, raw.instructionId);
  if (found) {
    return {
      technique: raw.technique,
      method: raw.method,
      severity: raw.severity,
      quote: description.slice(found.start, found.end),
      quoteSource: "description",
      quoteOffset: found.start,
      location: IN_DESCRIPTION,
      rawPostingId,
      evidence: raw.evidence,
      detail,
      inDescription: true,
    };
  }
  // what a converter leaks into the JD is the point of `non_rendered`: outside the JD it only counts with an instruction
  if (raw.technique === "non_rendered" && raw.instructionId === null) return null;
  return {
    technique: raw.technique,
    method: raw.method,
    severity: raw.severity,
    quote: cut(raw.text, settings.scan.quote_max_chars),
    quoteSource: "raw",
    quoteOffset: null,
    location: `raw:${raw.path}`,
    rawPostingId,
    evidence: raw.evidence,
    detail,
    inDescription: false,
  };
}

/**
 * Every rule finding of a job, at most `scan.max_findings_per_job` (traps first, then in JD order). An instruction inside hidden
 * text makes that hidden finding a trap (one finding, not two); the same hidden text in several sources is reported once.
 */
export function scanJob(input: ScanJobInput, settings: TrapsConfig): ScanJobResult {
  const description = input.description ?? "";
  const findings: TrapFinding[] = [];
  let trigger: string | null = null;
  const seen = new Set<string>();

  for (const source of input.sources) {
    for (const fragment of source.fragments) {
      for (const raw of scanHtml(fragment, settings)) {
        const key = `${raw.technique}|${squash(raw.text)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        trigger ??= firstTrigger(raw.text, settings);
        const placed = place(raw, source.rawPostingId, description, settings);
        if (!placed) continue;
        // two hidden elements of different sources can land on the same JD text: keep the stronger
        const clash = placed.quoteOffset === null ? -1 : findings.findIndex((f) => overlaps(f, placed.quoteOffset as number, (placed.quoteOffset as number) + placed.quote.length));
        if (clash >= 0) {
          const other = findings[clash] as TrapFinding;
          if (rank(placed) < rank(other)) findings[clash] = placed;
          continue;
        }
        findings.push(placed);
      }
    }
  }

  if (description !== "") {
    trigger ??= firstTrigger(description, settings);
    for (const raw of [...scanInstructions(description, settings, IN_DESCRIPTION), ...scanInvisibleUnicode(description, settings, IN_DESCRIPTION)]) {
      const start = raw.offset ?? 0;
      const end = start + raw.text.length;
      const host = findings.find((f) => f.technique === "hidden_text" || f.technique === "non_rendered" ? overlaps(f, start, end) : false);
      if (host && raw.technique === "instruction") {
        // the instruction sits in hidden text: that hidden text is the trap
        host.severity = "trap";
        host.detail = withInstruction(host.detail, host.detail.instruction_id === undefined ? raw.instructionId : null);
        continue;
      }
      if (findings.some((f) => overlaps(f, start, end) && f.technique === raw.technique)) continue;
      findings.push({
        technique: raw.technique,
        method: raw.method,
        severity: raw.severity,
        quote: raw.text,
        quoteSource: "description",
        quoteOffset: start,
        location: IN_DESCRIPTION,
        rawPostingId: null,
        evidence: raw.evidence,
        detail: withInstruction(raw.detail, raw.instructionId),
        inDescription: true,
      });
    }
  }

  const ordered = findings.sort((a, b) => rank(a) - rank(b) || (a.quoteOffset ?? Number.MAX_SAFE_INTEGER) - (b.quoteOffset ?? Number.MAX_SAFE_INTEGER) || a.location.localeCompare(b.location));
  return { findings: ordered.slice(0, settings.scan.max_findings_per_job), trigger };
}
