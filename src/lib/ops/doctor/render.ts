import { CHECK_GROUPS, type CheckStatus, type DoctorReport, type DoctorTranslator } from "./types";

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

function stamp(iso: string, timeZone: string): string {
  try {
    const text = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    return `${text} ${timeZone}`;
  } catch {
    return iso;
  }
}

const VERDICT = { ok: "report.verdictOk", warn: "report.verdictWarn", fail: "report.verdictFail" } as const;

/** The human report: one section per group, one line per check, a fix hint under every warning and failure (in `t`'s language). */
export function renderText(report: DoctorReport, options: { timeZone: string; t: DoctorTranslator }): string {
  const { t } = options;
  const lines: string[] = [t("report.heading", { time: stamp(report.generatedAt, options.timeZone) }), ""];
  for (const group of CHECK_GROUPS) {
    const checks = report.checks.filter((c) => c.group === group);
    if (checks.length === 0) continue;
    lines.push(t(`groups.${group}`));
    for (const check of checks) {
      lines.push(`  ${ICON[check.status]} ${check.title} — ${check.detail}`);
      if (check.hint !== undefined) lines.push(`       ${t("report.whatToDo", { hint: check.hint })}`);
    }
    lines.push("");
  }
  const { ok, warn, fail } = report.summary;
  lines.push(t("report.total", { ok, warn, fail, verdict: t(VERDICT[report.worst]), code: report.exitCode }));
  return lines.join("\n");
}

export function renderJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
