import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { loadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { annualSalaryLabel, listSalary, rowSalaryPercentile } from "@/lib/dashboard/salary";
import type { MonthSalaryFigure } from "@/lib/domain/salary";
import { buildSkillAliasMap, matchSkills, profileSkillKeys } from "@/lib/dashboard/skills";
import { pickListSummary } from "@/lib/dashboard/summary";
import type { JobCard } from "@/lib/db/queries/types";
import { distinctFamilies } from "@/lib/dashboard/apply";
import { isHighPayAmount, otherRegionOfAmount } from "@/lib/signals/bonus";
import { buildCatalog, toCategoryView } from "@/lib/signals/catalog";
import { isArchivedReason } from "@/lib/jobs/scope";
import { isNewSince } from "@/lib/jobs/visit";
import { loadBonusPolicy } from "@/lib/signals/floor";
import { loadTargetPlaces } from "@/lib/dashboard/target-places";
import { pickRowLocations } from "@/lib/dashboard/row-locations";
import { ghostEnabled } from "@/lib/ghost/settings";
import { GHOST_TOOLTIP_REASONS, ghostShortMessage } from "@/lib/ghost/view";
import { trapsEnabled } from "@/lib/traps/settings";
import { visaVisible } from "@/lib/visa/settings";

import type { JobListItem } from "./types";

/** Most locations a row lists, wanted cities first, then "+N" (the detail page shows all). */
const MAX_ROW_LOCATIONS = 3;

/**
 * Turn query cards into the serializable items the list components render. Done on the server so
 * relative times ("3 hours ago") are computed once and match between server HTML and hydration.
 */
export async function toListItems(
  cards: readonly JobCard[],
  options: {
    now: Date;
    timezone: string;
    seenUpTo?: Date | null;
    /** This month's stated salary figures (`listMonthSalaryFigures`) and `ui.yaml: salary_stats.min_sample`; without them no percentile is given. */
    monthSalaries?: { figures: readonly MonthSalaryFigure[]; minSample: number };
    /** `getFilterFloors`: the floor each filtered job was judged under, for the "below the floor of the time" wording. */
    filterFloors?: ReadonlyMap<number, number | null>;
    /** Whether the visa badge shows, when the page already knows (`visaVisible` / `visaFilterAvailable`); read here otherwise. */
    visa?: boolean;
    /** Whether the ghost job marks show (`ghostEnabled`), when the page already knows; read here otherwise. */
    ghost?: boolean;
  },
): Promise<JobListItem[]> {
  const interests = loadConfig("interests");
  const catalog = buildCatalog(interests);
  const policy = loadBonusPolicy(interests);
  // The axis and the percentile are in the market's base currency; without a market nothing is drawn on it
  const baseCurrency = policy.baseCurrency ?? "";
  const targetPlaces = loadTargetPlaces();
  const [format, locale, t, tGhost] = await Promise.all([getFormatter(), getLocale(), getTranslations("dashboard"), getTranslations("ghostJobs")]);
  const aliases = buildSkillAliasMap(loadPipeline().skills);
  const mySkills = profileSkillKeys(readProfileSkillNames(), aliases);
  const showTraps = trapsEnabled();
  const showVisa = options.visa ?? visaVisible();
  const showGhost = options.ghost ?? ghostEnabled();
  // the tooltip of the mark: its strongest reasons, short ("open 214 days · relisted under a new id")
  const ghostReasons = (top: NonNullable<JobCard["ghost"]>["top"]): string =>
    top
      .slice(0, GHOST_TOOLTIP_REASONS)
      .map((reason) => {
        const message = ghostShortMessage(reason);
        return tGhost(message.key, message.values);
      })
      .join(" · ");
  return cards.map((card) => {
    const salary = listSalary(card.salary, locale, baseCurrency);
    const matches = matchSkills(card.skills, mySkills, aliases);
    const rowLocations = pickRowLocations(card.locations, targetPlaces, MAX_ROW_LOCATIONS);
    const reference = card.postedAt ?? card.firstSeenAt;
    const relative = format.relativeTime(reference, options.now);
    const archived = isArchivedReason(card.closedReason);
    return {
      id: card.id,
      title: card.title,
      companyName: card.companyName,
      locations: rowLocations.shown,
      moreLocations: rowLocations.more,
      workplace: card.workplace,
      contract: card.contract,
      isAgency: card.isAgency,
      germanLevelRequired: card.germanLevelRequired,
      jobStatus: card.status,
      closedReason: card.closedReason,
      closedEvidence: card.linkCheck ? { httpStatus: card.linkCheck.httpStatus, quote: card.linkCheck.quote, url: card.linkCheck.url, at: card.linkCheck.at } : null,
      salaryDisclosed: card.salaryDisclosed,
      salaryText: annualSalaryLabel(card.salary, locale),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryOtherRegion: salary?.otherRegion ?? false,
      salaryApprox: salary?.approx ?? false,
      salaryFigure: salary?.figure ?? null,
      // the detail page's rule, the very same function (rowSalaryPercentile -> summarizeMonthSalaries)
      salaryPercentile: rowSalaryPercentile(card, options.monthSalaries ? { ...options.monthSalaries, currency: baseCurrency } : undefined),
      skills: matches.map((match) => match.name),
      skillHits: matches.filter((match) => match.have).map((match) => match.name),
      firstSeenHours: Math.max(0, (options.now.getTime() - card.firstSeenAt.getTime()) / 3_600_000),
      summary: pickListSummary(card.summary, locale),
      isNew: isNewSince(card.firstSeenAt, options.seenUpTo ?? null),
      seen: card.seen,
      families: distinctFamilies(card.sources),
      applicationStatus: card.applicationStatus,
      favorite: card.favorite !== null,
      favoriteNote: card.favorite?.note ?? null,
      ...(card.favorite
        ? {
            favoritedLabel: format.relativeTime(card.favorite.createdAt, options.now),
            favoritedTitle: format.dateTime(card.favorite.createdAt, { dateStyle: "medium", timeStyle: "short", timeZone: options.timezone }),
          }
        : {}),
      rank: card.rank,
      filterFloorEur: options.filterFloors?.get(card.id) ?? null,
      signals: card.signals
        .flatMap((s) => {
          const category = catalog.byId.get(s.tier);
          if (!category) return []; // a retired or unknown category: hidden
          const view = toCategoryView(category, locale);
          const isAmount = category.kind === "amount";
          return [
            {
              tier: s.tier,
              kind: s.kind,
              value: s.value,
              category: { kind: view.kind, label: view.label, icon: view.icon, color: view.color, code: view.code },
              belowFloor: isAmount && !isHighPayAmount(s.value, policy),
              otherRegion: isAmount && otherRegionOfAmount(s.value) !== null,
            },
          ];
        })
        .sort((a, b) => catalog.order(a.tier) - catalog.order(b.tier)),
      amountMinAnnualEur: policy.minAnnualEur,
      ...(showTraps && (card.traps?.traps ?? 0) > 0 ? { trapCount: card.traps?.traps ?? 0 } : {}),
      ...(showVisa && card.visa ? { visa: { status: card.visa.status, kind: card.visa.kind } } : {}),
      ...(showGhost && card.ghost ? { ghost: { level: card.ghost.level, score: card.ghost.score, reasons: ghostReasons(card.ghost.top) } } : {}),
      amountCurrency: baseCurrency,
      timeLabel: archived
        ? card.lastListedAt ? t("jobs.lastListed", { time: format.relativeTime(card.lastListedAt, options.now) }) : t("jobs.lastListedUnknown")
        : card.postedAt ? relative : t("time.seen", { time: relative }),
      timeTitle: format.dateTime(archived ? card.firstSeenAt : reference, { dateStyle: "medium", timeStyle: "short", timeZone: options.timezone }),
    };
  });
}

/** The skill names of me.yaml; none when the file cannot be read (the overlap then shows nothing matched, not an error). */
function readProfileSkillNames(): string[] {
  try {
    return loadConfig("me").skills.map((skill) => skill.name);
  } catch {
    return [];
  }
}
