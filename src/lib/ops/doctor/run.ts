import { CHECK_GROUPS, SkipCheck, type CheckOutcome, type CheckResult, type CheckStatus, type DoctorCheck, type DoctorContext, type DoctorReport } from "./types";
import { redact, worstOf } from "./helpers";
import { ALL_CHECKS } from "./checks";

const EXIT_CODE: Record<CheckStatus, 0 | 1 | 2> = { ok: 0, warn: 1, fail: 2 };

/** A check that hangs must not hang the report: every probe has its own time-out, this is the backstop. */
function backstopMs(ctx: DoctorContext): number {
  return (ctx.settings.command_timeout_seconds + ctx.settings.probe_timeout_seconds) * 3 * 1000;
}

/** The title of a result id (`doctor.checks.<id>.title`); the id itself when there is none. */
export function checkTitle(ctx: DoctorContext, id: string): string {
  const key = `checks.${id}.title` as "checks.db.connect.title";
  return ctx.t.has(key) ? ctx.t(key) : id;
}

function complete(ctx: DoctorContext, outcome: CheckOutcome): CheckResult {
  return { ...outcome, title: outcome.title ?? checkTitle(ctx, outcome.id) };
}

async function runOne(ctx: DoctorContext, check: DoctorCheck): Promise<CheckResult[]> {
  const spec = { id: check.id, group: check.group, title: checkTitle(ctx, check.id) };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(ctx.t("common.timedOut"))), backstopMs(ctx));
    });
    const result = await Promise.race([check.run(ctx), timeout]);
    return (Array.isArray(result) ? result : [result]).map((outcome) => complete(ctx, outcome));
  } catch (error) {
    if (error instanceof SkipCheck) return [{ ...spec, status: "warn", detail: ctx.t("common.skipped", { reason: error.message }), hint: ctx.t("common.skippedHint") }];
    const message = redact(error instanceof Error ? error.message : String(error));
    return [{ ...spec, status: "fail", detail: ctx.t("common.checkError", { message }), hint: ctx.t("common.checkErrorHint") }];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const firstSegment = (id: string): string => id.split(".")[0] ?? id;

/** Check ids whose first segment (`compose` of `compose.db`) is one of the prefixes' first segments: the checks that can produce a result with such an id. */
export function selectChecks(prefixes: readonly string[], checks: readonly DoctorCheck[] = ALL_CHECKS): DoctorCheck[] {
  if (prefixes.length === 0) return [...checks];
  const wanted = new Set(prefixes.map(firstSegment));
  return checks.filter((check) => wanted.has(firstSegment(check.id)));
}

export interface RunDoctorOptions {
  /** Keep only results whose id starts with one of these (`compose`, `compose.db`, `tailscale`). */
  only?: readonly string[];
}

/** Run the checks (all of them in parallel; shared reads are cached) and fold the results into a report. Never throws. */
export async function runDoctor(ctx: DoctorContext, checks: readonly DoctorCheck[] = ALL_CHECKS, options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const only = options.only ?? [];
  const groups = await Promise.all(selectChecks(only, checks).map((check) => runOne(ctx, check)));
  const results = groups.flat().filter((result) => only.length === 0 || only.some((prefix) => result.id.startsWith(prefix)));
  const order = new Map(CHECK_GROUPS.map((group, index) => [group, index]));
  // stable sort: groups in display order, checks keep their order inside a group
  const sorted = results.map((result, index) => ({ result, index })).sort((a, b) => (order.get(a.result.group) ?? 0) - (order.get(b.result.group) ?? 0) || a.index - b.index).map((x) => x.result);
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const result of sorted) summary[result.status] += 1;
  const worst = worstOf(sorted.map((r) => r.status));
  return { generatedAt: ctx.now.toISOString(), locale: ctx.locale, worst, exitCode: EXIT_CODE[worst], summary, checks: sorted };
}
