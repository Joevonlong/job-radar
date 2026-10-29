import { useTranslations } from "next-intl";

import { Badge, SignalTag } from "@/components/ui/badge";
import { isGermanRequirement } from "@/lib/domain/types";

import { JobStatusChip } from "./status-chip";
import { TrapBadge } from "./trap-badge";
import { VisaBadge } from "./visa-badge";
import type { JobListItem, JobListSignal } from "./types";
import { useLocalLanguageName } from "@/components/base-currency";

/** Contract kinds that deserve a gate of their own (`permanent` is the default, `unknown` never gets one, C3). */
const CONTRACT_GATES = ["freelance", "student", "fixed_term"] as const;

/**
 * Signal tags and gates of a row (docs/design "信号 / 门槛"): one `[code | name]` tag per keyword category, in category order (the
 * amount category is the salary axis, it has no tag; tag categories are detail-page material), then the gates: the German requirement (red, "!"),
 * things to watch (dashed: agency, freelance, student, fixed-term), "closed?" (yellow) and "filtered" (ink, struck through).
 */
export function JobTags({ job }: { job: JobListItem }) {
  const t = useTranslations("dashboard");

  const tags = new Map<string, JobListSignal["category"]>();
  for (const signal of job.signals) if (signal.category.kind === "keyword" && !tags.has(signal.tier)) tags.set(signal.tier, signal.category);
  const contract = CONTRACT_GATES.find((kind) => kind === job.contract);
  const languageName = useLocalLanguageName();
  const filtered = job.rank?.filterResult === "filtered_out";

  return (
    <div className="jb-tags" data-slot="job-tags">
      {/* An AI trap comes first */}
      {job.trapCount && job.trapCount > 0 ? <TrapBadge count={job.trapCount} /> : null}
      {job.visa ? <VisaBadge visa={job.visa} /> : null}
      {job.relisted ? (
        <Badge variant="tag" data-testid="relisted-tag" title={`${t("relisted.title", { firstSeen: job.relisted.firstSeen, count: job.relisted.count })} · ${t("relisted.hint")}`}>
          {t("relisted.tag", { relative: job.relisted.relative })}
        </Badge>
      ) : null}
      {[...tags].map(([id, category]) => (
        <SignalTag key={id} code={category.code} icon={category.icon} color={category.color} title={category.label} data-tier={id}>
          {category.label}
        </SignalTag>
      ))}
      {languageName !== null && isGermanRequirement(job.germanLevelRequired) ? (
        <Badge variant="gate-bad" data-slot="gate" data-gate="german">
          <span aria-hidden>!</span> {t("badge.german", { level: job.germanLevelRequired, language: languageName })}
        </Badge>
      ) : null}
      {job.isAgency ? (
        <Badge variant="gate-note" data-slot="gate" data-gate="agency">
          {t("badge.agency")}
        </Badge>
      ) : null}
      {contract ? (
        <Badge variant="gate-note" data-slot="gate" data-gate={contract}>
          {t(`badge.${contract}`)}
        </Badge>
      ) : null}
      {job.jobStatus !== "active" ? <JobStatusChip status={job.jobStatus} reason={job.closedReason ?? null} evidence={job.closedEvidence ?? null} /> : null}
      {filtered ? (
        <Badge variant="gate-out" data-slot="gate" data-gate="filtered">
          {t("badge.filtered")}
        </Badge>
      ) : null}
    </div>
  );
}
